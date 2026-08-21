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
import { checkUrlAllowed } from '../lib/urlmatch'
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
  RecoveryAttempt,
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
  classifyFailure,
  diagnoseTool,
  dispatchTool,
  initialMessages,
  parseDiagnosis,
  parseToolArguments,
  recoveredStatus,
  recoveryInstruction,
  systemPrompt,
  toolSchemas,
  validateVerdict,
  type Diagnosis,
  type Verdict,
} from './agent'
import { NotAllowedError, type Driver, type RunContext } from './driver'
import { ChromeDriver, closeRunTab, findUsableTab, openRunTab } from './driver.chrome'
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
  /** Opens a tab in the user's own window, for a run with no usable page. */
  openTab: typeof openRunTab
  /** Closes only a tab this run opened; the user's own tabs are never closed. */
  closeTab: typeof closeRunTab
  findTab: typeof findUsableTab
}

/** The real implementations, used unless a caller injects otherwise. */
const chromeDeps: OrchestratorDeps = {
  createDriver: (allowedSites) => new ChromeDriver(allowedSites),
  openTab: openRunTab,
  closeTab: closeRunTab,
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
  let ownTab: number | undefined
  const deps = options.deps ?? chromeDeps

  try {
    // Every run drives the user's own browser: that is the point of shipping this
    // as an extension rather than a Playwright script. The session, cookies and
    // data they already have are inherited, so nothing has to log in first.
    const opened = await openContext(startUrl, deps, policy.allowedSites)
    context = opened.context
    ownTab = opened.ownTab

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
    // Closes only a tab this run opened itself — never the user's own tab, which
    // they were using before the run and expect to still be there after it.
    // A leaked tab per scheduled run would fill their tab strip overnight, so this
    // runs even when the run threw.
    await deps.closeTab(ownTab)
  }
}

/** Picks the recorded script for a case, unless the caller forced the agent. */
async function resolveScript(options: StartOptions): Promise<TestScript | undefined> {
  if (options.useAgent || !options.testCase) return undefined
  return getScriptForCase(options.testCase.id)
}

/**
 * Establishes the tab a run drives, always inside the user's own browser.
 *
 * This is an extension, so it takes over the browser the user already has: their
 * session, cookies and data come along, and nothing needs to log in first. No run
 * ever opens a window — not even a scheduled one, which would add a window to
 * their desktop for no benefit, since a separate window shares the same profile
 * anyway.
 *
 * The current tab is the first choice for every trigger. Only when it cannot host
 * the run does this fall back to a background tab in the same window, which is
 * closed at the end. That fallback needs a URL to be worth anything: a blank tab
 * is a new-tab page, which no extension may script.
 */
async function openContext(
  startUrl: string,
  deps: OrchestratorDeps,
  allowedSites: string[],
): Promise<{ context: RunContext; ownTab?: number }> {
  const tab = await deps.findTab(startUrl)
  if (tab) {
    // Check the page against the allow-list now, while we can name it and suggest
    // a pattern. Leaving it to the first action would surface the same refusal
    // several steps later, phrased as a mid-run failure. With a start URL the run
    // navigates away first, so the navigation's own check is the one that counts.
    if (!startUrl.trim()) {
      const verdict = checkUrlAllowed(tab.url, allowedSites)
      if (!verdict.allowed) {
        const suggestion = suggestPattern(tab.url)
        throw new StartError(
          `当前页面不在站点白名单里，插件不会对它做任何操作。\n\n` +
            `当前页面：${tab.url}\n` +
            (suggestion
              ? `请到「设置 → 站点白名单」加上这一行，然后重新运行：\n${suggestion}`
              : `请到「设置 → 站点白名单」把这个站点加进去，然后重新运行。`),
        )
      }
    }
    return { context: { tabId: tab.id, windowId: tab.windowId } }
  }

  // No usable page. With a URL we can still stay inside the user's browser by
  // opening a background tab there — it inherits the same logged-in session.
  if (startUrl.trim()) {
    const opened = await deps.openTab(startUrl)
    return {
      context: { tabId: opened.tabId, ...(opened.windowId ? { windowId: opened.windowId } : {}) },
      ownTab: opened.tabId,
    }
  }

  throw new StartError(
    '当前标签页是浏览器内部页面（如新标签页、chrome:// 页面、扩展页），扩展无法在上面操作。\n\n' +
      '请先打开你要测试的网页，再回到侧边栏运行；\n' +
      '或者在用例里写明起始地址（Markdown 用例加一行 `- url: https://your-site.com/`，' +
      '对话里直接说要打开哪个页面也可以），插件会在你当前的浏览器里打开一个后台标签页去跑。',
  )
}

