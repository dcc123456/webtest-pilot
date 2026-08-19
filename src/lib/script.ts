/**
 * Script model: description, validation, JSON round-tripping, and code export.
 *
 * All pure functions. The runner executes scripts and the recorder produces
 * them; this module is what everything else uses to *talk* about them.
 *
 * @module lib/script
 */

import type { ActionName, AssertSpec } from './ops'
import { candidateSpecs, describeTarget, specToCss, type SelectorSpec, type Target } from './selectors'
import { SCRIPT_VERSION, type ScriptStep, type TestScript } from './types'

/** Actions that operate on the browser rather than inside the page. */
const BROWSER_ACTIONS = new Set<ActionName>([
  'open_url',
  'tab_new',
  'tab_switch',
  'tab_close',
  'go_back',
])

/** Actions that require a target element. */
const NEEDS_TARGET = new Set<ActionName>([
  'click',
  'hover',
  'fill',
  'select_option',
  'set_checkbox',
])

/** Actions that carry a value. */
const NEEDS_VALUE = new Set<ActionName>(['open_url', 'fill', 'select_option', 'press_key'])

/** Default per-step timeout when neither the step nor the policy sets one. */
export const DEFAULT_STEP_TIMEOUT_MS = 10_000

/** One reason a script cannot be trusted to run. */
export interface StepProblem {
  stepIndex: number
  message: string
}

/**
 * Validates a script before it is saved or replayed.
 *
 * Runs up front rather than failing mid-run, because a run that dies at step 14
 * has already left the application under test in a half-finished state. Returns
 * every problem so the UI can list them at once.
 */
export function validateScript(script: TestScript): StepProblem[] {
  const problems: StepProblem[] = []

  if (!script.name.trim()) {
    problems.push({ stepIndex: -1, message: 'The script needs a name.' })
  }
  if (script.steps.length === 0) {
    problems.push({ stepIndex: -1, message: 'The script has no steps.' })
  }
  if (script.startUrl.trim() && !/^https?:\/\//i.test(script.startUrl.trim())) {
    problems.push({ stepIndex: -1, message: 'startUrl must be an http(s) URL.' })
  }

  script.steps.forEach((step, index) => {
    if (NEEDS_TARGET.has(step.action) && !step.target) {
      problems.push({ stepIndex: index, message: `${step.action} needs a target element.` })
    }
    if (step.target && !step.target.primary) {
      problems.push({ stepIndex: index, message: 'The target has no primary selector.' })
    }
    if (NEEDS_VALUE.has(step.action)) {
      const hasValue = step.value !== undefined && step.value !== null && step.value !== ''
      // `fill` legitimately takes an empty value: that is how a field is cleared.
      const optional = step.action === 'fill'
      if (!hasValue && !step.secretRef && !optional) {
        problems.push({ stepIndex: index, message: `${step.action} needs a value.` })
      }
    }
    if (step.action === 'assert' && !step.assert) {
      problems.push({ stepIndex: index, message: 'assert needs an assertion specification.' })
    }
    if (step.assert?.kind === 'attr' && !step.assert.attr) {
      problems.push({ stepIndex: index, message: 'An attr assertion needs an attribute name.' })
    }
    if (step.assert?.kind === 'count' && !Number.isFinite(Number(step.assert.expected))) {
      problems.push({ stepIndex: index, message: 'A count assertion needs a numeric expectation.' })
    }
    if (step.action === 'open_url' && typeof step.value === 'string') {
      if (step.value.trim() && !/^https?:\/\//i.test(step.value.trim())) {
        problems.push({ stepIndex: index, message: 'open_url needs an http(s) URL.' })
      }
    }
    if (step.value !== undefined && step.secretRef) {
      problems.push({
        stepIndex: index,
        message: 'A step cannot have both a literal value and a secret reference.',
      })
    }
    if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)) {
      problems.push({ stepIndex: index, message: 'timeoutMs must be a positive number.' })
    }
  })

  return problems
}

