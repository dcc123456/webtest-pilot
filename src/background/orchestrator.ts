/**
 * The orchestrator: everything that happens between "start this test" and a
 * stored, notified result.
 *
 * One module owns the whole lifecycle because the lifecycle is where the hard
 * guarantees live, and splitting them across triggers would mean re-establishing
 * each one three times (panel, schedule, bridge):
 *
 * - **A run is persisted before it starts and on every step.** MV3 can evict the
 *   worker mid-run; storage is what makes progress survivable and what lets a
 *   crashed run be recognised as interrupted rather than eternally "running".
 * - **A run window is always closed.** Leaking a window per nightly run would
 *   fill the user's desktop by morning.
 * - **Unattended triggers refuse without an allow-list.** A schedule firing at
 *   3am with no boundary configured is the worst version of this tool.
 * - **A claimed pass is checked against the assertions actually made.**
 *
 * @module background/orchestrator
 */

import { putArtifact } from '../lib/artifacts'
import { LlmError, streamCompletion, type WireMessage, type WireToolCall } from '../lib/llm'
import { renderCaseForModel } from '../lib/markdown'
import { describeStep } from '../lib/script'
import {
  activeProvider,
  appendLog,
  getScriptForCase,
  getSettings,
  newId,
  patchRun,
  saveRun,
  saveScript,
  getSecrets,
} from '../lib/storage'
import type {
  RunMode,
  RunStatus,
  RunTrigger,
  StepRecord,
  TestCase,
  TestRun,
  TestScript,
} from '../lib/types'
import {
  RefTable,
  SECRET_PLACEHOLDER,
  dispatchTool,
  initialMessages,
  systemPrompt,
  toolSchemas,
  validateVerdict,
  type Verdict,
} from './agent'
import { NotAllowedError, type Driver, type RunContext } from './driver'
import { ChromeDriver, closeRunWindow, findUsableTab, openRunWindow } from './driver.chrome'
import { Recorder, suggestScriptName } from './recorder'
import { runScript } from './runner'

/** How a run reports progress to whoever is watching. */
export interface RunObserver {
  onRun?: (run: TestRun) => void
  onStep?: (runId: string, step: StepRecord) => void
  onStatus?: (runId: string, status: RunStatus, message?: string) => void
  /** Assistant prose during an agent run, for the chat transcript. */
  onAssistantText?: (runId: string, text: string) => void
  onToolCall?: (runId: string, name: string, summary: string) => void
}

export interface StartOptions {
  testCase?: TestCase
  script?: TestScript
  trigger: RunTrigger
  /** Force the agent even when a recorded script exists. */
  useAgent?: boolean
  observer?: RunObserver
  signal?: AbortSignal
  /**
   * Overrides for the browser-facing pieces.
   *
   * Present so the lifecycle guarantees this module exists to enforce — the run
   * window is always closed, a failure is still persisted, cancellation is
   * honoured — can be tested without a real Chrome. Production callers omit it.
   */
  deps?: OrchestratorDeps
}

/** The browser-facing collaborators, injectable for tests. */
export interface OrchestratorDeps {
  createDriver: (allowedSites: string[]) => Driver
  openWindow: typeof openRunWindow
  closeWindow: typeof closeRunWindow
  findTab: typeof findUsableTab
}

/** The real implementations, used unless a caller injects otherwise. */
const chromeDeps: OrchestratorDeps = {
  createDriver: (allowedSites) => new ChromeDriver(allowedSites),
  openWindow: openRunWindow,
  closeWindow: closeRunWindow,
  findTab: findUsableTab,
}

/** Outcome handed back to the trigger that started the run. */
export interface RunOutcome {
  run: TestRun
  /** A script recorded during this run, when one was. */
  recordedScript?: TestScript
}

/** Raised when a run cannot be started at all, as opposed to failing. */
export class StartError extends Error {}

/**
 * Runs a test case or script end to end.
 *
 * Always resolves with a stored run — including for failures — because a caller
 * (the bridge, a schedule) needs a run id to report against even when the
 * attempt went wrong. It rejects only when nothing could be started, which is a
 * configuration problem the user must fix.
 */