/** A ready-to-paste allow-list pattern covering a page's own origin. */
function suggestPattern(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return `${new URL(url).origin}/*`
  } catch {
    return undefined
  }
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

  // A replay that failed may be handed to the agent, which is the point of this
  // whole feature: a saved script is a recording of one past journey, and the page
  // it recorded drifts. Rather than reporting a stale selector as a product defect,
  // the agent looks at the page, says what changed, and carries the case to a real
  // verdict from the step that broke.
  //
  // Three conditions, all necessary:
  //
  // - **The case must be known.** Resuming means finishing the *test*, and without
  //   its expectations there is nothing to finish honestly against — a script alone
  //   says what to click, never what should be true at the end.
  // - **The trigger must be permitted.** Unattended this is off by default: a
  //   schedule turning red into green is a report nobody reads and a script nobody
  //   fixes. See `resumeOnFailure`.
  // - **The failure must be a step failure.** `cancelled` means a human said stop,
  //   and `error` means the harness itself broke — resuming into a dead tab or an
  //   unreachable model would just fail again, more expensively.
  const resumable = result.status === 'failed' && result.failure !== undefined
  if (resumable && settings.policy.resumeOnFailure.includes(run.trigger) && options.testCase) {
    const recovered = await recoverFailedReplay(
      options.testCase,
      run,
      driver,
      context,
      options,
      result,
    )
    if (recovered) return recovered
  }

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
  recovery?: RecoveryContext,
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

  // Navigate to the case's start URL before the model gets a turn.
  //
  // The script runner has always done this; the agent did not, and that was the
  // bug behind "stopped at step 0: chrome://newtab/ cannot be automated". The
  // model would open on whatever page happened to be there — a new-tab page when
  // the user ran from a fresh tab — and its first tool call would be refused by
  // the allow-list, reported as a tooling fault that named neither the cause nor
  // the fix. Doing it here rather than asking the model to call `open_url` also
  // saves a tool round and removes a step it could forget.
  const startUrl = testCase.startUrl?.trim() ?? ''
  // A recovery run must NOT navigate. The replay left the browser part-way through
  // the flow — logged in, a form filled, a cart populated — and re-opening the
  // start URL would throw that away and put the model at the beginning of a
  // journey whose earlier steps have already really happened.
  if (startUrl && !recovery) {
    const startedAt = Date.now()
    options.observer?.onStatus?.(run.id, 'running', `打开 ${startUrl}`)
    try {
      await driver.navigate(context, startUrl)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const record: StepRecord = {
        index: -1,
        action: 'open_url',
        description: `open ${startUrl}`,
        ok: false,
        startedAt,
        durationMs: Date.now() - startedAt,
        error: message,
      }
      steps.push(record)
      const finished: TestRun = {
        ...run,
        status: 'error',
        finishedAt: Date.now(),
        heartbeatAt: Date.now(),
        steps,
        summary: `无法打开起始地址：${message}`,
        failure: { stepIndex: -1, message },
      }
      await saveRun(finished)
      await logOutcome(finished)
      options.observer?.onRun?.(finished)
      return { run: finished }
    }
  }

  const maxRounds = settings.policy.maxToolRounds
  const messages: WireMessage[] = initialMessages(
    systemPrompt({
      allowedSites: settings.policy.allowedSites,
      secretNames,
      maxRounds,
    }),
    // A recovery run gets a different opening instruction: the case as written
    // describes work that is already half done, and handing that over unchanged is
    // what makes a model redo a submitted form.
    recovery ? recovery.instruction : renderCaseForModel(testCase),
  )
  const tools = toolSchemas({ selfHeal: settings.policy.selfHeal, secretNames })
  if (recovery) tools.push(diagnoseTool())
  const deadline = Date.now() + settings.policy.runTimeoutMs

  let verdict: Verdict | undefined
  let stoppedBecause: string | undefined
  let diagnosis: Diagnosis | undefined

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

      // `diagnose` is answered here rather than in `dispatchTool` because it touches
      // no page: it is the model explaining itself, and the explanation is kept even
      // if recovery then fails — a recovery that did not work is precisely what
      // tells a human the failure is real rather than a stale selector.
      if (call.function.name === 'diagnose') {
        diagnosis = parseDiagnosis(parseToolArguments(call.function.arguments))
        options.observer?.onToolCall?.(run.id, 'diagnose', diagnosis.diagnosis)
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content:
            'Diagnosis recorded. Now continue the test from where it stopped, without repeating any completed step, and assert every expectation before calling finish.',
        })
        continue
      }

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

  // The check that makes a green run mean something. Recovery does NOT get a
  // softer bar: the verdict is validated against the case's own expectations
  // exactly as for a normal run, so "the agent rescued it" can never mean "we
  // stopped checking".
  const checked = verdict
    ? validateVerdict(verdict, testCase.expectations, assertionsPassed)
    : { status: 'error' as const, reason: stoppedBecause }

  const baseStatus: RunStatus = options.signal?.aborted
    ? 'cancelled'
    : verdict
      ? checked.status
      : 'error'

  // Only a validated pass is relabelled. A recovered run that still failed stays
  // `failed`, because the application really did not do what the case requires.
  const status: RunStatus =
    recovery && baseStatus === 'passed' ? recoveredStatus('passed') : baseStatus

  const summary = verdict
    ? checked.reason
      ? `${verdict.summary}（结论被驳回：${checked.reason}）`
      : verdict.summary
    : (stoppedBecause ?? '运行未得出结论。')

  let recordedScript: TestScript | undefined
  // Only a genuine pass is worth recording: saving a script from a failed run
  // would enshrine the broken path as the expected one.
  //
  // A recovery run is excluded on purpose. Its actions are a repair of one broken
  // step, not a recording of the whole journey — the earlier steps happened during
  // the replay and were never recorded here, so saving this would produce a script
  // that starts in the middle. The fix belongs in the existing script, which is why
  // recovery only ever *suggests* one.
  if (status === 'passed' && !recovery && settings.policy.autoSaveScript && recorder.length > 0) {
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
    status === 'passed' || status === 'recovered'
      ? undefined
      : {
          stepIndex: steps.length - 1,
          message: verdict?.problem ?? checked.reason ?? summary,
        }

  // Assembled here so the run carries the whole story: what broke, what the model
  // made of it, and what it did next. This is the material a human needs to fix the
  // script for real, and the evidence for judging whether to trust the result.
  const recoveryRecord: RecoveryAttempt | undefined = recovery
    ? {
        failedAtStep: recovery.failedAtStep,
        originalError: recovery.originalError,
        cause: recovery.cause,
        resumed: verdict !== undefined,
        steps,
        ...(diagnosis?.diagnosis ? { diagnosis: diagnosis.diagnosis } : {}),
        ...(diagnosis?.proposal ? { proposal: diagnosis.proposal } : {}),
        ...(stoppedBecause ? { gaveUpBecause: stoppedBecause } : {}),
        ...(diagnosis?.suggestedFix
          ? { suggestedFix: { stepIndex: recovery.failedAtStep, note: diagnosis.suggestedFix } }
          : {}),
      }
    : undefined

  const finished: TestRun = {
    ...run,
    status,
    finishedAt: Date.now(),
    heartbeatAt: Date.now(),
    // A recovery run's own steps are numbered after the replay's, so the stored run
    // reads as one continuous history rather than restarting at zero.
    steps: recovery ? [...recovery.priorSteps, ...steps] : steps,
    artifactIds,
    summary,
    ...(failure ? { failure } : {}),
    ...(recordedScript ? { scriptId: recordedScript.id } : {}),
    ...(Object.keys(extracted).length > 0 ? { extracted } : {}),
    ...(recoveryRecord ? { recovery: recoveryRecord } : {}),
  }
  await saveRun(finished)
  await logOutcome(finished)
  options.observer?.onRun?.(finished)
  options.observer?.onStatus?.(run.id, status, summary)

  return { run: finished, ...(recordedScript ? { recordedScript } : {}) }
}

