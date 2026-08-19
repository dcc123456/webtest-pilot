import { describe, expect, it } from 'vitest'

import { runScript } from '../src/background/runner'
import type { ScriptStep, TestScript } from '../src/lib/types'
import { SCRIPT_VERSION } from '../src/lib/types'
import { DriverError, NotAllowedError, type RunContext } from '../src/background/driver'
import { FakeDriver } from './fake-driver'

function script(steps: ScriptStep[], startUrl = 'https://app.test/login'): TestScript {
  return {
    id: 's1',
    name: 'Login smoke',
    startUrl,
    steps,
    version: SCRIPT_VERSION,
    createdAt: 1,
    updatedAt: 1,
  }
}

function context(): RunContext {
  return { tabId: 1, windowId: 10 }
}

const clickTarget = {
  primary: { how: 'testid' as const, value: 'submit' },
  fallbacks: [],
  label: 'Sign in',
}
const fieldTarget = { primary: { how: 'id' as const, value: 'email' }, fallbacks: [], label: 'Email' }

describe('runScript: happy path', () => {
  it('navigates, runs every step, and reports passed', async () => {
    const driver = new FakeDriver()
    const result = await runScript(
      script([
        { action: 'fill', target: fieldTarget, value: 'a@b.c' },
        { action: 'click', target: clickTarget },
        { action: 'assert', assert: { kind: 'url', expected: '/dashboard' } },
      ]),
      { driver, context: context() },
    )

    expect(result.status).toBe('passed')
    // Three steps plus the opening navigation.
    expect(result.steps.filter((record) => record.index >= 0)).toHaveLength(3)
    expect(result.steps.every((record) => record.ok)).toBe(true)
    expect(driver.calls[0]).toMatchObject({ method: 'navigate', arg: 'https://app.test/login' })
  })

  it('records a human description for each step', async () => {
    const driver = new FakeDriver()
    const result = await runScript(
      script([{ action: 'click', target: clickTarget }]),
      { driver, context: context() },
    )
    expect(result.steps[0]?.description).toBe('click Sign in')
  })

  it('skips the opening navigation when the script has no start URL', async () => {
    const driver = new FakeDriver()
    await runScript(script([{ action: 'click', target: clickTarget }], ''), {
      driver,
      context: context(),
    })
    expect(driver.calls.some((call) => call.method === 'navigate')).toBe(false)
  })
})

describe('runScript: failure classification', () => {
  it('reports a failed assertion as failed, not error', async () => {
    const driver = new FakeDriver().program('assert', {
      kind: 'assertFailed',
      actual: 'Login',
      expected: 'Dashboard',
    })
    const result = await runScript(
      script([{ action: 'assert', assert: { kind: 'title', expected: 'Dashboard' } }]),
      { driver, context: context() },
    )

    expect(result.status).toBe('failed')
    expect(result.failure?.stepIndex).toBe(0)
    expect(result.steps[0]?.assertion).toEqual({
      passed: false,
      actual: 'Login',
      expected: 'Dashboard',
    })
  })

  it('reports an element that never appears as failed, since the app did not render it', async () => {
    const driver = new FakeDriver().program('click', { kind: 'notFound' })
    const result = await runScript(script([{ action: 'click', target: clickTarget }]), {
      driver,
      context: context(),
    })
    expect(result.status).toBe('failed')
  })

  it('reports a disabled or covered control as failed with the reason', async () => {
    const driver = new FakeDriver().program('click', {
      kind: 'failed',
      error: '<button> "Sign in" is disabled, so it cannot be clicked.',
    })
    const result = await runScript(script([{ action: 'click', target: clickTarget }]), {
      driver,
      context: context(),
    })
    // A findable-but-unusable control is a statement about the application, not
    // about the tool: the click was attempted and the app refused it.
    expect(result.status).toBe('failed')
    expect(result.failure?.message).toContain('disabled')
  })

  it('reports a harness problem as error', async () => {
    const driver = new FakeDriver().program('click', {
      kind: 'throw',
      error: new DriverError('The run\'s tab is gone.'),
    })
    const result = await runScript(script([{ action: 'click', target: clickTarget }]), {
      driver,
      context: context(),
    })
    expect(result.status).toBe('error')
    expect(result.failure?.message).toContain('tab is gone')
  })

  it('reports a disallowed start URL as error, with the allow-list reason', async () => {
    const driver = new FakeDriver().program('open_url', {
      kind: 'throw',
      error: new NotAllowedError('https://evil.test/ is not in the allowed sites list.'),
    })
    const result = await runScript(script([{ action: 'click', target: clickTarget }]), {
      driver,
      context: context(),
    })
    expect(result.status).toBe('error')
    expect(result.failure?.message).toContain('allowed sites')
    // The step list shows the navigation that failed, so the report is not empty.
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]?.index).toBe(-1)
  })

  it('stops at the first hard failure instead of running the rest', async () => {
    const driver = new FakeDriver().program('click', { kind: 'failed', error: 'nope' })
    const result = await runScript(
      script([
        { action: 'click', target: clickTarget },
        { action: 'fill', target: fieldTarget, value: 'x' },
      ]),
      { driver, context: context() },
    )
    expect(result.steps).toHaveLength(1)
    expect(driver.countOf('fill')).toBe(0)
  })
})