export async function startRun(options: StartOptions): Promise<RunOutcome> {
  const settings = await getSettings()
  const { policy } = settings

  // An unattended trigger with no boundary is refused outright. A human at the
  // panel gets the same refusal, but they can see and fix it immediately.
  if (policy.allowedSites.length === 0) {
    throw new StartError(
      '尚未配置允许访问的站点（allowed sites）。请在「设置 → 站点白名单」中添加，例如 https://app.example.com/*。这是本插件唯一的安全边界，未配置时不会对任何页面执行操作。',
    )
  }

  const script = options.script ?? (await resolveScript(options))
  const useScript = !options.useAgent && script !== undefined
  const mode: RunMode = useScript ? 'script' : 'agent'

  if (!useScript && !options.testCase) {
    throw new StartError('没有可执行的内容：既没有测试用例，也没有可回放的脚本。')
  }

  const startUrl = script?.startUrl || options.testCase?.startUrl || ''
  const runId = newId('run')
  const now = Date.now()

  const run: TestRun = {
    id: runId,
    caseId: options.testCase?.id ?? '',
    // Denormalized so the history stays readable after the case is deleted.
    caseName: options.testCase?.name ?? script?.name ?? '(未命名)',
    scriptId: script?.id ?? '',
    mode,
    trigger: options.trigger,
    status: 'running',
    startedAt: now,
    heartbeatAt: now,
    steps: [],
    artifactIds: [],
  }
  await saveRun(run)
  options.observer?.onRun?.(run)

  let context: RunContext | undefined
  let ownWindow: number | undefined
  const deps = options.deps ?? chromeDeps

  try {
    const opened = await openContext(policy.useDedicatedWindow, startUrl, deps)
    context = opened.context
    ownWindow = opened.ownWindow

    const driver = deps.createDriver(policy.allowedSites)
    const outcome = useScript
      ? await replayScript(script as TestScript, run, driver, context, options)
      : await driveWithModel(options.testCase as TestCase, run, driver, context, options)

    return outcome
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status: RunStatus = options.signal?.aborted ? 'cancelled' : 'error'
    const finished: TestRun = {
      ...run,
      status,
      finishedAt: Date.now(),
      heartbeatAt: Date.now(),
      summary:
        status === 'cancelled'
          ? '运行已被取消。'
          : `运行未能完成：${message}`,
      ...(status === 'error' ? { failure: { stepIndex: -1, message } } : {}),
    }
    await saveRun(finished)
    await appendLog({ level: 'error', source: `run:${runId}`, message })
    options.observer?.onRun?.(finished)
    options.observer?.onStatus?.(runId, status, message)
    return { run: finished }
  } finally {
    // A leaked window per scheduled run would fill the desktop overnight, so
    // this runs even when the run threw.
    await deps.closeWindow(ownWindow)
  }
}

/** Picks the recorded script for a case, unless the caller forced the agent. */
async function resolveScript(options: StartOptions): Promise<TestScript | undefined> {
  if (options.useAgent || !options.testCase) return undefined
  return getScriptForCase(options.testCase.id)
}

/**
 * Establishes the tab a run drives.
 *
 * A dedicated window is the default: it keeps the run away from the user's own
 * tabs, and `focused: false` means a 3am run does not steal the screen. Reusing
 * the current tab is offered because it is what a developer debugging a selector
 * actually wants.
 */
async function openContext(
  useDedicatedWindow: boolean,
  startUrl: string,
  deps: OrchestratorDeps,
): Promise<{ context: RunContext; ownWindow?: number }> {
  if (useDedicatedWindow) {
    const opened = await deps.openWindow(startUrl || undefined)
    return { context: { tabId: opened.tabId, windowId: opened.windowId }, ownWindow: opened.windowId }
  }
  const tab = await deps.findTab(startUrl)
  if (!tab) {
    throw new StartError(
      '找不到可用的标签页。当前所有标签页都是浏览器内部页面（chrome://、扩展页、应用商店），插件无法在这些页面上操作。请打开一个普通网页，或在设置中改用「独立窗口」模式。',
    )
  }
  return { context: { tabId: tab.id, windowId: tab.windowId } }
}