/**
 * Everything the agent needs to take over a replay that stopped partway.
 *
 * Passed rather than recomputed because only the replay knows it: which step died,
 * what the runner blamed, and — critically — which steps have *already really
 * happened*. That last list is what stops the model from submitting the same order
 * twice.
 */
interface RecoveryContext {
  failedAtStep: number
  originalError: string
  cause: 'selector' | 'application'
  /** The replay's step records, so the stored run reads as one history. */
  priorSteps: StepRecord[]
  /** The opening instruction, built by {@link recoveryInstruction}. */
  instruction: string
}

/**
 * Hands a failed replay to the agent, from the step that broke.
 *
 * Returns `undefined` when recovery could not even be attempted (no provider
 * configured), so the caller reports the original failure rather than masking a
 * real result behind a setup problem.
 *
 * The failed step is looked up by matching `StepRecord.index` rather than by array
 * position. Today the runner emits dense, in-order records, so the two are
 * equivalent — this is defensive, not a fix for a live bug. It is written this way
 * because `stepIndex` is a step *identity* (the runner numbers a pre-step
 * navigation `-1`), and if a record is ever skipped or reordered, resuming from a
 * position would silently name the wrong step and re-run an effectful one.
 */
async function recoverFailedReplay(
  testCase: TestCase,
  run: TestRun,
  driver: Driver,
  context: RunContext,
  options: StartOptions,
  result: { status: RunStatus; steps: StepRecord[]; failure?: { stepIndex: number; message: string } },
): Promise<RunOutcome | undefined> {
  const provider = await activeProvider()
  if (!provider || !provider.apiKey.trim()) {
    await appendLog({
      level: 'info',
      source: `run:${run.id}`,
      message: '脚本失败后未启动智能体接管：尚未配置模型（provider）。',
    })
    return undefined
  }

  const failedAtStep = result.failure?.stepIndex ?? 0
  const originalError = result.failure?.message ?? '未知失败'
  const failedRecord = result.steps.find((step) => step.index === failedAtStep)
  const cause = classifyFailure(failedRecord, originalError)

  // Only steps that genuinely ran and succeeded count as "already done". A step
  // that failed did not happen, so telling the model it did would leave a gap in
  // the flow that nothing ever performs.
  const completed = result.steps.filter((step) => step.ok && step.index >= 0)

  // The case's own step list is the remaining work, from the failure onwards. The
  // case is the source of truth here rather than the script: the script is the
  // thing that turned out to be wrong.
  const remaining = testCase.steps.slice(Math.max(0, failedAtStep))

  options.observer?.onStatus?.(
    run.id,
    'running',
    `第 ${failedAtStep + 1} 步失败，智能体开始分析并尝试继续……`,
  )
  await appendLog({
    level: 'info',
    source: `run:${run.id}`,
    message: `脚本在第 ${failedAtStep + 1} 步失败（${cause === 'selector' ? '定位失效' : '应用行为'}），智能体接管续跑。`,
  })

  const instruction = recoveryInstruction({
    caseName: testCase.name,
    steps: remaining,
    expectations: testCase.expectations,
    completed,
    failedStep: failedRecord?.description ?? `step ${failedAtStep + 1}`,
    failedAtStep,
    error: originalError,
    cause,
  })

  return driveWithModel(testCase, run, driver, context, options, {
    failedAtStep,
    originalError,
    cause,
    priorSteps: result.steps,
    instruction,
  })
}

/** Re-exported so triggers can distinguish a policy refusal from a failure. */
export { NotAllowedError }
export { SECRET_PLACEHOLDER }
