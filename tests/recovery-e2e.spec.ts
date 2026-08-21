/**
 * End-to-end recovery through the real orchestrator.
 *
 * The helpers are unit-tested in `recovery.spec.ts`; this file drives the actual
 * `startRun` path with a scripted model, because the guarantees that matter are
 * emergent — they depend on the runner, the orchestrator and the agent agreeing,
 * and a mistake in the wiring between them would pass every unit test.
 *
 * Above all this pins the one failure that would be unforgivable in a tool that
 * clicks real buttons: **a recovery run must never repeat a step the replay already
 * performed.** If the replay placed an order and the agent places it again, the
 * tool has done real damage to a real system.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { installChromeFake } from './fake-chrome'
import { FakeDriver } from './fake-driver'
import type { OrchestratorDeps } from '../src/background/orchestrator'
import type { TestCase, TestScript } from '../src/lib/types'

let mod: typeof import('../src/background/orchestrator')
let storage: typeof import('../src/lib/storage')

/** Deps that always find a usable tab and never open one. */
function deps(driver: FakeDriver): OrchestratorDeps {
  return {
    createDriver: () => driver,
    openTab: async () => ({ tabId: 1, windowId: 10 }),
    closeTab: async () => {},
    findTab: async () => ({ id: 1, url: 'https://app.test/cart', title: 'Cart', active: true, windowId: 10 }),
  }
}

/**
 * Stubs the model as a fixed sequence of tool-call rounds.
 *
 * Each entry is one assistant turn. Written as raw SSE because that is what the
 * real client parses — going through the wire format keeps this honest about
 * streaming and `[DONE]` handling instead of mocking the parsed result.
 *
 * Returns accessors for the call count *and* the request bodies: what the model was
 * actually told is a behaviour worth asserting, since the prompt is the only thing
 * standing between a recovery run and a duplicate order.
 */
function stubModel(rounds: { name: string; args: Record<string, unknown> }[]): {
  calls: () => number
  prompts: () => string[]
  /** The first user message, JSON-decoded, so per-line assertions are possible. */
  instruction: () => string
} {
  let call = 0
  const bodies: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      if (typeof init?.body === 'string') bodies.push(init.body)
      const round = rounds[Math.min(call, rounds.length - 1)]
      call += 1
      const payload = JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `c${call}`,
                  type: 'function',
                  function: { name: round!.name, arguments: JSON.stringify(round!.args) },
                },
              ],
            },
          },
        ],
      })
      const sse = [`data: ${payload}`, '', 'data: [DONE]', ''].join('\n')
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    }),
  )
  return {
    calls: () => call,
    prompts: () => bodies,
    // Decoded, because the raw body escapes newlines as literal `\n`: a `.*` in a
    // regex then happily matches across what look like separate lines, which is
    // exactly how a mutation that named the WRONG failed step slipped past an
    // assertion written against the raw string.
    instruction: () => {
      const body = JSON.parse(bodies[0] ?? '{}') as { messages?: { role: string; content: string }[] }
      return body.messages?.find((message) => message.role === 'user')?.content ?? ''
    },
  }
}

async function configure(overrides: Record<string, unknown> = {}): Promise<void> {
  const settings = await storage.getSettings()
  await storage.saveSettings({
    providers: [
      {
        id: 'p1',
        label: 'Stub',
        presetId: 'custom',
        baseUrl: 'https://stub.test/v1',
        model: 'stub-1',
        apiKey: 'k',
      },
    ],
    activeProviderId: 'p1',
    policy: {
      ...settings.policy,
      allowedSites: ['https://app.test/*'],
      resumeOnFailure: ['manual'],
      ...overrides,
    },
  })
}

/** A checkout case: the steps have real-world side effects. */
function checkoutCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'case-1',
    name: 'Checkout',
    startUrl: 'https://app.test/cart',
    steps: ['Fill the card number', 'Place the order', 'Check the receipt'],
    expectations: ['The receipt shows an order number'],
    tags: [],
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/**
 * A script whose third step fails.
 *
 * `fill` and `click` succeed — so the order really is placed — and the final
 * assertion is the one that breaks, which is exactly the shape that makes a naive
 * "just run the test again" recovery dangerous.
 */
