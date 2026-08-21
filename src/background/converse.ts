/**
 * The open-ended conversation agent: talk to the page, not about a test.
 *
 * This is distinct from {@link driveWithModel} in the orchestrator, which exists
 * to verify a {@link TestCase} and must end with a verdict. The conversation agent
 * has no verdict: the user asks "analyse this page", "fill this form using my
 * details", or "scroll down and tell me what changed", and the model reads and
 * acts until it has answered. It can run as many rounds as the budget allows,
 * then stop by simply not calling a tool.
 *
 * It reuses the same machinery as the test agent — `dispatchTool`, `RefTable`,
 * `Recorder`, the tool schemas — because driving the page is driving the page
 * regardless of intent. What differs is the system prompt (advice, not verdict),
 * the stop condition (no more tool calls, not `finish`), and consent: a
 * conversational agent operates on the user's real, logged-in page, so actions
 * can be paused for approval depending on the chosen {@link ConfirmMode}.
 *
 * ## Why confirmation is a deferred promise
 *
 * The loop is synchronous from the model's perspective — one tool call at a time
 * — but consent is human. When an action needs approval the loop emits a
 * `pending` event and awaits a promise that the UI resolves with approve/decline.
 * This keeps the stream and the tool sequence alive without polling or
 * re-entering the model. Declining feeds a tool result back to the model ("the
 * user declined this") so it can adapt rather than silently stopping.
 *
 * @module background/converse
 */

import { streamCompletion, type StreamRequest, type WireMessage, type WireToolCall } from '../lib/llm'
import type { ConfirmMode, Skill, SkillField } from '../lib/types'
import type { ScriptStep } from '../lib/types'
import { LlmError } from '../lib/llm'
import {
  dispatchTool,
  parseToolArguments,
  RefTable,
  summarizeToolArgs,
  toolSchemas,
  type ToolOutcome,
} from './agent'
import { Recorder } from './recorder'
import type { Driver, RunContext } from './driver'

/** Which actions change the page and therefore need write-level consent. */
const MUTATING_TOOLS = new Set([
  'click',
  'fill',
  'select_option',
  'set_checkbox',
  'press_key',
  'open_url',
  'tab',
  'go_back',
])

/** Tools a conversation never needs: `finish` belongs to test runs. */
const HIDDEN_IN_CHAT = new Set(['finish', 'relocate', 'diagnose'])

export interface ConverseOptions {
  driver: Driver
  context: RunContext
  provider: { apiKey: string; baseUrl: string; model: string; label?: string; headers?: Record<string, string>; temperature?: number; maxTokens?: number }
  /** Skill explicitly selected for this turn, if any. */
  activeSkill?: Skill
  /** Other auto-matchable skills, advertised as a catalogue. */
  catalogue: Skill[]
  confirmMode: ConfirmMode
  secretNames: string[]
  /** Map of secret name -> value, substituted at the last moment before fill. */
  secretValues: Map<string, string>
  selfHeal: boolean
  maxRounds: number
  /** Allow-listed site glob patterns, surfaced in the system prompt. */
  allowedSites: string[]
  /** Page URL the conversation is pinned to; surfaced in the system prompt. */
  pageUrl: string
  pageTitle: string
  signal?: AbortSignal
  /**
   * Streaming function. Defaults to the real network call; injected by tests so
   * the loop can be driven by a scripted model without HTTP.
   */
  stream?: (request: StreamRequest, handlers: { onText: (delta: string) => void }) => Promise<{
    content: string
    toolCalls: WireToolCall[]
  }>
  /** Receives streamed assistant text. */
  onText?: (delta: string) => void
  /** Receives a status/phase line for the UI. */
  onStatus?: (text: string) => void
  /** Called when a tool call is about to run and may need approval. */
  onPending?: (action: PendingChatAction) => void
  /** Called once a tool call resolves, for the transcript. */
  onTool?: (event: ToolEvent) => void
}

/** A tool call awaiting consent, mirroring {@link PendingAction}. */
export interface PendingChatAction {
  id: string
  name: string
  argsSummary: string
  mutating: boolean
  /** Resolves the deferred consent; `true` runs the action, `false` declines. */
  decide: (approved: boolean) => void
}

/** What happened with one tool call, for the transcript. */
export interface ToolEvent {
  id: string
  name: string
  argsSummary: string
  ok: boolean
  resultPreview: string
  durationMs: number
  /** Set when the user declined rather than the tool failing. */
  declined?: boolean
}