/** Replays a saved script through the deterministic runner. */
async function replayScript(
  script: TestScript,
  run: TestRun,
  driver: Driver,
  context: RunContext,
  options: StartOptions,
): Promise<RunOutcome> {
  const settings = await getSettings()
  const secrets = await getSecrets()
  const table = new Map(secrets.map((secret) => [secret.name, secret.value]))
  const steps: StepRecord[] = []
  const artifactIds: string[] = []

  const result = await runScript(script, {
    driver,
    context,
    resolveSecret: (name) => table.get(name) ?? '',
    stepTimeoutMs: settings.policy.stepTimeoutMs,
    runTimeoutMs: settings.policy.runTimeoutMs,
    screenshotEveryStep: settings.policy.screenshotEveryStep,
    saveScreenshot: async (dataUrl) => {
      const id = newId('art')
      await putArtifact({
        id,
        runId: run.id,
        stepIndex: steps.length,
        dataUrl,
        width: 0,
        height: 0,
        createdAt: Date.now(),
      })
      artifactIds.push(id)
      return id
    },
    ...(options.signal ? { signal: options.signal } : {}),
    events: {
      onStepDone: (record) => {
        steps.push(record)
        options.observer?.onStep?.(run.id, record)
        // Heartbeat on every step: a stalled run is then distinguishable from a
        // crashed one, which is what `reconcileRuns` relies on.
        void patchRun(run.id, { steps: [...steps], heartbeatAt: Date.now() })
      },
      onStatus: (text) => options.observer?.onStatus?.(run.id, 'running', text),
    },
  })

  const finished: TestRun = {
    ...run,
    status: result.status,
    finishedAt: Date.now(),
    heartbeatAt: Date.now(),
    steps: result.steps,
    artifactIds,
    summary: result.summary,
    ...(result.failure ? { failure: result.failure } : {}),
  }
  await saveRun(finished)
  await logOutcome(finished)
  options.observer?.onRun?.(finished)
  options.observer?.onStatus?.(run.id, result.status, result.summary)
  return { run: finished }
}

/**
 * Writes a log line for a run that did not pass.
 *
 * The run record already holds the detail, but the log is what a user actually
 * reads after an unattended failure — and it is the only place that survives the
 * run history being capped or cleared.
 */
async function logOutcome(run: TestRun): Promise<void> {
  if (run.status === 'passed') return
  await appendLog({
    // `error` and `interrupted` mean the suite did not really run, which needs
    // attention more urgently than a genuine test failure.
    level: run.status === 'failed' || run.status === 'cancelled' ? 'warn' : 'error',
    source: `run:${run.id}`,
    message: `运行「${run.caseName}」结束，状态：${run.status}。${run.failure?.message ?? run.summary ?? ''}`,
  })
}

/**
 * Drives the browser with the model, recording as it goes.
 *
 * The loop is bounded three ways — tool rounds, wall clock, and cancellation —
 * because each bounds a different failure: a confused model looping, a hung
 * page, and a user changing their mind.
 */