function checkoutScript(overrides: Partial<TestScript> = {}): TestScript {
  return {
    id: 'scr-1',
    caseId: 'case-1',
    version: 1,
    name: 'Checkout',
    startUrl: 'https://app.test/cart',
    steps: [
      { action: 'fill', target: { primary: { how: 'testid', value: 'card' }, fallbacks: [] }, value: '4242' },
      { action: 'click', target: { primary: { how: 'testid', value: 'place-order' }, fallbacks: [] } },
      {
        action: 'assert',
        target: { primary: { how: 'testid', value: 'receipt' }, fallbacks: [] },
        assert: { kind: 'text', expected: 'Thank you' },
      },
    ],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

beforeEach(async () => {
  installChromeFake()
  vi.resetModules()
  vi.unstubAllGlobals()
  storage = await import('../src/lib/storage')
  mod = await import('../src/background/orchestrator')
})

describe('a replay fails and the agent finishes the case', () => {
  it('never repeats the steps the replay already performed', async () => {
    await configure()
    // The assertion fails; fill and click already succeeded for real.
    const driver = new FakeDriver().program('assert', { kind: 'failed', error: 'no element matched' })
    stubModel([
      { name: 'diagnose', args: { cause: 'stale_selector', diagnosis: 'Receipt moved.', proposal: 'Assert the new node.' } },
      { name: 'finish', args: { status: 'passed', summary: 'Receipt shows order #1001.' } },
    ])

    await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'manual',
      deps: deps(driver),
    })

    // THE guarantee: the order-placing click happened exactly once, during the
    // replay. A second one would be a duplicate order in a real system.
    expect(driver.countOf('click')).toBe(1)
    expect(driver.countOf('fill')).toBe(1)
  })

  it('does not re-navigate to the start URL, which would discard the session', async () => {
    await configure()
    const driver = new FakeDriver().program('assert', { kind: 'failed', error: 'no element matched' })
    stubModel([
      { name: 'diagnose', args: { cause: 'stale_selector', diagnosis: 'x', proposal: 'y' } },
      { name: 'finish', args: { status: 'passed', summary: 'ok' } },
    ])

    await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'manual',
      deps: deps(driver),
    })

    // The replay navigates once. Recovery must not do it again: the cart and the
    // login live in that page's state, and reloading would throw them away.
    //
    // Counted by driver method rather than `countOf('open_url')`, which only sees
    // ops — a navigation is recorded as `method: 'navigate'` with no op, so counting
    // ops here would report 0 no matter what the code did.
    const navigations = driver.calls.filter((call) => call.method === 'navigate')
    expect(navigations).toHaveLength(1)
    expect(navigations[0]?.arg).toBe('https://app.test/cart')
  })

  it('tells the model which steps already happened, and not to repeat them', async () => {
    await configure()
    const driver = new FakeDriver().program('assert', { kind: 'failed', error: 'no element matched' })
    const model = stubModel([
      { name: 'diagnose', args: { cause: 'stale_selector', diagnosis: 'x', proposal: 'y' } },
      { name: 'finish', args: { status: 'passed', summary: 'ok' } },
    ])

    await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'manual',
      deps: deps(driver),
    })

    // Asserted against the real request body, because the prompt IS the mechanism:
    // that "do not do them again" list is the only thing preventing a second order.
    // A test checking just the final status would still pass if recovery were handed
    // the plain case description and cheerfully re-ran step one.
    const prompt = model.prompts()[0] ?? ''
    expect(prompt).toContain('do NOT do them again')
    expect(prompt).toContain('Never repeat an action')
    // The failed step is named, and the ones that really ran are marked done.
    expect(prompt).toContain('Step 3 is where it stopped')
    expect(prompt).toContain('done')
    // The case's expectations travel with it, so the verdict still has a bar.
    expect(prompt).toContain('The receipt shows an order number')
  })

  it('identifies the failed step by its index', async () => {
    await configure()
    const driver = new FakeDriver().program(
      'assert',
      { kind: 'failed', error: 'no element matched' },
      { kind: 'ok' },
    )
    const model = stubModel([
      { name: 'diagnose', args: { cause: 'stale_selector', diagnosis: 'x', proposal: 'y' } },
      { name: 'assert', args: { kind: 'url', expected: 'app.test' } },
      { name: 'finish', args: { status: 'passed', summary: 'ok' } },
    ])

    const outcome = await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'manual',
      deps: deps(driver),
    })

    // Step 3 (index 2) is the assertion that broke — never step 1 or 2, which really
    // did run. Naming the wrong one would tell the model to redo the order.
    expect(outcome.run.recovery?.failedAtStep).toBe(2)

    // Matched on the exact line, so this cannot pass by finding the word "assert"
    // somewhere else in the prompt.
    const line = model
      .instruction()
      .split('\n')
      .find((text) => text.startsWith('Step 3 is where it stopped:'))
    expect(line).toBeDefined()
    expect(line).toContain('assert')
    // The order-placing click is emphatically not the failure.
    expect(line).not.toContain('click')
  })

  it('reports recovered, not passed, so the broken script is visible', async () => {
    await configure()
    // The replay's assertion fails; the agent's later one succeeds, which is the
    // realistic shape of a stale selector on a working page.
    const driver = new FakeDriver().program(
      'assert',
      { kind: 'failed', error: 'no element matched' },
      { kind: 'ok' },
    )
    stubModel([
      { name: 'diagnose', args: { cause: 'stale_selector', diagnosis: 'Receipt moved.', proposal: 'Continue.' } },
      // The agent must actually re-assert the expectation: `validateVerdict` holds
      // recovery to the same bar as any other run, so a bare claim is not enough.
      // A `url` assertion needs no ref, which keeps this test about the recovery
      // decision rather than about ref bookkeeping.
      { name: 'assert', args: { kind: 'url', expected: 'app.test' } },
      { name: 'finish', args: { status: 'passed', summary: 'Receipt shows order #1001.' } },
    ])

    const outcome = await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'manual',
      deps: deps(driver),
    })
    expect(outcome.run.status).toBe('recovered')
  })

  it('records what broke and what the model made of it', async () => {
    await configure()
    const driver = new FakeDriver().program('assert', { kind: 'failed', error: 'no element matched' })
    stubModel([
      {
        name: 'diagnose',
        args: {
          cause: 'stale_selector',
          diagnosis: 'The receipt is now in a dialog.',
          proposal: 'Assert inside the dialog.',
          suggestedFix: 'Target data-testid="receipt-dialog".',
        },
      },
      { name: 'finish', args: { status: 'passed', summary: 'ok' } },
    ])

    const outcome = await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'manual',
      deps: deps(driver),
    })

    const recovery = outcome.run.recovery
    expect(recovery?.failedAtStep).toBe(2)
    expect(recovery?.cause).toBe('selector')
    expect(recovery?.diagnosis).toContain('dialog')
    // The actionable part: what a human should change in the saved script.
    expect(recovery?.suggestedFix?.note).toContain('receipt-dialog')
    expect(recovery?.resumed).toBe(true)
  })

  it('keeps the replay steps in the stored history, so the run reads as one story', async () => {
    await configure()
    const driver = new FakeDriver().program('assert', { kind: 'failed', error: 'no element matched' })
    stubModel([
      { name: 'diagnose', args: { cause: 'stale_selector', diagnosis: 'x', proposal: 'y' } },
      { name: 'finish', args: { status: 'passed', summary: 'ok' } },
    ])

    const outcome = await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'manual',
      deps: deps(driver),
    })

    const descriptions = outcome.run.steps.map((s) => s.description).join(' | ')
    expect(descriptions).toContain('fill')
    expect(outcome.run.steps.length).toBeGreaterThan(2)
  })
})