/** True when a step drives the browser rather than the page. */
export function isBrowserAction(action: ActionName): boolean {
  return BROWSER_ACTIONS.has(action)
}

/** Renders the value shown in logs, masking a secret. */
export function describeValue(step: ScriptStep): string {
  if (step.secretRef) return `«${step.secretRef}»`
  if (step.value === undefined) return ''
  if (Array.isArray(step.value)) return step.value.join(', ')
  return String(step.value)
}

function describeAssertion(spec: AssertSpec): string {
  const not = spec.negate ? 'not ' : ''
  switch (spec.kind) {
    case 'text':
      return `text ${not}contains "${spec.expected}"`
    case 'visible':
      return `is ${not}visible`
    case 'hidden':
      return `is ${not}hidden`
    case 'value':
      return `value ${not}equals "${spec.expected}"`
    case 'url':
      return `URL ${not}contains "${spec.expected}"`
    case 'title':
      return `title ${not}contains "${spec.expected}"`
    case 'attr':
      return `attribute ${spec.attr} ${not}contains "${spec.expected}"`
    case 'count':
      return `count is ${not}${spec.expected}`
    case 'enabled':
      return `is ${not}enabled`
    case 'checked':
      return `is ${not}checked`
  }
}

/**
 * One-line human description of a step.
 *
 * Used in the run log, the UI, exported comments, and the Feishu card — one
 * phrasing everywhere, so a failure reads the same wherever it is seen.
 */
export function describeStep(step: ScriptStep): string {
  const where = step.target ? ` on ${describeTarget(step.target)}` : ''
  switch (step.action) {
    case 'open_url':
      return `open ${describeValue(step)}`
    case 'click':
      return `click ${describeTarget(step.target)}`
    case 'hover':
      return `hover ${describeTarget(step.target)}`
    case 'fill':
      return `fill ${describeTarget(step.target)} with "${describeValue(step)}"`
    case 'select_option':
      return `select "${describeValue(step)}" in ${describeTarget(step.target)}`
    case 'set_checkbox':
      return `${step.value === false ? 'uncheck' : 'check'} ${describeTarget(step.target)}`
    case 'press_key':
      return `press ${describeValue(step)}${where}`
    case 'scroll': {
      const mode = step.scroll?.mode ?? 'into_view'
      return step.target ? `scroll ${describeTarget(step.target)} into view` : `scroll ${mode}`
    }
    case 'wait_for':
      return `wait for ${describeTarget(step.target)}`
    case 'assert':
      return step.assert
        ? `assert ${describeTarget(step.target)} ${describeAssertion(step.assert)}`
        : 'assert'
    case 'extract':
      return `extract ${step.extract?.kind ?? 'text'} from ${describeTarget(step.target)}`
    case 'screenshot':
      return step.target ? `screenshot ${describeTarget(step.target)}` : 'screenshot'
    case 'read_page':
      return 'read the page'
    case 'snapshot':
      return 'snapshot the page'
    case 'tab_new':
      return `open a new tab${step.value ? ` at ${describeValue(step)}` : ''}`
    case 'tab_switch':
      return `switch to tab ${describeValue(step)}`
    case 'tab_close':
      return `close tab ${describeValue(step)}`
    case 'go_back':
      return 'go back'
  }
}

// --- JSON round-tripping -----------------------------------------------------

/**
 * Parses a script from untrusted JSON.
 *
 * Every field is checked rather than cast: a script may arrive from the bridge,
 * a file, or an older version of this extension, and a malformed one must produce
 * a message rather than a run that fails deep inside the kernel.
 *
 * @throws {Error} with a specific reason when the JSON is not a usable script.
 */