export interface ConverseResult {
  /** Successful, effectful steps the model performed, in order. */
  steps: ScriptStep[]
  /**
   * The full wire transcript after this turn. The caller persists this so the
   * next turn has multi-turn context; without it every message would be treated
   * as the first.
   */
  messages: WireMessage[]
  stoppedBecause?: string
}

let pendingCounter = 0

/** Builds the system prompt for one conversational turn. */
export function chatSystemPrompt(options: {
  pageUrl: string
  pageTitle: string
  activeSkill?: Skill
  catalogue: Skill[]
  allowedSites: string[]
}): string {
  const parts: string[] = [
    `You are WebTest Pilot's conversational assistant, living in the browser's side panel.`,
    '',
    `The user is currently on: ${options.pageTitle} — ${options.pageUrl}`,
    '',
    'You can observe and operate the page to help. Unlike a test run, there is no pass/fail: answer the user, do the task, then stop.',
    '',
    'How to work:',
    '- Start with snapshot or read_page when you need to see the page. Never guess its contents.',
    '- If the page is not fully loaded or content is below the fold, scroll (or click a "load more") and snapshot again before concluding. A partial page is the most common reason for a wrong answer.',
    '- Use the page tools (click, fill, select_option, set_checkbox, press_key, scroll, hover, wait_for, assert, extract) to actually do what the user asks, not just describe how.',
    '- When filling a form, use any data the active skill provides (listed below). For a credential, call fill with secretRef set to the exact secret name; never invent a value.',
    '- Answer in the language the user writes in. Be concise.',
    '- Stop when the task is done — simply give your final answer with no tool call. Do not keep acting once you have the answer.',
    '',
    `You may only touch these sites: ${
      options.allowedSites.length > 0 ? options.allowedSites.join(', ') : '(none configured — every page action will fail)'
    }.`,
  ]

  if (options.activeSkill) {
    parts.push(
      '',
      `Active skill: ${options.activeSkill.name}`,
      options.activeSkill.description,
      options.activeSkill.instructions,
      renderSkillFields(options.activeSkill.fields),
    )
  } else if (options.catalogue.length > 0) {
    parts.push(
      '',
      'Available skills (call use_skill by exact name to load one):',
      ...options.catalogue
        .filter((skill) => skill.autoMatch)
        .map((skill) => `- ${skill.name}: ${skill.description}`),
    )
  }

  return parts.join('\n')
}

/** Renders a skill's fillable fields for the prompt, names only. */
function renderSkillFields(fields: SkillField[]): string {
  if (fields.length === 0) return ''
  const lines = fields.map((field) => {
    const source = field.secretRef ? `secret "${field.secretRef}"` : `value "${field.value ?? ''}"`
    return `- Field matching "${field.label}": fill with ${source}.`
  })
  return ['Fields this skill provides:', ...lines].join('\n')
}

/**
 * Runs one conversational turn: sends the user message plus history, streams the
 * reply, and executes/approves tool calls until the model stops.
 */