describe('runScript: retries', () => {
  it('retries a not-found element and succeeds when it appears', async () => {
    const driver = new FakeDriver().program(
      'click',
      { kind: 'notFound' },
      { kind: 'notFound' },
      { kind: 'ok' },
    )
    const result = await runScript(script([{ action: 'click', target: clickTarget }]), {
      driver,
      context: context(),
    })
    expect(result.status).toBe('passed')
    expect(result.steps[0]?.attempts).toBe(3)
    expect(driver.countOf('click')).toBe(3)
  })

  it('does not retry a step whose element was found but refused the action', async () => {
    // Critical: retrying an effectful step that already ran would double-submit.
    const driver = new FakeDriver().program('click', { kind: 'failed', error: 'disabled' })
    await runScript(script([{ action: 'click', target: clickTarget }]), {
      driver,
      context: context(),
    })
    expect(driver.countOf('click')).toBe(1)
  })

  it('gives up after three attempts', async () => {
    const driver = new FakeDriver().program('click', { kind: 'notFound' })
    const result = await runScript(script([{ action: 'click', target: clickTarget }]), {
      driver,
      context: context(),
    })
    expect(driver.countOf('click')).toBe(3)
    expect(result.status).toBe('failed')
  })

  it('does not retry an assertion, which polls instead', async () => {
    const driver = new FakeDriver().program('assert', {
      kind: 'assertFailed',
      actual: 'a',
      expected: 'b',
    })
    await runScript(script([{ action: 'assert', assert: { kind: 'text', expected: 'b' } }]), {
      driver,
      context: context(),
    })
    expect(driver.countOf('assert')).toBe(1)
  })
})

describe('runScript: optional steps', () => {
  it('continues past a failing optional step', async () => {
    const driver = new FakeDriver().program('click', { kind: 'notFound' })
    const result = await runScript(
      script([
        { action: 'click', target: clickTarget, optional: true, note: 'dismiss cookie banner' },
        { action: 'fill', target: fieldTarget, value: 'x' },
      ]),
      { driver, context: context() },
    )
    expect(result.status).toBe('passed')
    expect(result.steps[0]?.ok).toBe(false)
    expect(result.steps[1]?.ok).toBe(true)
  })

  it('still records the optional failure, so it is visible in the report', async () => {
    const driver = new FakeDriver().program('click', { kind: 'notFound' })
    const result = await runScript(
      script([{ action: 'click', target: clickTarget, optional: true }]),
      { driver, context: context() },
    )
    expect(result.steps[0]?.error).toBeTruthy()
    expect(result.failure).toBeUndefined()
  })
})