export function parseScriptJson(text: string, idFactory: () => string): TestScript {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error('A script must be a JSON object.')

  const value = raw as Partial<TestScript> & { steps?: unknown }
  if (!Array.isArray(value.steps)) throw new Error('A script needs a "steps" array.')

  const steps: ScriptStep[] = value.steps.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Step ${index + 1} is not an object.`)
    }
    const step = entry as Partial<ScriptStep>
    if (typeof step.action !== 'string') {
      throw new Error(`Step ${index + 1} has no action.`)
    }
    const parsed: ScriptStep = { action: step.action as ActionName }
    if (step.target) parsed.target = normalizeTarget(step.target, index)
    if (step.value !== undefined) parsed.value = step.value
    if (typeof step.secretRef === 'string') parsed.secretRef = step.secretRef
    if (step.assert) parsed.assert = step.assert
    if (step.scroll) parsed.scroll = step.scroll
    if (step.extract) parsed.extract = step.extract
    if (typeof step.saveAs === 'string') parsed.saveAs = step.saveAs
    if (typeof step.timeoutMs === 'number') parsed.timeoutMs = step.timeoutMs
    if (step.optional === true) parsed.optional = true
    if (typeof step.note === 'string') parsed.note = step.note
    return parsed
  })

  const now = Date.now()
  const script: TestScript = {
    id: typeof value.id === 'string' && value.id ? value.id : idFactory(),
    name: typeof value.name === 'string' && value.name.trim() ? value.name : 'Imported script',
    startUrl: typeof value.startUrl === 'string' ? value.startUrl : '',
    steps,
    version: SCRIPT_VERSION,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    updatedAt: now,
  }
  if (typeof value.caseId === 'string') script.caseId = value.caseId

  const problems = validateScript(script)
  if (problems.length > 0) {
    const summary = problems
      .slice(0, 5)
      .map((problem) =>
        problem.stepIndex >= 0 ? `step ${problem.stepIndex + 1}: ${problem.message}` : problem.message,
      )
      .join('; ')
    throw new Error(`The script is not runnable: ${summary}`)
  }
  return script
}

/** Validates and normalizes a target parsed from JSON. */
function normalizeTarget(raw: unknown, stepIndex: number): Target {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Step ${stepIndex + 1} has an invalid target.`)
  }
  const value = raw as Partial<Target>
  const primary = normalizeSpec(value.primary, stepIndex)
  const fallbacks = Array.isArray(value.fallbacks)
    ? value.fallbacks.map((spec) => normalizeSpec(spec, stepIndex))
    : []
  const target: Target = { primary, fallbacks }
  if (typeof value.frameHint === 'string') target.frameHint = value.frameHint
  if (typeof value.label === 'string') target.label = value.label
  return target
}

const VALID_HOWS = new Set(['testid', 'id', 'name', 'role', 'text', 'css', 'xpath'])

