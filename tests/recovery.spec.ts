/**
 * Recovery tests: what happens when a saved script fails and the agent takes over.
 *
 * The unit under test is a decision, not a rendering, so these focus on the four
 * things that would actually hurt in production:
 *
 * - **Resuming must not repeat an effectful step.** The replay may already have
 *   submitted an order. A model told to "run the test" from the top would submit
 *   it again, and no amount of test coverage elsewhere would catch that.
 * - **A recovered run must not be quietly green.** The application passed, but the
 *   script is broken; hiding that turns a fast suite into a slow one, silently.
 * - **Recovery must not lower the bar for a pass.** `validateVerdict` still
 *   applies, so an agent cannot rescue a run by claiming success.
 * - **Unattended triggers must not recover unless asked.** A 3am schedule going
 *   green is a report nobody reads.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { installChromeFake } from './fake-chrome'
import { FakeDriver } from './fake-driver'
import {
  classifyFailure,
  parseDiagnosis,
  recoveredStatus,
  recoveryInstruction,
} from '../src/background/agent'
import type { StepRecord } from '../src/lib/types'

let storage: typeof import('../src/lib/storage')

beforeEach(async () => {
  installChromeFake()
  storage = await import('../src/lib/storage')
})

function step(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    index: 0,
    action: 'click',
    description: 'click "Sign in"',
    ok: true,
    startedAt: 0,
    durationMs: 5,
    ...overrides,
  }
}

describe('classifyFailure: which prior the model is given', () => {
  it('treats a not-found element as a stale script', () => {
    expect(classifyFailure(step({ ok: false }), 'No element matched the target.')).toBe('selector')
  })

  it('recognises the runner\'s Chinese not-found phrasing too', () => {
    expect(classifyFailure(undefined, '找不到匹配的元素')).toBe('selector')
  })

  it('treats a disabled control as the application misbehaving', () => {
    // The element WAS found. Letting the model hunt for another button here is how
    // a real bug gets clicked around instead of reported.
    expect(
      classifyFailure(step({ ok: false }), '<button> "Sign in" is disabled, so it cannot be clicked.'),
    ).toBe('application')
  })

  it('treats a failed assertion as the application misbehaving', () => {
    expect(classifyFailure(step({ ok: false, action: 'assert' }), 'expected /dashboard, got /login')).toBe(
      'application',
    )
  })

  it('reads the step record as well as the message, since the runner splits them', () => {
    expect(classifyFailure(step({ ok: false, error: 'no element matched' }), 'step 3 could not run')).toBe(
      'selector',
    )
  })
})

describe('recoveryInstruction: the prompt that prevents a double submit', () => {
  const base = {
    caseName: 'Checkout',
    steps: ['Confirm the order', 'Check the receipt'],
    expectations: ['The receipt shows the order number'],
    completed: [
      step({ index: 0, description: 'fill card number' }),
      step({ index: 1, description: 'click "Place order"' }),
    ],
    failedStep: 'assert text "Thank you"',
    failedAtStep: 2,
    error: 'No element matched the target.',
    cause: 'selector' as const,
  }

  it('lists completed steps and forbids repeating them', () => {
    const text = recoveryInstruction(base)
    expect(text).toContain('click "Place order"')
    // The safety-critical sentence in the whole feature.
    expect(text).toMatch(/do NOT do them again/i)
    expect(text).toMatch(/Never repeat an action/i)
  })

  it('says which step it stopped on, using 1-based numbering a human recognises', () => {
    expect(recoveryInstruction(base)).toContain('Step 3 is where it stopped')
  })

  it('passes the expectations through, because the verdict is checked against them', () => {
    expect(recoveryInstruction(base)).toContain('The receipt shows the order number')
  })

  it('tells the model to look for the moved element when the cause is a selector', () => {
    const text = recoveryInstruction(base)
    expect(text).toMatch(/saved script is out of date/i)
    // Even here it must not force a pass.
    expect(text).toMatch(/do not force it/i)
  })

  it('forbids working around the failure when the cause is the application', () => {
    const text = recoveryInstruction({ ...base, cause: 'application' })
    // This is the difference that stops recovery from laundering a real bug.
    expect(text).toMatch(/Do NOT look for another way/i)
    expect(text).toMatch(/hide a real bug/i)
  })

  it('handles a failure on the very first step without pretending work was done', () => {
    const text = recoveryInstruction({ ...base, completed: [], failedAtStep: 0 })
    expect(text).toContain('(none — it failed on the first step)')
  })

  it('says completing the steps is the criterion when a case lists no expectations', () => {
    const text = recoveryInstruction({ ...base, expectations: [] })
    expect(text).toMatch(/no explicit expectations/i)
  })

  it('orders diagnose before continuing, so the explanation survives a failed recovery', () => {
    const text = recoveryInstruction(base)
    expect(text.indexOf('Call snapshot')).toBeLessThan(text.indexOf('Call diagnose'))
    expect(text.indexOf('Call diagnose')).toBeLessThan(text.indexOf('Continue the test'))
  })
})

describe('recoveredStatus: recovery relabels a pass, never rescues a failure', () => {
  it('labels a validated pass as recovered', () => {
    expect(recoveredStatus('passed')).toBe('recovered')
  })

  it('leaves a failure failed, so an agent cannot turn a real bug green', () => {
    expect(recoveredStatus('failed')).toBe('failed')
  })
})

describe('parseDiagnosis: tolerating a sloppy model', () => {
  it('reads a well-formed diagnosis', () => {
    const parsed = parseDiagnosis({
      cause: 'stale_selector',
      diagnosis: 'The button is now labelled 提交.',
      proposal: 'Click the 提交 button and continue.',
      suggestedFix: 'Target data-testid="submit" instead.',
    })
    expect(parsed.cause).toBe('stale_selector')
    expect(parsed.suggestedFix).toContain('data-testid')
  })

  it('falls back to unknown rather than trusting an invented cause', () => {
    expect(parseDiagnosis({ cause: 'the vibes were off', diagnosis: 'x', proposal: 'y' }).cause).toBe(
      'unknown',
    )
  })

  it('omits suggestedFix when the model left it blank, so the field means something', () => {
    expect(parseDiagnosis({ cause: 'timing', diagnosis: 'x', proposal: 'y', suggestedFix: '   ' })
      .suggestedFix).toBeUndefined()
  })

  it('survives missing fields without throwing mid-run', () => {
    const parsed = parseDiagnosis({})
    expect(parsed.cause).toBe('unknown')
    expect(parsed.diagnosis).toBe('')
  })
})

describe('the per-trigger gate', () => {
  it('permits manual runs by default and refuses unattended ones', async () => {
    const settings = await storage.getSettings()
    // The shipped default, stated as a test because it is a policy decision people
    // will rely on: a human watching gets recovery, a 3am schedule does not.
    expect(settings.policy.resumeOnFailure).toContain('manual')
    expect(settings.policy.resumeOnFailure).not.toContain('schedule')
    expect(settings.policy.resumeOnFailure).not.toContain('bridge')
  })

  it('does not treat a recovered run as a pass by default', async () => {
    const settings = await storage.getSettings()
    expect(settings.policy.treatRecoveredAsPass).toBe(false)
  })

  it('lets an operator opt in per trigger', async () => {
    const before = await storage.getSettings()
    await storage.saveSettings({
      policy: { ...before.policy, resumeOnFailure: ['manual', 'schedule'] },
    })
    const after = await storage.getSettings()
    expect(after.policy.resumeOnFailure).toEqual(['manual', 'schedule'])
  })
})

describe('a driver is never touched by the decision helpers', () => {
  it('classifyFailure and recoveryInstruction perform no page actions', () => {
    // They are pure: recovery must be decidable before anything is done to the
    // page, so a refusal cannot leave the app half-changed.
    const driver = new FakeDriver()
    classifyFailure(step({ ok: false }), 'no element matched')
    recoveryInstruction({
      caseName: 'x',
      steps: ['a'],
      expectations: [],
      completed: [],
      failedStep: 's',
      failedAtStep: 0,
      error: 'e',
      cause: 'selector',
    })
    expect(driver.calls).toHaveLength(0)
  })
})
