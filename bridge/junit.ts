/**
 * JUnit XML for CI report viewers.
 *
 * Every CI system on earth can read JUnit XML, so this is the cheapest way to get
 * run results into GitLab, Jenkins, or a Feishu card built from a pipeline
 * artifact. The document is written by hand rather than with an XML library: the
 * output shape is fixed and tiny, and a dependency here would have to be shipped
 * to every machine that runs the bridge.
 *
 * Writing XML by hand has exactly one real hazard, and it is the reason this
 * module exists as a separate, tested unit: an unescaped value. A test case named
 * `A & B` produces `name="A & B"`, which is not well-formed XML, and the failure
 * surfaces as "could not parse JUnit report" *after* the tests ran — the whole
 * result of a pipeline lost to one ampersand. So every interpolated value goes
 * through {@link escapeXml}, without exception.
 *
 * @module bridge/junit
 */

import { isTerminalStatus, type RunStatus, type StepRecord, type TestRun } from '../src/lib/types'

/** Knobs a CI job may want; all optional so `toJUnitXml(runs)` just works. */
export interface JUnitOptions {
  /** `<testsuite name>`, e.g. the pipeline or environment under test. */
  suiteName?: string
  /** `classname` on each testcase; CI groups trend graphs by it. */
  className?: string
  /** Overrides the suite timestamp; injected by tests for a stable document. */
  timestamp?: number
}

const DEFAULT_SUITE_NAME = 'WebTest Pilot'
const DEFAULT_CLASS_NAME = 'webtest-pilot'

/**
 * Escapes text for use in either element content or a double-quoted attribute.
 *
 * All five predefined entities are escaped, not just the three that content
 * strictly requires, so one function is safe in both positions — a helper that is
 * only correct in one of them eventually gets used in the other.
 *
 * `&` must be replaced first, otherwise the ampersands introduced by the later
 * replacements would themselves be re-escaped into `&amp;lt;`.
 */
export function escapeXml(value: string): string {
  return stripInvalidXmlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Drops characters XML 1.0 cannot carry at all.
 *
 * Control characters below 0x20 other than tab, LF, and CR are illegal in an XML
 * 1.0 document *even as numeric character references*, so there is no escaping
 * available — dropping them is the only way to emit a parseable document. They
 * turn up in practice from a page's `innerText`, from terminal colour codes in an
 * error message, and from a NUL that survived a truncated buffer. Lone surrogates
 * are removed for the same reason.
 */
export function stripInvalidXmlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDFFF]/g, '')
}

/** Seconds, with millisecond precision — the unit every JUnit reader expects. */
export function runSeconds(run: TestRun): number {
  const end = run.finishedAt ?? run.heartbeatAt
  const ms = typeof end === 'number' ? end - run.startedAt : 0
  if (!Number.isFinite(ms) || ms < 0) return 0
  return Math.round(ms) / 1000
}

/**
 * Which JUnit element a run status becomes.
 *
 * The mapping is the whole point of keeping `failed` and `error` distinct in the
 * domain model: `<failure>` tells a team "your application is broken",
 * `<error>` tells them "the test harness could not tell". `cancelled` is
 * `<skipped>` because a human stopped it deliberately and it is not a result.
 * A still-running run is reported as an error too — a report should never claim a
 * run passed just because it had not finished when the XML was written.
 */
export function outcomeElement(status: RunStatus): 'failure' | 'error' | 'skipped' | null {
  switch (status) {
    case 'passed':
      return null
    case 'failed':
      return 'failure'
    case 'cancelled':
      return 'skipped'
    case 'error':
    case 'interrupted':
      return 'error'
    default:
      // queued / running: not terminal, see the note above.
      return 'error'
  }
}

/** One `step 3 click "Sign in" — failed: ...` line for the failure body. */
function describeStep(step: StepRecord): string {
  const mark = step.ok ? 'ok' : 'FAIL'
  const parts = [`  [${mark}] #${step.index} ${step.description} (${step.durationMs}ms)`]
  if (step.assertion) {
    parts.push(`expected=${step.assertion.expected} actual=${step.assertion.actual}`)
  }
  if (step.error) parts.push(`error=${step.error}`)
  return parts.join(' ')
}