function normalizeSpec(raw: unknown, stepIndex: number): SelectorSpec {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Step ${stepIndex + 1} has an invalid selector.`)
  }
  const value = raw as Partial<SelectorSpec>
  if (typeof value.how !== 'string' || !VALID_HOWS.has(value.how)) {
    throw new Error(`Step ${stepIndex + 1} has an unknown selector kind "${String(value.how)}".`)
  }
  if (typeof value.value !== 'string') {
    throw new Error(`Step ${stepIndex + 1} has a selector without a value.`)
  }
  const spec: SelectorSpec = { how: value.how as SelectorSpec['how'], value: value.value }
  if (typeof value.role === 'string') spec.role = value.role
  if (typeof value.tag === 'string') spec.tag = value.tag
  if (typeof value.nth === 'number') spec.nth = value.nth
  return spec
}

/** Serializes a script for download, stably ordered and pretty-printed. */
export function toScriptJson(script: TestScript): string {
  return `${JSON.stringify(
    {
      version: script.version,
      name: script.name,
      startUrl: script.startUrl,
      ...(script.caseId ? { caseId: script.caseId } : {}),
      steps: script.steps,
    },
    null,
    2,
  )}\n`
}

// --- Playwright export -------------------------------------------------------

/** Escapes a string for a single-quoted TypeScript literal. */
function ts(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

/**
 * Translates a selector spec into a Playwright locator expression.
 *
 * `role` and `text` map onto Playwright's semantic locators rather than being
 * flattened to CSS: those locators are the ones Playwright's own docs recommend
 * and they survive markup changes better than a generated CSS path, so the
 * exported script is idiomatic rather than merely equivalent.
 */
export function specToPlaywright(spec: SelectorSpec): string {
  switch (spec.how) {
    case 'testid': {
      const separator = spec.value.indexOf('=')
      if (separator === -1) return `page.getByTestId(${ts(spec.value)})`
      // A non-default test-id attribute cannot use getByTestId without global
      // configuration, so fall back to an explicit attribute selector.
      const attribute = spec.value.slice(0, separator)
      const value = spec.value.slice(separator + 1)
      return `page.locator(${ts(`[${attribute}="${value}"]`)})`
    }
    case 'role': {
      const options = spec.value ? `, { name: ${ts(spec.value)}, exact: true }` : ''
      return `page.getByRole(${ts(spec.role ?? 'button')}${options})`
    }
    case 'text':
      return `page.getByText(${ts(spec.value)}, { exact: true })`
    case 'xpath':
      return `page.locator(${ts(`xpath=${spec.value}`)})`
    default: {
      const selector = specToCss(spec)
      return `page.locator(${ts(selector ?? spec.value)})`
    }
  }
}

/** A locator expression for a target, including `.nth()` when recorded. */
function targetToPlaywright(target: Target): string {
  const spec = target.primary
  const base = specToPlaywright(spec)
  return typeof spec.nth === 'number' && spec.nth > 0 ? `${base}.nth(${spec.nth})` : base
}

function playwrightAssertion(step: ScriptStep, locator: string): string[] {
  const spec = step.assert
  if (!spec) return []
  const not = spec.negate ? '.not' : ''
  switch (spec.kind) {
    case 'text':
      return [`await expect(${locator})${not}.toContainText(${ts(spec.expected)})`]
    case 'visible':
      return [`await expect(${locator})${not}.toBeVisible()`]
    case 'hidden':
      return [`await expect(${locator})${not}.toBeHidden()`]
    case 'value':
      return [`await expect(${locator})${not}.toHaveValue(${ts(spec.expected)})`]
    case 'url':
      return [`await expect(page)${not}.toHaveURL(new RegExp(${ts(escapeRegex(spec.expected))}))`]
    case 'title':
      return [`await expect(page)${not}.toHaveTitle(new RegExp(${ts(escapeRegex(spec.expected))}))`]
    case 'attr':
      return [
        `await expect(${locator})${not}.toHaveAttribute(${ts(spec.attr ?? '')}, new RegExp(${ts(
          escapeRegex(spec.expected),
        )}))`,
      ]
    case 'count':
      return [`await expect(${locator})${not}.toHaveCount(${Number(spec.expected)})`]
    case 'enabled':
      return [`await expect(${locator})${not}.toBeEnabled()`]
    case 'checked':
      return [`await expect(${locator})${not}.toBeChecked()`]
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Resolves the value a step contributes to generated code. */
function exportedValue(step: ScriptStep): string {
  if (step.secretRef) {
    // A secret is emitted as an environment lookup, never as a literal: an
    // exported script tends to end up in a repository.
    return `process.env.${step.secretRef.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()} ?? ''`
  }
  if (Array.isArray(step.value)) return `[${step.value.map((entry) => ts(String(entry))).join(', ')}]`
  return ts(String(step.value ?? ''))
}

/**
 * Exports a script as a runnable Playwright test.
 *
 * The point is a handover artefact: a QA engineer can take the file into an
 * existing Playwright suite and run it in CI without this extension. Anything
 * that has no Playwright equivalent becomes a comment rather than being dropped,
 * so the reader can see what the original run did.
 */
export function exportPlaywright(script: TestScript): string {
  const lines: string[] = [
    `import { expect, test } from '@playwright/test'`,
    '',
    '/**',
    ` * Generated by WebTest Pilot from script "${script.name}".`,
    ' *',
    ' * Secrets are read from environment variables; set them before running.',
    ' */',
    `test(${ts(script.name)}, async ({ page }) => {`,
  ]

  const indent = '  '
  if (script.startUrl.trim()) {
    lines.push(`${indent}await page.goto(${ts(script.startUrl.trim())})`)
  }

  for (const step of script.steps) {
    if (step.note) lines.push(`${indent}// ${step.note}`)
    const locator = step.target ? targetToPlaywright(step.target) : 'page'
    const timeout =
      step.timeoutMs && step.timeoutMs !== DEFAULT_STEP_TIMEOUT_MS
        ? `, { timeout: ${step.timeoutMs} }`
        : ''

    switch (step.action) {
      case 'open_url':
        lines.push(`${indent}await page.goto(${exportedValue(step)})`)
        break
      case 'click':
        lines.push(`${indent}await ${locator}.click(${timeout ? `{ timeout: ${step.timeoutMs} }` : ''})`)
        break
      case 'hover':
        lines.push(`${indent}await ${locator}.hover()`)
        break
      case 'fill':
        lines.push(`${indent}await ${locator}.fill(${exportedValue(step)})`)
        break
      case 'select_option':
        lines.push(`${indent}await ${locator}.selectOption(${exportedValue(step)})`)
        break
      case 'set_checkbox':
        lines.push(`${indent}await ${locator}.${step.value === false ? 'uncheck' : 'check'}()`)
        break
      case 'press_key':
        lines.push(
          step.target
            ? `${indent}await ${locator}.press(${exportedValue(step)})`
            : `${indent}await page.keyboard.press(${exportedValue(step)})`,
        )
        break
      case 'scroll':
        lines.push(
          step.target
            ? `${indent}await ${locator}.scrollIntoViewIfNeeded()`
            : `${indent}await page.mouse.wheel(0, ${step.scroll?.mode === 'by' ? (step.scroll.y ?? 600) : 600})`,
        )
        break
      case 'wait_for':
        lines.push(`${indent}await ${locator}.waitFor({ state: 'visible'${timeout} })`)
        break
      case 'assert':
        for (const line of playwrightAssertion(step, locator)) lines.push(`${indent}${line}`)
        break
      case 'screenshot':
        lines.push(
          step.target
            ? `${indent}await ${locator}.screenshot()`
            : `${indent}await page.screenshot({ fullPage: false })`,
        )
        break
      case 'extract': {
        const variable = step.saveAs ? step.saveAs.replace(/[^A-Za-z0-9_]/g, '_') : 'extracted'
        lines.push(`${indent}const ${variable} = await ${locator}.allInnerTexts()`)
        lines.push(`${indent}console.log(${ts(variable)}, ${variable})`)
        break
      }
      case 'tab_new':
        lines.push(`${indent}const newPage = await page.context().newPage()`)
        if (step.value) lines.push(`${indent}await newPage.goto(${exportedValue(step)})`)
        break
      case 'go_back':
        lines.push(`${indent}await page.goBack()`)
        break
      case 'tab_switch':
      case 'tab_close':
      case 'read_page':
      case 'snapshot':
        // No direct equivalent: these are observations or tab bookkeeping the
        // Playwright script does not need, but the reader should still see them.
        lines.push(`${indent}// ${describeStep(step)} — no Playwright equivalent needed`)
        break
    }
  }

  lines.push('})', '')
  return lines.join('\n')
}

/**
 * Exports a script as Markdown documentation of what it does.
 *
 * Useful for review: a human can read this and say whether the recorded steps
 * match the intent, without reading selectors.
 */
export function exportScriptMarkdown(script: TestScript): string {
  const lines: string[] = [`# ${script.name}`, '']
  if (script.startUrl) lines.push(`- Start URL: ${script.startUrl}`)
  lines.push(`- Steps: ${script.steps.length}`, '', '## Steps', '')
  script.steps.forEach((step, index) => {
    const optional = step.optional ? ' *(optional)*' : ''
    lines.push(`${index + 1}. ${describeStep(step)}${optional}`)
    const specs = step.target ? candidateSpecs(step.target) : []
    if (specs.length > 1) {
      lines.push(`   - fallbacks: ${specs.length - 1}`)
    }
  })
  lines.push('')
  return lines.join('\n')
}
