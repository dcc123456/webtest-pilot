/**
 * The tool surface the model drives, and the loop that runs it.
 *
 * Four decisions here matter more than the code:
 *
 * 1. **The model never sees a selector it invented working.** It picks elements by
 *    `ref` from a snapshot, and the *snapshot* — computed in-page while the
 *    element was in hand — supplies the durable selector chain. A model asked to
 *    write CSS produces selectors that work once and break on the next release.
 *
 * 2. **The allow-list is checked in the driver, not here.** Tool arguments are
 *    model output and therefore untrusted; putting the check at the boundary that
 *    actually touches the page means no tool can forget it.
 *
 * 3. **Passing is a tool call, not a sentence.** `finish` requires the model to
 *    state a verdict, and the orchestrator only accepts `passed` if the
 *    expectations were actually asserted. Otherwise a plausible-sounding summary
 *    becomes a green test.
 *
 * 4. **Secrets are named, never passed.** `fill` takes `secretRef`, and the value
 *    is substituted in the worker. The model cannot exfiltrate what it never saw.
 *
 * @module background/agent
 */

import type { WireMessage, WireTool, WireToolCall } from '../lib/llm'
import type { Op, PageSnapshot, SnapshotElement, ExtractWhat } from '../lib/ops'
import type { Target } from '../lib/selectors'
import { describeTarget } from '../lib/selectors'
import type { ActionName } from '../lib/ops'
import { NotAllowedError, type Driver, type RunContext } from './driver'
import type { RecordedAction } from './recorder'

