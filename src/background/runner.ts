/**
 * The script runner: deterministic replay of a saved script.
 *
 * Depends only on {@link Driver}, so all of the interesting behaviour — retries,
 * timeouts, secret substitution, failure classification, artifact capture — is
 * testable against a fake driver in Node.
 *
 * ## Failure classification
 *
 * The runner distinguishes three outcomes, and the distinction is the point:
 *
 * - **failed** — an assertion did not hold, or an element the test needs is not
 *   there. A finding about the application under test.
 * - **error** — the harness could not carry out the attempt: no tab, a
 *   disallowed URL, injection refused. A finding about this tool.
 * - **cancelled** — a human or a timeout stopped it.
 *
 * Reporting the second as the first is what makes an automated suite untrusted,
 * so the two are kept apart all the way to the Feishu card.
 *
 * @module background/runner
 */

import type { ExtractedValue, Op } from '../lib/ops'
import { DEFAULT_STEP_TIMEOUT_MS, describeStep, validateScript } from '../lib/script'
import type { RunStatus, ScriptStep, StepRecord, TestScript } from '../lib/types'
import { NotAllowedError, type Driver, type RunContext } from './driver'

/** How the run reports progress, so the panel and the bridge can follow along. */
export interface RunnerEvents {
  onStepStart?: (index: number, description: string) => void
  onStepDone?: (record: StepRecord) => void
  onStatus?: (text: string) => void
}

export interface RunnerOptions {
  driver: Driver
  context: RunContext
  /** Resolves a `secretRef` to its value. Missing names must throw. */
  resolveSecret?: (name: string) => string
  /** Default per-step timeout when the step does not set one. */
  stepTimeoutMs?: number
  /** Whole-run wall-clock budget. */
  runTimeoutMs?: number
  /** Capture a screenshot after every step, not only on failure. */
  screenshotEveryStep?: boolean
  /** Persists a screenshot and returns its artifact id. */
  saveScreenshot?: (dataUrl: string) => Promise<string>
  /** Cooperative cancellation. */
  signal?: AbortSignal
  events?: RunnerEvents
}

/** Outcome of a whole replay. */
export interface RunnerResult {
  status: RunStatus
  steps: StepRecord[]
  failure?: { stepIndex: number; message: string; screenshotId?: string }
  /** Values captured by `extract` steps that used `saveAs`. */
  extracted: Record<string, ExtractedValue>
  summary: string
}

/** Raised for a harness problem, as opposed to a test failure. */
class HarnessError extends Error {}

/** Number of attempts for a step whose element was not found. */
const MAX_ATTEMPTS = 3

/** Delay before retrying a not-found element. */
const RETRY_DELAY_MS = 400

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Substitutes a step's secret reference for its value.
 *
 * Done here, in the worker, immediately before the value crosses into the page:
 * the script on disk, the run log, the model transcript, and the exported code
 * all keep the reference instead of the password.
 */
function resolveStepValue(
  step: ScriptStep,
  resolveSecret: ((name: string) => string) | undefined,
): ScriptStep['value'] {
  if (!step.secretRef) return step.value
  if (!resolveSecret) {
    throw new HarnessError(
      `Step needs the secret "${step.secretRef}", but no secrets are configured. Add it in Settings → Secrets.`,
    )
  }
  const value = resolveSecret(step.secretRef)
  if (value === undefined || value === '') {
    throw new HarnessError(
      `The secret "${step.secretRef}" is not set. Add it in Settings → Secrets.`,
    )
  }
  return value
}

/** Builds the in-page op for a step, with the secret already resolved. */
function toOp(step: ScriptStep, value: ScriptStep['value']): Op {
  const op: Op = { action: step.action }
  if (step.target) op.target = step.target
  if (value !== undefined) op.value = value
  if (step.assert) op.assert = step.assert
  if (step.scroll) op.scroll = step.scroll
  if (step.extract) op.extract = step.extract
  return op
}

/**
 * Replays a script.
 *
 * Never throws for an ordinary failure: the result carries the status. It throws
 * only if the script itself is unusable, which is a programming error at the call
 * site rather than a run outcome.
 */