export async function converse(
  history: WireMessage[],
  userMessage: string,
  options: ConverseOptions,
): Promise<ConverseResult> {
  const refs = new RefTable()
  const recorder = new Recorder()
  const systemPrompt = chatSystemPrompt({
    pageUrl: options.pageUrl,
    pageTitle: options.pageTitle,
    activeSkill: options.activeSkill,
    catalogue: options.catalogue,
    allowedSites: options.allowedSites,
  })
  // The system prompt always leads. Existing history (from prior turns) already
  // carries its own leading system prompt, so when this is a continuing
  // conversation we replace that stale one rather than stacking two.
  const prior = history.length > 0 && history[0]?.role === 'system' ? history.slice(1) : history
  const messages: WireMessage[] = [
    { role: 'system', content: systemPrompt },
    ...prior,
    { role: 'user', content: userMessage },
  ]

  const tools = toolSchemas({ selfHeal: options.selfHeal, secretNames: options.secretNames }).filter(
    (tool) => !HIDDEN_IN_CHAT.has(tool.function.name),
  )
  // The conversation uses a use_skill tool like browser-copilot.
  tools.push(useSkillSchema())

  const deadline = Date.now() + 120_000
  let stoppedBecause: string | undefined

  for (let round = 0; round < options.maxRounds; round += 1) {
    if (options.signal?.aborted) {
      stoppedBecause = '已取消。'
      break
    }
    if (Date.now() > deadline) {
      stoppedBecause = '本轮对话超过了 2 分钟的时间预算。'
      break
    }

    let text = ''
    let toolCalls: WireToolCall[] = []
    options.onStatus?.(round === 0 ? '正在思考…' : `正在继续（第 ${round + 1} 轮）…`)
    const stream = options.stream ?? streamCompletion
    try {
      const completion = await stream(
        {
          apiKey: options.provider.apiKey,
          baseUrl: options.provider.baseUrl,
          model: options.provider.model,
          messages,
          tools,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.provider.label ? { providerLabel: options.provider.label } : {}),
          ...(options.provider.headers ? { headers: options.provider.headers } : {}),
          ...(options.provider.temperature !== undefined
            ? { temperature: options.provider.temperature }
            : {}),
          ...(options.provider.maxTokens !== undefined ? { maxTokens: options.provider.maxTokens } : {}),
        },
        {
          onText: (delta: string) => {
            text += delta
            options.onText?.(delta)
          },
        },
      )
      toolCalls = completion.toolCalls
      if (completion.content) text = completion.content
    } catch (error) {
      if (error instanceof LlmError) throw new Error(`模型调用失败：${error.message}`)
      throw error
    }

    messages.push({
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })

    // No tool call: the model gave its final answer. This is the normal stop for
    // a conversation, unlike a test run which must call finish.
    if (toolCalls.length === 0) break

    for (const call of toolCalls) {
      if (options.signal?.aborted) break
      const startedAt = Date.now()
      const name = call.function.name
      const args = parseToolArguments(call.function.arguments)
      const argsSummary = summarizeToolArgs(name, args)

      if (name === 'use_skill') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: 'Skills are selected from the panel before sending a message; the catalogue is for reference only.',
        })
        continue
      }

      const mutating = MUTATING_TOOLS.has(name)
      const needsConsent =
        options.confirmMode === 'always' || (options.confirmMode === 'write' && mutating)

      let approved = true
      if (needsConsent && options.onPending) {
        approved = await askApproval(options, {
          id: `pending-${(pendingCounter += 1)}`,
          name,
          argsSummary,
          mutating,
        })
      }

      if (!approved) {
        options.onTool?.({
          id: call.id,
          name,
          argsSummary,
          ok: false,
          resultPreview: '用户拒绝了此操作。',
          durationMs: Date.now() - startedAt,
          declined: true,
        })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: 'The user declined this action. Ask what they would prefer instead.',
        })
        continue
      }

      options.onStatus?.(`${name} ${argsSummary}`)
      let outcome: ToolOutcome
      try {
        outcome = await dispatchTool(call, {
          driver: options.driver,
          context: options.context,
          refs,
          stepTimeoutMs: 10_000,
          secretNames: options.secretNames,
        })
      } catch (error) {
        // Allow-list violations and other hard stops surface as tool errors the
        // model can read, matching the test agent.
        const message = error instanceof Error ? error.message : String(error)
        options.onTool?.({
          id: call.id,
          name,
          argsSummary,
          ok: false,
          resultPreview: message,
          durationMs: Date.now() - startedAt,
        })
        messages.push({ role: 'tool', tool_call_id: call.id, content: message })
        continue
      }

      // The real secret is substituted after dispatch, at the last moment, so it
      // never enters the model transcript. dispatchTool only records the ref.
      if (outcome.recorded?.secretRef) {
        const value = options.secretValues.get(outcome.recorded.secretRef)
        if (value !== undefined && outcome.recorded.target) {
          await options.driver.exec(options.context, {
            action: 'fill',
            target: outcome.recorded.target,
            value,
          })
        }
      }

      if (outcome.recorded) recorder.add(outcome.recorded)
      options.onTool?.({
        id: call.id,
        name,
        argsSummary,
        ok: true,
        resultPreview: outcome.content.slice(0, 400),
        durationMs: Date.now() - startedAt,
      })
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.content })
    }
  }

  return { steps: recorder.steps(), messages, stoppedBecause }
}

/** Wraps the consent callback in a promise the loop can await. */
function askApproval(options: ConverseOptions, action: Omit<PendingChatAction, 'decide'>): Promise<boolean> {
  return new Promise((resolve) => {
    options.onPending?.({ ...action, decide: resolve })
  })
}

/** Schema for the `use_skill` tool; mirrors browser-copilot. */
function useSkillSchema() {
  return {
    type: 'function' as const,
    function: {
      name: 'use_skill',
      description:
        'Load a saved skill by name. In this panel skills are chosen before sending, so calling this is informational only.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact skill name.' },
        },
        required: ['name'],
      },
    },
  }
}