/** Names the model calls. Kept short: every token is paid for on each round. */
export const TOOL_NAMES = [
  'snapshot',
  'read_page',
  'open_url',
  'click',
  'fill',
  'select_option',
  'set_checkbox',
  'press_key',
  'hover',
  'scroll',
  'wait_for',
  'assert',
  'extract',
  'screenshot',
  'tab',
  'finish',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

/** The verdict a run ends with. */
export interface Verdict {
  status: 'passed' | 'failed'
  summary: string
  /** Which expectations the model claims to have verified. */
  verified: string[]
  /** What went wrong, when failed. */
  problem?: string
}

/** Outcome of dispatching one tool call. */
export interface ToolOutcome {
  /** Text handed back to the model as the tool result. */
  content: string
  /** Set when the model called `finish`. */
  verdict?: Verdict
  /** Recorded for the script, when the action was effectful and succeeded. */
  recorded?: RecordedAction
  /** True when an assertion tool ran and passed, tracked for verdict checking. */
  assertionPassed?: string
  /** A screenshot the caller should persist and attach to the transcript. */
  screenshotDataUrl?: string
}

/**
 * JSON Schema for the tool set.
 *
 * Descriptions are written for the model, not for a human reader: each one states
 * the *precondition* the model most often gets wrong, because that is cheaper
 * than correcting it after a failed call.
 */
export function toolSchemas(options: { selfHeal: boolean; secretNames: string[] }): WireTool[] {
  const refProperty = {
    type: 'string',
    description:
      'The ref of the element, exactly as printed by snapshot (e.g. "e12"). Call snapshot first; refs change after every navigation.',
  } as const

  const tools: WireTool[] = [
    {
      type: 'function',
      function: {
        name: 'snapshot',
        description:
          'List the interactive elements on the page with a ref for each, plus the forms and a text excerpt. Call this before your first interaction and again after any navigation or content change — refs from an earlier snapshot are stale.',
        parameters: {
          type: 'object',
          properties: {
            maxElements: {
              type: 'number',
              description: 'Cap on elements returned. Default 120. Raise only if the page is large.',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_page',
        description:
          'Read the visible text of the page. Use this to check content, not to find elements — use snapshot for elements.',
        parameters: {
          type: 'object',
          properties: {
            maxChars: { type: 'number', description: 'Cap on characters. Default 8000.' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'open_url',
        description:
          'Navigate the current tab to an http(s) URL. Only sites on the allow-list can be opened; anything else fails.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Absolute http(s) URL.' } },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'click',
        description:
          'Click an element. Fails if the element is disabled, hidden, or covered — that is a finding, not something to work around.',
        parameters: {
          type: 'object',
          properties: { ref: refProperty },
          required: ['ref'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fill',
        description:
          'Type into a text input, textarea, or contenteditable. Replaces the existing value. For a password or any credential, pass secretRef instead of value.',
        parameters: {
          type: 'object',
          properties: {
            ref: refProperty,
            value: { type: 'string', description: 'Literal text. Never put a credential here.' },
            secretRef: {
              type: 'string',
              description:
                options.secretNames.length > 0
                  ? `Name of a stored secret to type. Available: ${options.secretNames.join(', ')}.`
                  : 'Name of a stored secret. None are configured, so this will fail.',
            },
          },
          required: ['ref'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'select_option',
        description: 'Choose an option in a <select>, by its value or its visible label.',
        parameters: {
          type: 'object',
          properties: {
            ref: refProperty,
            value: { type: 'string', description: 'Option value or visible label.' },
          },
          required: ['ref', 'value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_checkbox',
        description:
          'Check or uncheck a checkbox, or select a radio button. Idempotent: setting an already-correct state succeeds without clicking.',
        parameters: {
          type: 'object',
          properties: { ref: refProperty, checked: { type: 'boolean' } },
          required: ['ref', 'checked'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'press_key',
        description:
          'Press a key, optionally focused on an element first. Enter inside a form submits it.',
        parameters: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'Key name: Enter, Escape, Tab, ArrowDown, Backspace, or a single character.',
            },
            ref: { type: 'string', description: 'Optional element to focus first.' },
          },
          required: ['key'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'hover',
        description: 'Hover an element, to open a menu or reveal a tooltip.',
        parameters: {
          type: 'object',
          properties: { ref: refProperty },
          required: ['ref'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'scroll',
        description: 'Scroll the page, or scroll an element into view.',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['into_view', 'top', 'bottom', 'by'] },
            ref: { type: 'string', description: 'Required for into_view.' },
            y: { type: 'number', description: 'Pixels, for mode "by". Positive scrolls down.' },
          },
          required: ['mode'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wait_for',
        description:
          'Wait until an element becomes visible. Use this after an action that loads content, instead of taking another snapshot immediately.',
        parameters: {
          type: 'object',
          properties: {
            ref: refProperty,
            timeoutMs: { type: 'number', description: 'Default 10000.' },
          },
          required: ['ref'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'assert',
        description:
          'Check a condition and record the result as part of the test. Every expectation in the test case must be checked with this tool — reading the page and concluding it looks right does not count.',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: [
                'text',
                'visible',
                'hidden',
                'value',
                'url',
                'title',
                'attr',
                'count',
                'enabled',
                'checked',
              ],
            },
            expected: {
              type: 'string',
              description:
                'The expected value. For text/url/title this is a substring; for count a number; ignored for visible/hidden/enabled/checked.',
            },
            ref: {
              type: 'string',
              description: 'Element to check. Omit for url and title.',
            },
            attr: { type: 'string', description: 'Attribute name, for kind "attr".' },
            negate: { type: 'boolean', description: 'Assert the opposite.' },
          },
          required: ['kind'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'extract',
        description: 'Pull text, a value, an attribute, or a table out of the page.',
        parameters: {
          type: 'object',
          properties: {
            ref: refProperty,
            what: { type: 'string', enum: ['text', 'value', 'attr', 'html', 'table'] },
            attr: { type: 'string', description: 'Attribute name, for what "attr".' },
            saveAs: { type: 'string', description: 'Name to store the result under.' },
          },
          required: ['ref', 'what'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'screenshot',
        description:
          'Capture the visible area, or one element. Use it to record evidence at a decisive moment, not routinely.',
        parameters: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Optional element to crop to.' },
            note: { type: 'string', description: 'Why this shot matters.' },
            keep: {
              type: 'boolean',
              description:
                'True to make this screenshot a step of the saved script, so every future replay captures it at this point. Default false: the shot still appears in this run report, but does not become part of the test.',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'tab',
        description: 'Manage tabs: open a new one, switch by index, close by index, or go back.',
        parameters: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['new', 'switch', 'close', 'list', 'back'] },
            url: { type: 'string', description: 'For op "new".' },
            index: { type: 'number', description: 'For op "switch" and "close", zero-based.' },
          },
          required: ['op'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finish',
        description:
          'End the test with a verdict. Call this exactly once, as your last action. Report failed when any expectation does not hold — a failing test that is reported honestly is the point of this tool.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['passed', 'failed'] },
            summary: {
              type: 'string',
              description: 'One or two sentences on what happened, for the person reading the report.',
            },
            verified: {
              type: 'array',
              items: { type: 'string' },
              description: 'The expectations you checked with assert, quoted from the test case.',
            },
            problem: {
              type: 'string',
              description: 'For failed: what did not hold, and the observed value.',
            },
          },
          required: ['status', 'summary'],
        },
      },
    },
  ]

  if (options.selfHeal) {
    tools.push({
      type: 'function',
      function: {
        name: 'relocate',
        description:
          'Only for replaying a saved script whose selector no longer matches: propose the ref of the element that step meant. Your proposal is recorded for a human to confirm; it does not change the saved script.',
        parameters: {
          type: 'object',
          properties: {
            ref: refProperty,
            because: { type: 'string', description: 'Why this is the same element.' },
          },
          required: ['ref', 'because'],
        },
      },
    })
  }

  return tools
}

/**
 * The system prompt.
 *
 * Written to counter the two failure modes a browser-driving model actually has:
 * declaring success without checking, and inventing a selector when the snapshot
 * does not contain what it hoped for.
 */
export function systemPrompt(options: {
  allowedSites: string[]
  secretNames: string[]
  maxRounds: number
}): string {
  return [
    'You are a web test executor. You drive a real browser through tools to carry out a test case, then report an honest verdict.',
    '',
    'How to work:',
    '- Call snapshot first. It gives every interactive element a ref. Refer to elements only by those refs.',
    '- Refs go stale after a navigation or a content change. Take a new snapshot rather than reusing an old ref.',
    '- Do one thing per tool call and read the result before deciding the next step.',
    '- After an action that loads content, use wait_for on something the new content contains.',
    '',
    'What counts as a pass:',
    '- Every expectation in the test case must be checked with the assert tool. Reading the page and judging that it looks correct is not a check.',
    '- If an expectation does not hold, call finish with status "failed" and say what you observed. Finding a real bug is a success for you, not a failure.',
    '- If you cannot complete a step at all — an element is missing, a control is disabled, the site refuses — report failed and explain. Do not invent a way around it.',
    '',
    'Screenshots:',
    '- A failing step is captured automatically. Do not take a screenshot just to look at the page — snapshot is cheaper and tells you more.',
    '- Call screenshot when a human reviewing the report would need to see the pixels: a rendering bug, a chart, a visual state no assertion can express.',
    '- Set keep: true only when the shot belongs in the saved script, so every future replay captures it at that same point. Leave it out for a one-off diagnostic.',
    '',
    'Limits you cannot cross:',
    `- You may only touch these sites: ${
      options.allowedSites.length > 0 ? options.allowedSites.join(', ') : '(none configured — every page action will fail)'
    }.`,
    options.secretNames.length > 0
      ? `- For credentials, call fill with secretRef set to one of: ${options.secretNames.join(', ')}. You will never see the value, and you must not ask for it.`
      : '- No secrets are configured. If the test needs a password, report failed and say which secret name is missing.',
    `- You have at most ${options.maxRounds} tool rounds. Spend them on the test, not on repeated snapshots.`,
    '',
    'End by calling finish exactly once.',
  ].join('\n')
}

/**
 * Renders a snapshot for the model.
 *
 * A compact line-per-element table rather than JSON: it costs roughly a third of
 * the tokens for the same information, and tokens per round are the binding
 * constraint on how long a test can run.
 */
export function renderSnapshot(page: PageSnapshot): string {
  const lines: string[] = [`URL: ${page.url}`, `Title: ${page.title}`]

  if (page.elements.length === 0) {
    lines.push('', 'No interactive elements found. The page may still be loading.')
  } else {
    lines.push('', 'Elements:')
    for (const element of page.elements) {
      lines.push(`  ${element.ref}  ${describeElement(element)}`)
    }
    if (page.elementsTruncated) {
      lines.push(`  … more elements exist; raise maxElements or scroll if what you need is missing.`)
    }
  }

  if (page.forms.length > 0) {
    lines.push('', 'Forms:')
    for (const form of page.forms) {
      lines.push(`  form ${form.name || '(unnamed)'}:`)
      for (const field of form.fields) {
        const bits = [`${field.ref} ${field.label || field.tag}`]
        if (field.type) bits.push(field.type)
        if (field.required) bits.push('required')
        if (field.options?.length) bits.push(`options: ${field.options.join(' | ')}`)
        lines.push(`    - ${bits.join(', ')}`)
      }
    }
  }

  if (page.text.trim()) {
    lines.push('', 'Text excerpt:', page.text.trim())
    if (page.truncated) lines.push('… (truncated)')
  }
  return lines.join('\n')
}

function describeElement(element: SnapshotElement): string {
  const bits: string[] = [element.role || element.tag]
  if (element.name) bits.push(`"${element.name}"`)
  if (element.type && element.type !== 'text') bits.push(element.type)
  if (element.placeholder && !element.name) bits.push(`placeholder="${element.placeholder}"`)
  if (element.disabled) bits.push('disabled')
  if (element.checked !== undefined) bits.push(element.checked ? 'checked' : 'unchecked')
  if (element.href) bits.push(`→ ${element.href}`)
  if (element.inViewport === false) bits.push('off-screen')
  return bits.join(' ')
}

/** Parses a tool call's JSON arguments, tolerating the ways models get it wrong. */
export function parseToolArguments(raw: string): Record<string, unknown> {
  const text = raw.trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    // Some models emit the object wrapped in a fenced block, or with a trailing
    // comma. Recovering is cheaper than spending a round on a reprimand.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
    const candidate = (fenced?.[1] ?? text).replace(/,\s*([}\]])/g, '$1').trim()
    try {
      const parsed = JSON.parse(candidate)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
}

/** Holds the current snapshot so refs can be resolved to durable targets. */
export class RefTable {
  private table = new Map<string, { target: Target; label: string }>()

  /** Replaces the table from a fresh snapshot. */
  update(page: PageSnapshot): void {
    this.table = new Map(
      page.elements.map((element) => [
        element.ref,
        {
          target: element.target,
          label: element.name || element.role || element.tag,
        },
      ]),
    )
  }

  get(ref: string): { target: Target; label: string } | undefined {
    return this.table.get(ref)
  }

  get size(): number {
    return this.table.size
  }

  /** Every known ref, for an error message that helps rather than scolds. */
  refs(): string[] {
    return [...this.table.keys()]
  }
}

/** What the dispatcher needs to carry out a call. */
export interface DispatchDeps {
  driver: Driver
  context: RunContext
  refs: RefTable
  stepTimeoutMs: number
  secretNames: string[]
  /** Records extracted values for the run result. */
  onExtract?: (name: string, value: unknown) => void
}

/**
 * Executes one tool call and renders the result as text for the model.
 *
 * Errors become tool results rather than exceptions: a model that gets
 * "that ref is stale, take a new snapshot" recovers in one round, whereas a
 * thrown error ends the run. The only exception is a policy violation, which must
 * stop the run rather than invite a retry.
 */
export async function dispatchTool(
  call: WireToolCall,
  deps: DispatchDeps,
): Promise<ToolOutcome> {
  const name = call.function.name as ToolName | 'relocate'
  const args = parseToolArguments(call.function.arguments)

  /** Resolves a ref, or explains precisely how to recover. */
  const resolve = (ref: unknown): { target: Target; label: string } => {
    if (typeof ref !== 'string' || !ref) {
      throw new ToolInputError('This tool needs a "ref" from the most recent snapshot.')
    }
    const found = deps.refs.get(ref)
    if (!found) {
      throw new ToolInputError(
        deps.refs.size === 0
          ? `Unknown ref "${ref}": no snapshot has been taken yet. Call snapshot first.`
          : `Unknown ref "${ref}". The page may have changed since the last snapshot — call snapshot again. Known refs: ${deps.refs
              .refs()
              .slice(0, 20)
              .join(', ')}${deps.refs.size > 20 ? ', …' : ''}.`,
      )
    }
    return found
  }

  try {
    switch (name) {
      case 'snapshot': {
        const maxElements = numberArg(args.maxElements, 120)
        const page = await deps.driver.snapshot(deps.context, 8000, maxElements)
        deps.refs.update(page)
        return { content: renderSnapshot(page) }
      }

      case 'read_page': {
        const page = await deps.driver.snapshot(deps.context, numberArg(args.maxChars, 8000), 0)
        return {
          content: [
            `URL: ${page.url}`,
            `Title: ${page.title}`,
            '',
            page.text.trim() || '(the page has no visible text)',
            page.truncated ? '… (truncated)' : '',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      }

      case 'open_url': {
        const url = stringArg(args.url)
        if (!url) throw new ToolInputError('open_url needs a "url".')
        const tab = await deps.driver.navigate(deps.context, url)
        // The old refs describe the previous document.
        deps.refs.update(await deps.driver.snapshot(deps.context, 0, 0))
        return {
          content: `Opened ${tab.url} (title: "${tab.title}"). Take a snapshot before interacting.`,
          recorded: { action: 'open_url', value: url, ok: true },
        }
      }

      case 'click':
      case 'hover': {
        const { target, label } = resolve(args.ref)
        const result = await deps.driver.exec(deps.context, {
          action: name as ActionName,
          target,
        })
        if (!result.ok) {
          return { content: `Could not ${name} ${label}: ${result.error ?? 'unknown reason'}` }
        }
        const note = result.mayNavigate
          ? ' The page may be navigating; wait for something on the new content and take a fresh snapshot.'
          : ''
        return {
          content: `${name === 'click' ? 'Clicked' : 'Hovered'} ${label}.${note}`,
          recorded: { action: name as ActionName, target, ok: true },
        }
      }

      case 'fill': {
        const { target, label } = resolve(args.ref)
        const secretRef = stringArg(args.secretRef)
        let value: string
        if (secretRef) {
          if (!deps.secretNames.includes(secretRef)) {
            throw new ToolInputError(
              `No secret named "${secretRef}" is configured. Available: ${
                deps.secretNames.join(', ') || '(none)'
              }.`,
            )
          }
          // The dispatcher does not resolve the value: only the runner layer,
          // which owns the store, ever holds it. Here it is a placeholder the
          // caller replaces, keeping the value out of the transcript entirely.
          value = SECRET_PLACEHOLDER
        } else {
          value = stringArg(args.value) ?? ''
        }

        const result = await deps.driver.exec(deps.context, {
          action: 'fill',
          target,
          value,
          ...(secretRef ? { secretRef } : {}),
        })
        if (!result.ok) {
          return { content: `Could not fill ${label}: ${result.error ?? 'unknown reason'}` }
        }
        const shown = secretRef ? `the "${secretRef}" secret` : `"${value}"`
        const recorded: RecordedAction = { action: 'fill', target, ok: true }
        if (secretRef) recorded.secretRef = secretRef
        else recorded.value = value
        return { content: `Filled ${label} with ${shown}.`, recorded }
      }

      case 'select_option': {
        const { target, label } = resolve(args.ref)
        const value = stringArg(args.value)
        if (value === undefined) throw new ToolInputError('select_option needs a "value".')
        const result = await deps.driver.exec(deps.context, {
          action: 'select_option',
          target,
          value,
        })
        if (!result.ok) {
          return { content: `Could not select in ${label}: ${result.error ?? 'unknown reason'}` }
        }
        return {
          content: `Selected "${value}" in ${label}.`,
          recorded: { action: 'select_option', target, value, ok: true },
        }
      }

      case 'set_checkbox': {
        const { target, label } = resolve(args.ref)
        const checked = args.checked !== false
        const result = await deps.driver.exec(deps.context, {
          action: 'set_checkbox',
          target,
          value: checked,
        })
        if (!result.ok) {
          return { content: `Could not set ${label}: ${result.error ?? 'unknown reason'}` }
        }
        return {
          content: `${checked ? 'Checked' : 'Unchecked'} ${label}.${result.note ? ` (${result.note})` : ''}`,
          recorded: { action: 'set_checkbox', target, value: checked, ok: true },
        }
      }

      case 'press_key': {
        const key = stringArg(args.key)
        if (!key) throw new ToolInputError('press_key needs a "key".')
        const resolved = args.ref !== undefined ? resolve(args.ref) : undefined
        const op: Op = { action: 'press_key', value: key }
        if (resolved) op.target = resolved.target
        const result = await deps.driver.exec(deps.context, op)
        if (!result.ok) {
          return { content: `Could not press ${key}: ${result.error ?? 'unknown reason'}` }
        }
        const note = result.mayNavigate ? ' The form was submitted; the page may be navigating.' : ''
        const recorded: RecordedAction = { action: 'press_key', value: key, ok: true }
        if (resolved) recorded.target = resolved.target
        return { content: `Pressed ${key}.${note}`, recorded }
      }

      case 'scroll': {
        const mode = (stringArg(args.mode) ?? 'into_view') as 'into_view' | 'top' | 'bottom' | 'by'
        const op: Op = { action: 'scroll', scroll: { mode } }
        if (mode === 'by') op.scroll = { mode, y: numberArg(args.y, 600) }
        let label = 'the page'
        if (mode === 'into_view') {
          const resolved = resolve(args.ref)
          op.target = resolved.target
          label = resolved.label
        }
        const result = await deps.driver.exec(deps.context, op)
        if (!result.ok) {
          return { content: `Could not scroll: ${result.error ?? 'unknown reason'}` }
        }
        return {
          content:
            mode === 'into_view'
              ? `Scrolled ${label} into view.`
              : `Scrolled ${label} ${mode === 'by' ? `by ${numberArg(args.y, 600)}px` : `to the ${mode}`}. Take a new snapshot to see what is now visible.`,
          recorded: { action: 'scroll', ...(op.target ? { target: op.target } : {}), scroll: op.scroll, ok: true },
        }
      }

      case 'wait_for': {
        const { target, label } = resolve(args.ref)
        const timeoutMs = numberArg(args.timeoutMs, deps.stepTimeoutMs)
        const result = await deps.driver.waitFor(deps.context, { action: 'wait_for', target }, timeoutMs)
        if (!result.ok) {
          return {
            content: `${label} did not become visible within ${Math.round(timeoutMs / 1000)}s: ${
              result.error ?? 'still not visible'
            }`,
          }
        }
        return {
          content: `${label} is visible.`,
          recorded: { action: 'wait_for', target, ok: true },
        }
      }

      case 'assert': {
        const kind = stringArg(args.kind)
        if (!kind) throw new ToolInputError('assert needs a "kind".')
        const expected = stringArg(args.expected) ?? ''
        const needsTarget = kind !== 'url' && kind !== 'title'
        const resolved = needsTarget ? resolve(args.ref) : undefined
        const op: Op = {
          action: 'assert',
          assert: {
            kind: kind as NonNullable<Op['assert']>['kind'],
            expected,
            ...(stringArg(args.attr) ? { attr: stringArg(args.attr) as string } : {}),
            ...(args.negate === true ? { negate: true } : {}),
          },
        }
        if (resolved) op.target = resolved.target

        const result = await deps.driver.waitFor(deps.context, op, deps.stepTimeoutMs)
        const where = resolved ? resolved.label : 'the page'
        const description = `${where} ${kind}${expected ? ` "${expected}"` : ''}`
        if (result.ok) {
          return {
            content: `ASSERTION PASSED: ${description}.`,
            assertionPassed: description,
            recorded: {
              action: 'assert',
              ...(op.target ? { target: op.target } : {}),
              assert: op.assert,
              ok: true,
            },
          }
        }
        // Reported as a plain result, not an error: the model must decide whether
        // this is the bug it was looking for or a mistake in its own approach.
        return {
          content: `ASSERTION FAILED: ${description}. ${
            result.assertion ? `Observed: "${result.assertion.actual}".` : (result.error ?? '')
          } If this is what the test case expected to hold, the test has failed — report it with finish.`,
        }
      }

      case 'extract': {
        const { target, label } = resolve(args.ref)
        const what = (stringArg(args.what) ?? 'text') as 'text' | 'value' | 'attr' | 'html' | 'table'
        const attr = stringArg(args.attr)
        if (what === 'attr' && !attr) {
          throw new ToolInputError('extract with what "attr" also needs "attr" — the attribute name.')
        }
        const extract: ExtractWhat =
          what === 'attr' ? { kind: 'attr', attr: attr as string } : { kind: what }
        const result = await deps.driver.exec(deps.context, {
          action: 'extract',
          target,
          extract,
        })
        if (!result.ok || !result.extracted) {
          return { content: `Could not extract from ${label}: ${result.error ?? 'nothing returned'}` }
        }
        const saveAs = stringArg(args.saveAs)
        if (saveAs) deps.onExtract?.(saveAs, result.extracted)
        const rendered =
          result.extracted.kind === 'table'
            ? [result.extracted.headers.join(' | '), ...result.extracted.rows.map((row) => row.join(' | '))].join('\n')
            : result.extracted.values.join('\n')
        return {
          content: `Extracted from ${label}:\n${rendered || '(empty)'}`,
          recorded: {
            action: 'extract',
            target,
            extract,
            ...(saveAs ? { saveAs } : {}),
            ok: true,
          },
        }
      }

      case 'screenshot': {
        const resolved = args.ref !== undefined ? resolve(args.ref) : undefined
        let crop: { x: number; y: number; width: number; height: number; dpr?: number } | undefined
        if (resolved) {
          const probe = await deps.driver.exec(deps.context, {
            action: 'screenshot',
            target: resolved.target,
          })
          if (probe.rect) {
            crop = { ...probe.rect, ...(probe.dpr ? { dpr: probe.dpr } : {}) }
          }
        }
        const shot = await deps.driver.screenshot(deps.context, crop)
        const note = stringArg(args.note)
        // Only a shot the model marks `keep` becomes a script step. Recording every
        // diagnostic screenshot would make each replay slower and the artifact
        // budget fill with frames nobody asked for.
        const keep = boolArg(args.keep)
        return {
          content: `Captured a ${shot.width}×${shot.height} screenshot${
            resolved ? ` of ${resolved.label}` : ' of the visible area'
          }. It is attached to the run report${note ? ` with the note: ${note}` : ''}${
            keep ? ' and will be captured again on every replay' : ''
          }.`,
          screenshotDataUrl: shot.dataUrl,
          recorded: {
            action: 'screenshot',
            ...(resolved ? { target: resolved.target } : {}),
            ...(note ? { note } : {}),
            ok: true,
            keep,
          },
        }
      }

      case 'tab': {
        const op = stringArg(args.op) ?? 'list'
        if (op === 'list') {
          const tabs = await deps.driver.listTabs(deps.context)
          return {
            content: tabs
              .map((tab, index) => `${index}: ${tab.active ? '* ' : '  '}${tab.title} — ${tab.url}`)
              .join('\n'),
          }
        }
        if (op === 'new') {
          const url = stringArg(args.url)
          const tab = await deps.driver.newTab(deps.context, url)
          deps.refs.update(await deps.driver.snapshot(deps.context, 0, 0))
          return {
            content: `Opened a new tab at ${tab.url}. It is now the active tab; take a snapshot.`,
            recorded: { action: 'tab_new', ...(url ? { value: url } : {}), ok: true },
          }
        }
        if (op === 'back') {
          const tab = await deps.driver.goBack(deps.context)
          deps.refs.update(await deps.driver.snapshot(deps.context, 0, 0))
          return {
            content: `Went back to ${tab.url}. Take a snapshot.`,
            recorded: { action: 'go_back', ok: true },
          }
        }
        const index = numberArg(args.index, 0)
        if (op === 'switch') {
          const tab = await deps.driver.switchTab(deps.context, index)
          deps.refs.update(await deps.driver.snapshot(deps.context, 0, 0))
          return {
            content: `Switched to tab ${index}: ${tab.url}. Take a snapshot.`,
            recorded: { action: 'tab_switch', value: String(index), ok: true },
          }
        }
        if (op === 'close') {
          const tab = await deps.driver.closeTab(deps.context, index)
          deps.refs.update(await deps.driver.snapshot(deps.context, 0, 0))
          return {
            content: `Closed tab ${index}; now on ${tab.url}.`,
            recorded: { action: 'tab_close', value: String(index), ok: true },
          }
        }
        throw new ToolInputError(`Unknown tab op "${op}". Use new, switch, close, list, or back.`)
      }

      case 'finish': {
        const status = stringArg(args.status)
        if (status !== 'passed' && status !== 'failed') {
          throw new ToolInputError('finish needs "status" to be exactly "passed" or "failed".')
        }
        const summary = stringArg(args.summary) ?? ''
        if (!summary.trim()) {
          throw new ToolInputError('finish needs a "summary" a person can read.')
        }
        const verified = Array.isArray(args.verified)
          ? args.verified.filter((entry): entry is string => typeof entry === 'string')
          : []
        const verdict: Verdict = { status, summary, verified }
        const problem = stringArg(args.problem)
        if (problem) verdict.problem = problem
        return { content: `Verdict recorded: ${status}.`, verdict }
      }

      case 'relocate': {
        const { target, label } = resolve(args.ref)
        const because = stringArg(args.because) ?? ''
        return {
          content: `Proposed ${label} (${describeTarget(target)}) as the replacement. A human must confirm it before the saved script changes.`,
          recorded: { action: 'wait_for', target, ok: true, note: `proposed fix: ${because}` },
        }
      }

      default:
        return {
          content: `Unknown tool "${String(name)}". Available: ${TOOL_NAMES.join(', ')}.`,
        }
    }
  } catch (error) {
    // A policy violation must end the run: telling the model to try again would
    // invite it to look for a way around the allow-list.
    if (error instanceof NotAllowedError) throw error
    if (error instanceof ToolInputError) return { content: `Error: ${error.message}` }
    const message = error instanceof Error ? error.message : String(error)
    return { content: `Error running ${String(name)}: ${message}` }
  }
}

/** Placeholder the runner swaps for the real secret before it reaches the page. */
export const SECRET_PLACEHOLDER = '\u0000WTP_SECRET\u0000'

/** A malformed tool call, reported to the model rather than thrown. */
class ToolInputError extends Error {}

function stringArg(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function numberArg(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Reads a boolean tool argument.
 *
 * The string forms are not defensive padding: models routinely emit `"true"` in
 * JSON arguments, and treating that as falsy would silently drop the flag the
 * model meant to set.
 */
function boolArg(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    return text === 'true' || text === 'yes' || text === '1'
  }
  return value === 1
}

/**
 * Checks a claimed pass against what was actually asserted.
 *
 * The whole point of the tool. A model that says "the dashboard loaded
 * successfully" without asserting anything has produced prose, not a test result,
 * and accepting it would make every green run meaningless.
 */
export function validateVerdict(
  verdict: Verdict,
  expectations: string[],
  assertionsPassed: string[],
): { status: 'passed' | 'failed'; reason?: string } {
  if (verdict.status === 'failed') return { status: 'failed' }
  if (expectations.length === 0) {
    // Nothing was specified, so completing the steps is the criterion.
    return { status: 'passed' }
  }
  if (assertionsPassed.length === 0) {
    return {
      status: 'failed',
      reason:
        'The run claimed a pass but never made a single successful assertion. The expectations were not verified, so the result cannot be trusted.',
    }
  }
  if (assertionsPassed.length < expectations.length) {
    return {
      status: 'failed',
      reason: `The run claimed a pass but made only ${assertionsPassed.length} successful assertion(s) for ${expectations.length} expectation(s). Every expectation must be checked.`,
    }
  }
  return { status: 'passed' }
}

/** Builds the initial message list for an agent run. */
export function initialMessages(system: string, instruction: string): WireMessage[] {
  return [
    { role: 'system', content: system },
    { role: 'user', content: instruction },
  ]
}