describe('runScript: secrets', () => {
  it('substitutes a secret value without putting it in the record', async () => {
    const driver = new FakeDriver()
    const result = await runScript(
      script([{ action: 'fill', target: fieldTarget, secretRef: 'LOGIN_PW' }]),
      { driver, context: context(), resolveSecret: () => 'hunter2' },
    )

    expect(result.status).toBe('passed')
    const fillCall = driver.calls.find((call) => call.op?.action === 'fill')
    // The real value reaches the page…
    expect(fillCall?.op?.value).toBe('hunter2')
    // …but never the step description or the run record.
    expect(JSON.stringify(result.steps)).not.toContain('hunter2')
    expect(result.steps[0]?.description).toContain('LOGIN_PW')
  })

  it('fails clearly when the secret is not configured', async () => {
    const driver = new FakeDriver()
    const result = await runScript(
      script([{ action: 'fill', target: fieldTarget, secretRef: 'LOGIN_PW' }]),
      { driver, context: context() },
    )
    expect(result.status).toBe('error')
    expect(result.failure?.message).toContain('Secrets')
  })

  it('fails clearly when the secret exists but is empty', async () => {
    const driver = new FakeDriver()
    const result = await runScript(
      script([{ action: 'fill', target: fieldTarget, secretRef: 'LOGIN_PW' }]),
      { driver, context: context(), resolveSecret: () => '' },
    )
    expect(result.status).toBe('error')
    expect(result.failure?.message).toContain('not set')
  })
})

describe('runScript: screenshots', () => {
  it('captures on failure even when per-step capture is off', async () => {
    const driver = new FakeDriver().program('click', { kind: 'failed', error: 'nope' })
    const saved: string[] = []
    const result = await runScript(script([{ action: 'click', target: clickTarget }]), {
      driver,
      context: context(),
      saveScreenshot: async (dataUrl) => {
        saved.push(dataUrl)
        return `art-${saved.length}`
      },
    })
    expect(saved).toHaveLength(1)
    expect(result.failure?.screenshotId).toBe('art-1')
  })

  it('captures every step when asked', async () => {
    const driver = new FakeDriver()
    const saved: string[] = []
    await runScript(
      script([
        { action: 'click', target: clickTarget },
        { action: 'fill', target: fieldTarget, value: 'x' },
      ]),
      {
        driver,
        context: context(),
        screenshotEveryStep: true,
        saveScreenshot: async (dataUrl) => {
          saved.push(dataUrl)
          return `art-${saved.length}`
        },
      },
    )
    expect(saved).toHaveLength(2)
  })

  it('does not turn a passing step into a failure when capture breaks', async () => {
    const driver = new FakeDriver()
    driver.screenshotFails = true
    const result = await runScript(script([{ action: 'click', target: clickTarget }]), {
      driver,
      context: context(),
      screenshotEveryStep: true,
      saveScreenshot: async () => 'never',
    })
    expect(result.status).toBe('passed')
    expect(result.steps[0]?.screenshotId).toBeUndefined()
  })
})

describe('runScript: cancellation and budgets', () => {
  it('stops when the signal is aborted', async () => {
    const driver = new FakeDriver()
    const controller = new AbortController()
    controller.abort()
    const result = await runScript(script([{ action: 'click', target: clickTarget }]), {
      driver,
      context: context(),
      signal: controller.signal,
    })
    expect(result.status).toBe('cancelled')
    expect(driver.countOf('click')).toBe(0)
  })

  it('aborts mid-run at the next step boundary', async () => {
    const driver = new FakeDriver()
    const controller = new AbortController()
    const result = await runScript(
      script([
        { action: 'click', target: clickTarget },
        { action: 'fill', target: fieldTarget, value: 'x' },
      ]),
      {
        driver,
        context: context(),
        signal: controller.signal,
        events: {
          onStepDone: () => controller.abort(),
        },
      },
    )
    expect(result.status).toBe('cancelled')
    expect(driver.countOf('fill')).toBe(0)
  })

  it('reports exceeding the run budget as an error', async () => {
    const driver = new FakeDriver()
    const result = await runScript(
      script([
        { action: 'click', target: clickTarget },
        { action: 'fill', target: fieldTarget, value: 'x' },
      ]),
      { driver, context: context(), runTimeoutMs: -1 },
    )
    expect(result.status).toBe('error')
    expect(result.failure?.message).toContain('budget')
  })
})