/**
 * The human-readable body of a `<failure>`/`<error>`.
 *
 * Steps are included because the first question anyone asks a red CI job is
 * "which step, and what did it see" — and clicking through to a bridge that may
 * not be running is not an answer.
 */
export function failureBody(run: TestRun): string {
  const lines: string[] = [`run ${run.id} status=${run.status} mode=${run.mode} trigger=${run.trigger}`]
  if (run.failure) lines.push(`failure at step #${run.failure.stepIndex}: ${run.failure.message}`)
  if (run.summary) lines.push(`summary: ${run.summary}`)
  if (!isTerminalStatus(run.status)) {
    lines.push('The run had not finished when this report was generated.')
  }
  if (run.steps.length > 0) {
    lines.push('steps:')
    for (const step of run.steps) lines.push(describeStep(step))
  }
  return lines.join('\n')
}

/** Short `message` attribute; a reader shows it in the collapsed row. */
function failureMessage(run: TestRun): string {
  if (run.failure) return run.failure.message
  if (run.summary) return run.summary
  const failedStep = run.steps.find((step) => !step.ok)
  if (failedStep) return `${failedStep.description}: ${failedStep.error ?? 'step failed'}`
  return `run ended with status ${run.status}`
}

/** Renders one `<testcase>`, including its outcome child when there is one. */
function testCaseXml(run: TestRun, className: string): string {
  const attributes = [
    `name="${escapeXml(run.caseName)}"`,
    `classname="${escapeXml(className)}"`,
    `time="${runSeconds(run).toFixed(3)}"`,
  ].join(' ')

  const element = outcomeElement(run.status)
  if (!element) {
    // A passing run still carries its id, so a green report can be traced back to
    // the evidence in the extension without re-running anything.
    return `    <testcase ${attributes}>\n      <system-out>${escapeXml(
      `run ${run.id}`,
    )}</system-out>\n    </testcase>`
  }
  if (element === 'skipped') {
    // `<skipped>` has no body in the schema readers agree on; the reason goes in
    // the attribute.
    return `    <testcase ${attributes}>\n      <skipped message="${escapeXml(
      failureMessage(run),
    )}"/>\n    </testcase>`
  }
  return [
    `    <testcase ${attributes}>`,
    `      <${element} message="${escapeXml(failureMessage(run))}" type="${escapeXml(run.status)}">${escapeXml(
      failureBody(run),
    )}</${element}>`,
    '    </testcase>',
  ].join('\n')
}

/**
 * Builds a complete `<testsuites>` document for the given runs.
 *
 * One suite rather than one per case: CI readers show a flat list anyway, and a
 * suite per case would make the "0 tests" case emit nothing at all, which some
 * readers treat as a broken report instead of an empty one.
 */
export function toJUnitXml(runs: TestRun[], options: JUnitOptions = {}): string {
  const suiteName = options.suiteName ?? DEFAULT_SUITE_NAME
  const className = options.className ?? DEFAULT_CLASS_NAME

  let failures = 0
  let errors = 0
  let skipped = 0
  let totalSeconds = 0
  for (const run of runs) {
    const element = outcomeElement(run.status)
    if (element === 'failure') failures += 1
    else if (element === 'error') errors += 1
    else if (element === 'skipped') skipped += 1
    totalSeconds += runSeconds(run)
  }

  const earliest = runs.reduce<number | null>(
    (min, run) => (min === null || run.startedAt < min ? run.startedAt : min),
    null,
  )
  const stamp = new Date(options.timestamp ?? earliest ?? Date.now()).toISOString()

  const suiteAttributes = [
    `name="${escapeXml(suiteName)}"`,
    `tests="${runs.length}"`,
    `failures="${failures}"`,
    `errors="${errors}"`,
    `skipped="${skipped}"`,
    `time="${totalSeconds.toFixed(3)}"`,
    `timestamp="${escapeXml(stamp)}"`,
  ].join(' ')

  const body = runs.map((run) => testCaseXml(run, className)).join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeXml(suiteName)}" tests="${runs.length}" failures="${failures}" errors="${errors}" time="${totalSeconds.toFixed(
      3,
    )}">`,
    `  <testsuite ${suiteAttributes}>`,
    ...(body.length > 0 ? [body] : []),
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n')
}