describe('recovery does not lower the bar for a pass', () => {
  it('rejects a claimed pass that asserted nothing', async () => {
    await configure()
    const driver = new FakeDriver().program('assert', { kind: 'failed', error: 'no element matched' })
    // The model claims success without ever asserting the expectation.
    stubModel([
      { name: 'diagnose', args: { cause: 'stale_selector', diagnosis: 'x', proposal: 'y' } },
      { name: 'finish', args: { status: 'passed', summary: 'Looks fine to me.' } },
    ])

    const outcome = await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'manual',
      deps: deps(driver),
    })

    // validateVerdict still applies: an unverified claim is not a pass, and
    // therefore not a recovery either.
    expect(outcome.run.status).toBe('failed')
    expect(outcome.run.summary).toMatch(/驳回|rejected|assertion/i)
  })

  it('stays failed when the agent agrees the application is broken', async () => {
    await configure()
    const driver = new FakeDriver().program('assert', {
      kind: 'failed',
      error: '<button> "Place order" is disabled, so it cannot be clicked.',
    })
    stubModel([
      { name: 'diagnose', args: { cause: 'application_bug', diagnosis: 'The button is disabled.', proposal: 'Cannot continue.' } },
      { name: 'finish', args: { status: 'failed', summary: 'The order cannot be placed.' } },
    ])

    const outcome = await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'manual',
      deps: deps(driver),
    })

    // A real finding must survive recovery untouched.
    expect(outcome.run.status).toBe('failed')
    expect(outcome.run.recovery?.cause).toBe('application')
  })
})