describe('runScript: extraction', () => {
  it('stores extracted values under saveAs', async () => {
    const driver = new FakeDriver()
    const result = await runScript(
      script([
        {
          action: 'extract',
          target: { primary: { how: 'css', value: '.total' }, fallbacks: [] },
          extract: { kind: 'text' },
          saveAs: 'total',
        },
      ]),
      { driver, context: context() },
    )
    expect(result.extracted.total).toEqual({ kind: 'strings', values: ['fake value'] })
    expect(result.steps[0]?.extracted).toBeDefined()
  })

  it('records the extraction without saveAs too', async () => {
    const driver = new FakeDriver()
    const result = await runScript(
      script([
        {
          action: 'extract',
          target: { primary: { how: 'css', value: '.total' }, fallbacks: [] },
          extract: { kind: 'text' },
        },
      ]),
      { driver, context: context() },
    )
    expect(Object.keys(result.extracted)).toHaveLength(0)
    expect(result.steps[0]?.extracted).toBeDefined()
  })
})

describe('runScript: browser-level steps', () => {
  it('drives tabs through the driver, not the page kernel', async () => {
    const driver = new FakeDriver()
    const result = await runScript(
      script([
        { action: 'tab_new', value: 'https://app.test/other' },
        { action: 'tab_switch', value: 0 as unknown as string },
        { action: 'go_back' },
        { action: 'tab_close', value: 1 as unknown as string },
      ]),
      { driver, context: context() },
    )
    expect(result.status).toBe('passed')
    expect(driver.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining(['newTab', 'switchTab', 'goBack', 'closeTab']),
    )
  })

  it('reports refusing to close the only tab as an error', async () => {
    const driver = new FakeDriver()
    const result = await runScript(
      script([{ action: 'tab_close', value: 0 as unknown as string }]),
      { driver, context: context() },
    )
    expect(result.status).toBe('error')
    expect(result.failure?.message).toContain('only tab')
  })

  it('waits for the document after a navigating step', async () => {
    const driver = new FakeDriver().program('click', {
      kind: 'ok',
      result: { mayNavigate: true },
    })
    await runScript(script([{ action: 'click', target: clickTarget }]), {
      driver,
      context: context(),
    })
    expect(driver.waitForLoadCount).toBeGreaterThan(0)
  })
})

describe('runScript: refusing an unusable script', () => {
  it('refuses rather than half-running a script with a missing target', async () => {
    const driver = new FakeDriver()
    const result = await runScript(script([{ action: 'click' }]), { driver, context: context() })
    expect(result.status).toBe('error')
    expect(result.summary).toContain('needs a target')
    // Nothing must have been attempted: a half-run leaves the app in a bad state.
    expect(driver.calls).toHaveLength(0)
  })

  it('refuses an empty script', async () => {
    const driver = new FakeDriver()
    const result = await runScript(script([]), { driver, context: context() })
    expect(result.status).toBe('error')
    expect(result.summary).toContain('no steps')
  })
})

describe('runScript: progress events', () => {
  it('emits a start and a done event per step, in order', async () => {
    const driver = new FakeDriver()
    const events: string[] = []
    await runScript(
      script([
        { action: 'click', target: clickTarget },
        { action: 'fill', target: fieldTarget, value: 'x' },
      ]),
      {
        driver,
        context: context(),
        events: {
          onStepStart: (index) => events.push(`start:${index}`),
          onStepDone: (record) => events.push(`done:${record.index}`),
        },
      },
    )
    expect(events).toEqual(['start:-1', 'start:0', 'done:0', 'start:1', 'done:1'])
  })

  it('reports a skipped optional step through onStatus', async () => {
    const driver = new FakeDriver().program('click', { kind: 'notFound' })
    const statuses: string[] = []
    await runScript(script([{ action: 'click', target: clickTarget, optional: true }]), {
      driver,
      context: context(),
      events: { onStatus: (text) => statuses.push(text) },
    })
    expect(statuses.join(' ')).toContain('Optional step 1')
  })
})

describe('runScript: selector drift', () => {
  it('flags a step that only worked through a fallback selector', async () => {
    const driver = new FakeDriver().program('click', {
      kind: 'ok',
      result: { usedFallback: true, usedSpec: 'text|Sign in' },
    })
    const result = await runScript(script([{ action: 'click', target: clickTarget }]), {
      driver,
      context: context(),
    })
    expect(result.steps[0]?.usedFallback).toBe(true)
    expect(result.steps[0]?.usedSpec).toBe('text|Sign in')
  })
})