async function driveWithModel(
  testCase: TestCase,
  run: TestRun,
  driver: Driver,
  context: RunContext,
  options: StartOptions,
): Promise<RunOutcome> {
  const settings = await getSettings()
  const provider = await activeProvider()
  if (!provider || !provider.apiKey.trim()) {
    throw new StartError(
      '尚未配置模型（provider）。请在「设置 → 模型」中填写 Base URL、API Key 与模型名称。',
    )
  }

  const secrets = await getSecrets()
  const secretNames = secrets.map((secret) => secret.name)
  const secretValues = new Map(secrets.map((secret) => [secret.name, secret.value]))

  const refs = new RefTable()
  const recorder = new Recorder()
  const steps: StepRecord[] = []
  const artifactIds: string[] = []
  const assertionsPassed: string[] = []
  const extracted: Record<string, unknown> = {}

  const maxRounds = settings.policy.maxToolRounds
  const messages: WireMessage[] = initialMessages(
    systemPrompt({
      allowedSites: settings.policy.allowedSites,
      secretNames,
      maxRounds,
    }),
    renderCaseForModel(testCase),
  )
  const tools = toolSchemas({ selfHeal: settings.policy.selfHeal, secretNames })
  const deadline = Date.now() + settings.policy.runTimeoutMs

  let verdict: Verdict | undefined
  let stoppedBecause: string | undefined

  for (let round = 0; round < maxRounds; round += 1) {
    if (options.signal?.aborted) {
      stoppedBecause = 'cancelled'
      break
    }
    if (Date.now() > deadline) {
      stoppedBecause = `运行超过了 ${Math.round(settings.policy.runTimeoutMs / 1000)} 秒的时间预算。`
      break
    }

    let text = ''
    let toolCalls: WireToolCall[] = []
    try {
      const completion = await streamCompletion(
        {
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          model: provider.model,
          messages,
          tools,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(provider.label ? { providerLabel: provider.label } : {}),
          ...(provider.headers ? { headers: provider.headers } : {}),
          ...(provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
          ...(provider.maxTokens !== undefined ? { maxTokens: provider.maxTokens } : {}),
        },
        {
          onText: (delta: string) => {
            text += delta
            options.observer?.onAssistantText?.(run.id, delta)
          },
        },
      )
      toolCalls = completion.toolCalls
      if (completion.content) text = completion.content
    } catch (error) {
      if (error instanceof LlmError) {
        // A model or network failure is a harness error, not a test finding: the
        // application under test was never given a verdict.
        throw new Error(`模型调用失败：${error.message}`)
      }
      throw error
    }

    messages.push({
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })

    if (toolCalls.length === 0) {
      // No tool call and no verdict: the model narrated instead of acting. One
      // nudge is worth a round; a second would just burn the budget.
      messages.push({
        role: 'user',
        content:
          'You did not call a tool. Continue the test by calling a tool, or call finish with your verdict.',
      })
      continue
    }

    for (const call of toolCalls) {
      if (options.signal?.aborted) break
      const startedAt = Date.now()
      const outcome = await dispatchTool(call, {
        driver,
        context,
        refs,
        stepTimeoutMs: settings.policy.stepTimeoutMs,
        secretNames,
        onExtract: (name, value) => {
          extracted[name] = value
        },
      })

      // The real secret is substituted here, at the last possible moment, so it
      // never entered the model transcript or the tool arguments.
      if (outcome.recorded?.secretRef) {
        const value = secretValues.get(outcome.recorded.secretRef)
        if (value !== undefined && outcome.recorded.target) {
          await driver.exec(context, {
            action: 'fill',
            target: outcome.recorded.target,
            value,
          })
        }
      }

      if (outcome.screenshotDataUrl) {
        const id = newId('art')
        await putArtifact({
          id,
          runId: run.id,
          stepIndex: steps.length,
          dataUrl: outcome.screenshotDataUrl,
          width: 0,
          height: 0,
          createdAt: Date.now(),
        })
        artifactIds.push(id)
      }
      if (outcome.assertionPassed) assertionsPassed.push(outcome.assertionPassed)
      if (outcome.recorded) recorder.add(outcome.recorded)

      const record: StepRecord = {
        index: steps.length,
        action: outcome.recorded?.action ?? (call.function.name as StepRecord['action']),
        description: outcome.recorded ? describeStep(outcome.recorded) : call.function.name,
        ok: outcome.recorded !== undefined || outcome.verdict !== undefined,
        startedAt,
        durationMs: Date.now() - startedAt,
        ...(outcome.content.startsWith('Error') || outcome.content.includes('FAILED')
          ? { error: outcome.content }
          : {}),
      }
      steps.push(record)
      options.observer?.onStep?.(run.id, record)
      options.observer?.onToolCall?.(run.id, call.function.name, outcome.content)
      void patchRun(run.id, { steps: [...steps], heartbeatAt: Date.now() })

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: outcome.content,
      })

      if (outcome.verdict) {
        verdict = outcome.verdict
        break
      }
    }

    if (verdict) break
  }

  if (!verdict && !stoppedBecause) {
    stoppedBecause = `模型在 ${maxRounds} 轮工具调用内没有给出结论。`
  }

  // The check that makes a green run mean something.
  const checked = verdict
    ? validateVerdict(verdict, testCase.expectations, assertionsPassed)
    : { status: 'error' as const, reason: stoppedBecause }

  const status: RunStatus = options.signal?.aborted
    ? 'cancelled'
    : verdict
      ? checked.status
      : 'error'

  const summary = verdict
    ? checked.reason
      ? `${verdict.summary}（结论被驳回：${checked.reason}）`
      : verdict.summary
    : (stoppedBecause ?? '运行未得出结论。')

  let recordedScript: TestScript | undefined
  // Only a genuine pass is worth recording: saving a script from a failed run
  // would enshrine the broken path as the expected one.
  if (status === 'passed' && settings.policy.autoSaveScript && recorder.length > 0) {
    try {
      recordedScript = await saveScript(
        recorder.toScript({
          id: newId('scr'),
          name: suggestScriptName(testCase.name),
          startUrl: testCase.startUrl ?? '',
          caseId: testCase.id,
          runId: run.id,
        }),
      )
    } catch (error) {
      await appendLog({
        level: 'warn',
        source: `run:${run.id}`,
        message: `脚本未能保存：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  const failure =
    status === 'passed'
      ? undefined
      : {
          stepIndex: steps.length - 1,
          message: verdict?.problem ?? checked.reason ?? summary,
        }

  const finished: TestRun = {
    ...run,
    status,
    finishedAt: Date.now(),
    heartbeatAt: Date.now(),
    steps,
    artifactIds,
    summary,
    ...(failure ? { failure } : {}),
    ...(recordedScript ? { scriptId: recordedScript.id } : {}),
    ...(Object.keys(extracted).length > 0 ? { extracted } : {}),
  }
  await saveRun(finished)
  await logOutcome(finished)
  options.observer?.onRun?.(finished)
  options.observer?.onStatus?.(run.id, status, summary)

  return { run: finished, ...(recordedScript ? { recordedScript } : {}) }
}

/** Re-exported so triggers can distinguish a policy refusal from a failure. */
export { NotAllowedError }
export { SECRET_PLACEHOLDER }