describe('the per-trigger gate, end to end', () => {
  it('does not recover a scheduled run under the default policy', async () => {
    await configure()
    const driver = new FakeDriver().program('assert', { kind: 'failed', error: 'no element matched' })
    const model = stubModel([{ name: 'finish', args: { status: 'passed', summary: 'ok' } }])

    const outcome = await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'schedule',
      deps: deps(driver),
    })

    expect(outcome.run.status).toBe('failed')
    // The decisive check: no model call at all, so an unattended run costs nothing
    // extra and reports the honest failure.
    expect(model.calls()).toBe(0)
  })

  it('recovers a scheduled run once an operator opts in', async () => {
    await configure({ resumeOnFailure: ['manual', 'schedule'] })
    const driver = new FakeDriver().program(
      'assert',
      { kind: 'failed', error: 'no element matched' },
      { kind: 'ok' },
    )
    stubModel([
      { name: 'diagnose', args: { cause: 'stale_selector', diagnosis: 'x', proposal: 'y' } },
      { name: 'assert', args: { kind: 'url', expected: 'app.test' } },
      { name: 'finish', args: { status: 'passed', summary: 'ok' } },
    ])

    const outcome = await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'schedule',
      deps: deps(driver),
    })
    expect(outcome.run.status).toBe('recovered')
  })

  it('leaves a harness error alone rather than resuming into a broken environment', async () => {
    await configure()
    const driver = new FakeDriver()
    driver.exec = async () => {
      throw new Error('the tab went away')
    }
    const model = stubModel([{ name: 'finish', args: { status: 'passed', summary: 'ok' } }])

    const outcome = await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'manual',
      deps: deps(driver),
    })

    expect(outcome.run.status).toBe('error')
    // Resuming into a dead tab would just fail again, slower and for money.
    expect(model.calls()).toBe(0)
  })

  it('reports the original failure when no provider is configured', async () => {
    const settings = await storage.getSettings()
    await storage.saveSettings({
      policy: { ...settings.policy, allowedSites: ['https://app.test/*'], resumeOnFailure: ['manual'] },
    })
    const driver = new FakeDriver().program('assert', { kind: 'failed', error: 'no element matched' })

    const outcome = await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'manual',
      deps: deps(driver),
    })

    // A missing provider must not turn a real test failure into a setup error.
    expect(outcome.run.status).toBe('failed')
    expect(outcome.run.recovery).toBeUndefined()
  })

  it('does not attempt recovery for a script run with no case behind it', async () => {
    await configure()
    const driver = new FakeDriver().program('assert', { kind: 'failed', error: 'no element matched' })
    const model = stubModel([{ name: 'finish', args: { status: 'passed', summary: 'ok' } }])

    const outcome = await mod.startRun({
      script: checkoutScript(),
      trigger: 'manual',
      deps: deps(driver),
    })

    // Without a case there are no expectations, so there is nothing to finish
    // honestly against.
    expect(outcome.run.status).toBe('failed')
    expect(model.calls()).toBe(0)
  })
})

describe('a recovery run does not overwrite the saved script', () => {
  it('suggests a fix instead of silently rewriting the recording', async () => {
    await configure({ autoSaveScript: true })
    // The recovery must actually *do* something recordable and reach a real pass,
    // otherwise auto-save could never trigger and this test would prove nothing:
    // the replay's assert fails, then the agent asserts successfully.
    const driver = new FakeDriver().program(
      'assert',
      { kind: 'failed', error: 'no element matched' },
      { kind: 'ok' },
    )
    stubModel([
      { name: 'diagnose', args: { cause: 'stale_selector', diagnosis: 'x', proposal: 'y', suggestedFix: 'use data-testid' } },
      { name: 'assert', args: { kind: 'url', expected: 'app.test' } },
      { name: 'finish', args: { status: 'passed', summary: 'ok' } },
    ])

    const before = await storage.getScripts()
    const outcome = await mod.startRun({
      testCase: checkoutCase(),
      script: checkoutScript(),
      trigger: 'manual',
      deps: deps(driver),
    })
    const after = await storage.getScripts()

    // Guard the premise: without a recovered pass and a populated recorder, the
    // auto-save branch is unreachable and the assertions below are vacuous.
    expect(outcome.run.status).toBe('recovered')

    // A recovery run's actions are a repair of one broken step, not a recording of
    // the whole journey — the earlier steps happened during the replay and were
    // never recorded here, so saving this would produce a script that starts in the
    // middle. The fix stays a proposal for a human.
    expect(after.length).toBe(before.length)
    expect(outcome.recordedScript).toBeUndefined()
    expect(outcome.run.recovery?.suggestedFix).toBeDefined()
  })
})
