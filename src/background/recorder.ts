/**
 * The recorder: turns a passing agent run into a replayable script.
 *
 * This is what makes an LLM-driven test economically viable. The model is needed
 * once, to work out *how* to drive the page; after that the recorded step list
 * replays deterministically with no tokens spent and no chance of the model
 * choosing differently on a later run.
 *
 * Two rules shape what gets recorded:
 *
 * 1. **Only successful, effectful steps.** Failed attempts, retries, and the
 *    model's exploratory reads (`snapshot`, `read_page`) are dropped: they were
 *    how the model figured the page out, not part of the test.
 * 2. **Secrets stay references.** A filled password is recorded as its
 *    `secretRef`, never its value.
 *
 * @module background/recorder
 */

import type { ActionName } from '../lib/ops'
import type { ScriptStep, TestScript } from '../lib/types'
import { SCRIPT_VERSION } from '../lib/types'
import type { Target } from '../lib/selectors'

/**
 * Actions worth recording.
 *
 * `snapshot`/`read_page` are excluded: they observe without changing anything, so
 * replaying them would only slow the run down. `screenshot` is excluded for the
 * same reason unless the model asked for it deliberately — see
 * {@link RecordedAction.keep}.
 */
const RECORDABLE = new Set<ActionName>([
  'open_url',
  'click',
  'hover',
  'fill',
  'select_option',
  'set_checkbox',
  'press_key',
  'scroll',
  'wait_for',
  'assert',
  'extract',
  'screenshot',
  'tab_new',
  'tab_switch',
  'tab_close',
  'go_back',
])

/** Observations that were only ever the model orienting itself. */
const NEVER_RECORD = new Set<ActionName>(['snapshot', 'read_page'])

/** One action the agent performed, as offered to the recorder. */
export interface RecordedAction {
  action: ActionName
  target?: Target
  value?: string | string[] | boolean
  secretRef?: string
  assert?: ScriptStep['assert']
  scroll?: ScriptStep['scroll']
  extract?: ScriptStep['extract']
  saveAs?: string
  note?: string
  /** Whether the action succeeded. Only successes are recorded. */
  ok: boolean
  /** Forces recording of an action that would otherwise be filtered out. */
  keep?: boolean
}

/**
 * Accumulates actions during a run and emits a script at the end.
 *
 * Stateful by design and held only for the duration of one run: the durable
 * artefact is the script it produces.
 */
export class Recorder {
  private readonly actions: RecordedAction[] = []

  /** Records one attempted action. Filtering happens here, not at emit time. */
  add(action: RecordedAction): void {
    if (!action.ok) return
    if (NEVER_RECORD.has(action.action)) return
    if (!RECORDABLE.has(action.action)) return
    // A screenshot is a diagnostic unless the caller explicitly wants it kept as
    // part of the test.
    if (action.action === 'screenshot' && !action.keep) return
    this.actions.push(action)
  }

  /** How many steps would be emitted right now. */
  get length(): number {
    return this.actions.length
  }

  /**
   * Builds the step list.
   *
   * Consecutive `fill`s of the same field collapse to the last one: a model that
   * clears a field and then types is expressing one intent, and replaying both
   * would be slower and no more faithful.
   */
  steps(): ScriptStep[] {
    const steps: ScriptStep[] = []
    for (const action of this.actions) {
      const step: ScriptStep = { action: action.action }
      if (action.target) step.target = action.target
      if (action.secretRef) step.secretRef = action.secretRef
      else if (action.value !== undefined) step.value = action.value
      if (action.assert) step.assert = action.assert
      if (action.scroll) step.scroll = action.scroll
      if (action.extract) step.extract = action.extract
      if (action.saveAs) step.saveAs = action.saveAs
      if (action.note) step.note = action.note

      const previous = steps[steps.length - 1]
      if (
        previous &&
        previous.action === 'fill' &&
        step.action === 'fill' &&
        sameTarget(previous.target, step.target)
      ) {
        steps[steps.length - 1] = step
        continue
      }
      steps.push(step)
    }
    return steps
  }

  /**
   * Emits a script.
   *
   * @throws {Error} when nothing effectful was recorded — saving an empty script
   *   would create something that "passes" without testing anything, which is
   *   worse than having no script.
   */
  toScript(meta: {
    id: string
    name: string
    startUrl: string
    caseId?: string
    runId?: string
    now?: number
  }): TestScript {
    const steps = this.steps()
    if (steps.length === 0) {
      throw new Error(
        'Nothing to save: the run performed no recordable action. A script needs at least one interaction or assertion.',
      )
    }
    const now = meta.now ?? Date.now()
    const script: TestScript = {
      id: meta.id,
      name: meta.name,
      startUrl: meta.startUrl,
      steps,
      version: SCRIPT_VERSION,
      createdAt: now,
      updatedAt: now,
    }
    if (meta.caseId) script.caseId = meta.caseId
    if (meta.runId) script.recordedFromRunId = meta.runId
    return script
  }
}

/** True when two targets address the same element by the same primary selector. */
function sameTarget(a: Target | undefined, b: Target | undefined): boolean {
  if (!a || !b) return false
  return (
    a.primary.how === b.primary.how &&
    a.primary.value === b.primary.value &&
    a.primary.nth === b.primary.nth
  )
}

/**
 * Suggests a script name from a case name.
 *
 * Kept deterministic rather than asking the model: a name generated per run
 * would make two recordings of the same case look unrelated in the list.
 */
export function suggestScriptName(caseName: string): string {
  const trimmed = caseName.trim()
  return trimmed.length > 0 ? trimmed : 'Recorded script'
}