export async function runScript(
  script: TestScript,
  options: RunnerOptions,
): Promise<RunnerResult> {
  const problems = validateScript(script)
  if (problems.length > 0) {
    const summary = problems
      .map((problem) =>
        problem.stepIndex >= 0 ? `step ${problem.stepIndex + 1}: ${problem.message}` : problem.message,
      )
      .join('; ')
    return {
      status: 'error',
      steps: [],
      failure: { stepIndex: -1, message: `The script is not runnable: ${summary}` },
      extracted: {},
      summary: `Refused to run: ${summary}`,
    }
  }

  const {
    driver,
    context,
    resolveSecret,
    stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    runTimeoutMs = 300_000,
    screenshotEveryStep = false,
    saveScreenshot,
    signal,
    events,
  } = options

  const steps: StepRecord[] = []
  const extracted: Record<string, ExtractedValue> = {}
  const deadline = Date.now() + runTimeoutMs

  // The opening navigation is part of the run, not a precondition: if it fails,
  // that is the run's first and only error, reported like any other.
  if (script.startUrl.trim()) {
    const started = Date.now()
    events?.onStepStart?.(-1, `open ${script.startUrl}`)
    try {
      await driver.navigate(context, script.startUrl.trim())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const record: StepRecord = {
        index: -1,
        action: 'open_url',
        description: `open ${script.startUrl}`,
        ok: false,
        startedAt: started,
        durationMs: Date.now() - started,
        error: message,
      }
      steps.push(record)
      events?.onStepDone?.(record)
      return {
        status: error instanceof NotAllowedError ? 'error' : 'error',
        steps,
        failure: { stepIndex: -1, message },
        extracted,
        summary: `Could not open the start URL: ${message}`,
      }
    }
  }

  for (let index = 0; index < script.steps.length; index += 1) {
    const step = script.steps[index]
    if (!step) continue

    if (signal?.aborted) {
      return {
        status: 'cancelled',
        steps,
        extracted,
        summary: `Cancelled after ${steps.filter((record) => record.ok).length} step(s).`,
      }
    }
    if (Date.now() > deadline) {
      const message = `The run exceeded its ${Math.round(runTimeoutMs / 1000)}s budget.`
      return {
        status: 'error',
        steps,
        failure: { stepIndex: index, message },
        extracted,
        summary: message,
      }
    }

    const description = describeStep(step)
    events?.onStepStart?.(index, description)
    const startedAt = Date.now()
    const timeout = step.timeoutMs ?? stepTimeoutMs

    const record: StepRecord = {
      index,
      action: step.action,
      description,
      ok: false,
      startedAt,
      durationMs: 0,
    }

    try {
      const outcome = await executeStep(step, {
        driver,
        context,
        timeout,
        resolveSecret,
        signal,
      })
      record.ok = outcome.ok
      if (outcome.attempts > 1) record.attempts = outcome.attempts
      if (outcome.usedFallback) record.usedFallback = true
      if (outcome.usedSpec) record.usedSpec = outcome.usedSpec
      if (outcome.error) record.error = outcome.error
      if (outcome.assertion) record.assertion = outcome.assertion
      if (outcome.extracted) {
        record.extracted = outcome.extracted
        if (step.saveAs) extracted[step.saveAs] = outcome.extracted
      }

      // A screenshot on failure is not optional: without it, a nightly failure
      // report is a sentence with no evidence behind it.
      const wantShot = saveScreenshot && (screenshotEveryStep || !outcome.ok)
      if (wantShot && saveScreenshot) {
        try {
          const shot = await driver.screenshot(context)
          record.screenshotId = await saveScreenshot(shot.dataUrl)
        } catch {
          // A failed capture must never turn a passing step into a failure.
        }
      }

      record.durationMs = Date.now() - startedAt
      steps.push(record)
      events?.onStepDone?.(record)

      if (!outcome.ok) {
        if (step.optional) {
          events?.onStatus?.(`Optional step ${index + 1} did not apply; continuing.`)
          continue
        }
        const failure: RunnerResult['failure'] = {
          stepIndex: index,
          message: outcome.error ?? 'The step did not succeed.',
        }
        if (record.screenshotId) failure.screenshotId = record.screenshotId
        return {
          // Fault attribution, and the distinction the whole product rests on:
          //
          // - `failed` — the application was not in the state the script needs.
          //   A missing element and a disabled button are both findings: the tool
          //   did its job and told us the app is wrong.
          // - `error` — the harness could not carry the step out at all (the tab
          //   died, injection was blocked, a secret is missing). Nothing was
          //   learned about the application, so reporting this as a test failure
          //   would send someone hunting for a bug that does not exist.
          // - `cancelled` — a human stopped it, which is not a fault at all.
          status:
            outcome.kind === 'cancelled'
              ? 'cancelled'
              : outcome.kind === 'harness'
                ? 'error'
                : 'failed',
          steps,
          failure,
          extracted,
          summary: `Step ${index + 1} (${description}) ${
            outcome.kind === 'assertion' ? 'failed' : 'could not run'
          }: ${outcome.error ?? 'unknown reason'}`,
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      record.ok = false
      record.error = message
      record.durationMs = Date.now() - startedAt
      steps.push(record)
      events?.onStepDone?.(record)
      return {
        status: 'error',
        steps,
        failure: { stepIndex: index, message },
        extracted,
        summary: `Step ${index + 1} (${description}) could not run: ${message}`,
      }
    }
  }

  return {
    status: 'passed',
    steps,
    extracted,
    summary: `All ${steps.filter((record) => record.index >= 0).length} step(s) passed.`,
  }
}

/** What one step attempt produced. */
interface StepOutcome {
  ok: boolean
  /**
   * Which layer decided the outcome, so the runner can attribute the fault.
   *
   * `action` and `assertion` are both findings about the application; `harness`
   * means the tool itself could not proceed; `cancelled` is a human decision.
   */
  kind: 'action' | 'assertion' | 'harness' | 'cancelled'
  attempts: number
  error?: string
  usedFallback?: boolean
  usedSpec?: string
  assertion?: { passed: boolean; actual: string; expected: string }
  extracted?: ExtractedValue
}

/**
 * Executes one step, retrying only for a genuinely retryable cause.
 *
 * Retries are limited to "the element was not found": that is the transient case
 * (a page still rendering). A failed assertion or a disabled control is not
 * retried, because retrying a real finding just delays the report — and a step
 * with a side effect must never be repeated after it already ran.
 */
async function executeStep(
  step: ScriptStep,
  deps: {
    driver: Driver
    context: RunContext
    timeout: number
    resolveSecret?: (name: string) => string
    signal?: AbortSignal
  },
): Promise<StepOutcome> {
  const { driver, context, timeout, resolveSecret } = deps
  const value = resolveStepValue(step, resolveSecret)

  // Browser-level actions bypass the page kernel entirely.
  switch (step.action) {
    case 'open_url': {
      await driver.navigate(context, String(value ?? ''))
      return { ok: true, kind: 'action', attempts: 1 }
    }
    case 'tab_new': {
      await driver.newTab(context, value ? String(value) : undefined)
      return { ok: true, kind: 'action', attempts: 1 }
    }
    case 'tab_switch': {
      await driver.switchTab(context, Number(value ?? 0))
      return { ok: true, kind: 'action', attempts: 1 }
    }
    case 'tab_close': {
      await driver.closeTab(context, Number(value ?? 0))
      return { ok: true, kind: 'action', attempts: 1 }
    }
    case 'go_back': {
      await driver.goBack(context)
      return { ok: true, kind: 'action', attempts: 1 }
    }
    default:
      break
  }

  const op = toOp(step, value)

  // Conditions poll for the whole timeout rather than retrying discretely.
  if (step.action === 'wait_for' || step.action === 'assert') {
    const result = await driver.waitFor(context, op, timeout)
    const outcome: StepOutcome = {
      ok: result.ok,
      kind: step.action === 'assert' ? 'assertion' : 'action',
      attempts: 1,
    }
    if (result.usedFallback) outcome.usedFallback = true
    if (result.usedSpec) outcome.usedSpec = result.usedSpec
    if (result.assertion) {
      outcome.assertion = {
        passed: result.assertion.passed,
        actual: result.assertion.actual,
        expected: result.assertion.expected,
      }
    }
    if (!result.ok) {
      outcome.error =
        result.error ??
        (step.action === 'wait_for'
          ? `The element never became visible within ${Math.round(timeout / 1000)}s.`
          : 'The assertion did not hold.')
      // An assertion whose element never appeared is still a test finding, not a
      // harness error: the application did not render what the test expects.
      if (step.action === 'wait_for') outcome.kind = 'assertion'
    }
    return outcome
  }

  let lastError = 'The step did not succeed.'
  let attempts = 0
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt
    if (deps.signal?.aborted) {
      return { ok: false, kind: 'cancelled', attempts, error: 'Cancelled.' }
    }

    const result = await driver.exec(context, op)
    if (result.ok) {
      const outcome: StepOutcome = { ok: true, kind: 'action', attempts }
      if (result.usedFallback) outcome.usedFallback = true
      if (result.usedSpec) outcome.usedSpec = result.usedSpec
      if (result.extracted) outcome.extracted = result.extracted
      // A step that navigated leaves the next one racing the new document.
      if (result.mayNavigate) await driver.waitForLoad(context, Math.min(timeout, 30_000))
      return outcome
    }

    lastError = result.error ?? lastError
    // Only a missing element is worth another attempt.
    if (result.found) {
      return { ok: false, kind: 'action', attempts, error: lastError }
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS)
  }

  return {
    ok: false,
    // The element never appeared: the page did not render what the script needs,
    // which is a finding about the application.
    kind: 'assertion',
    attempts,
    error: lastError,
  }
}
