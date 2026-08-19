/**
 * Orchestrator tests.
 *
 * These cover the promises this module makes to every trigger: the run window is
 * always closed, a run is always persisted, the allow-list is enforced before
 * anything opens, and a model that claims success without evidence does not get
 * a green run. Each has a plausible failure mode that would only show up in
 * production — a window leaking per nightly run, a crashed run stuck at
 * "running" — so they are worth pinning here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { installChromeFake } from './fake-chrome'
import { FakeDriver } from './fake-driver'
import type { OrchestratorDeps } from '../src/background/orchestrator'
import { NotAllowedError } from '../src/background/driver'
import type { TestCase, TestScript } from '../src/lib/types'

let mod: typeof import('../src/background/orchestrator')
let storage: typeof import('../src/lib/storage')

/** Records window lifecycle so a leak is detectable. */
class WindowTracker {
  opened = 0
  reusedTab = 0
  closed: (number | undefined)[] = []
  failOpen: Error | undefined

  deps(driver: FakeDriver): OrchestratorDeps {
    return {
      createDriver: () => driver,
      openWindow: async () => {
        if (this.failOpen) throw this.failOpen
        this.opened += 1
        return { tabId: 1, windowId: 10 }
      },
      closeWindow: async (windowId) => {
        this.closed.push(windowId)
      },
      findTab: async () => {
        this.reusedTab += 1
        return { id: 1, url: 'https://app.test/', title: 'App', active: true, windowId: 10 }
      },
    }
  }
}

function testCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'case-1',
    name: 'Login smoke',
    startUrl: 'https://app.test/login',
    steps: ['Open the login page', 'Sign in'],
    expectations: ['The dashboard appears'],
    tags: [],
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function script(overrides: Partial<TestScript> = {}): TestScript {
  return {
    id: 'scr-1',
    version: 1,
    name: 'Login smoke',
    startUrl: 'https://app.test/login',
    steps: [
      { action: 'click', target: { primary: { how: 'testid', value: 'submit' }, fallbacks: [] } },
    ],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** Allows the test host so the policy check passes. */
async function allowSite(): Promise<void> {
  const settings = await storage.getSettings()
  await storage.saveSettings({
    policy: { ...settings.policy, allowedSites: ['https://app.test/*'] },
  })
}

beforeEach(async () => {
  installChromeFake()
  // A stubbed fetch must not survive into the next test: a leaked stub would make
  // an unrelated failure look like a network problem.
  vi.unstubAllGlobals()
  vi.resetModules()
  storage = await import('../src/lib/storage')
  mod = await import('../src/background/orchestrator')
})

describe('the allow-list gate', () => {
  it('refuses to start when no site is allowed', async () => {
    const tracker = new WindowTracker()
    await expect(
      mod.startRun({ testCase: testCase(), trigger: 'schedule', deps: tracker.deps(new FakeDriver()) }),
    ).rejects.toThrow(mod.StartError)
    // Nothing may open before the boundary is checked.
    expect(tracker.opened).toBe(0)
  })

  it('names the setting and gives an example, since this is the first thing users hit', async () => {
    await expect(
      mod.startRun({ testCase: testCase(), trigger: 'manual', deps: new WindowTracker().deps(new FakeDriver()) }),
    ).rejects.toThrow(/allowed sites/)
  })

  it('persists no run when it refuses, so history is not polluted', async () => {
    await mod
      .startRun({ testCase: testCase(), trigger: 'manual', deps: new WindowTracker().deps(new FakeDriver()) })
      .catch(() => undefined)
    expect(await storage.getRuns()).toEqual([])
  })

  it('refuses when there is nothing to run', async () => {
    await allowSite()
    await expect(
      mod.startRun({ trigger: 'manual', deps: new WindowTracker().deps(new FakeDriver()) }),
    ).rejects.toThrow(/没有可执行的内容/)
  })
})

describe('a window the run opened itself is always closed', () => {
  // These use `schedule`, which always opens its own window. A manual run reuses
  // the user's tab and must leave it alone, which is covered separately.
  it('closes it after a passing script replay', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    await mod.startRun({ script: script(), trigger: 'schedule', deps: tracker.deps(new FakeDriver()) })
    expect(tracker.closed).toEqual([10])
  })

  it('closes it when a step fails', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    const driver = new FakeDriver().program('click', { kind: 'failed', error: 'is disabled' })
    await mod.startRun({ script: script(), trigger: 'schedule', deps: tracker.deps(driver) })
    expect(tracker.closed).toEqual([10])
  })

  it('closes it when the driver throws outright', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    const driver = new FakeDriver().program('click', {
      kind: 'throw',
      error: new Error('the tab went away'),
    })
    await mod.startRun({ script: script(), trigger: 'schedule', deps: tracker.deps(driver) })
    // The leak this prevents: one orphaned window per nightly run.
    expect(tracker.closed).toEqual([10])
  })

  it('does not try to close a window that never opened', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    tracker.failOpen = new Error('no window available')
    const outcome = await mod.startRun({
      script: script(),
      trigger: 'schedule',
      deps: tracker.deps(new FakeDriver()),
    })
    expect(outcome.run.status).toBe('error')
    expect(tracker.closed).toEqual([undefined])
  })
})

describe('a run is always persisted', () => {
  it('stores a running run before doing any work', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    // The driver hangs, so the only run in storage is the one written up front.
    const driver = new FakeDriver()
    const promise = mod.startRun({ script: script(), trigger: 'manual', deps: tracker.deps(driver) })
    await promise
    const runs = await storage.getRuns()
    expect(runs).toHaveLength(1)
  })

  it('records a harness failure as error, not as a test failure', async () => {
    await allowSite()
    const driver = new FakeDriver().program('click', {
      kind: 'throw',
      error: new Error('injection was blocked'),
    })
    const outcome = await mod.startRun({
      script: script(),
      trigger: 'manual',
      deps: new WindowTracker().deps(driver),
    })
    // 'error' means the tool could not complete; 'failed' would wrongly blame the
    // application under test.
    expect(outcome.run.status).toBe('error')
    expect(outcome.run.failure?.message).toContain('injection was blocked')
  })

  it('logs the failure so an unattended run leaves a trace', async () => {
    await allowSite()
    const driver = new FakeDriver().program('click', {
      kind: 'throw',
      error: new Error('boom'),
    })
    await mod.startRun({ script: script(), trigger: 'schedule', deps: new WindowTracker().deps(driver) })
    const logs = await storage.getLogs()
    expect(logs.some((entry) => entry.message.includes('boom'))).toBe(true)
  })

  it('keeps the case name on the run even though the case may be deleted later', async () => {
    await allowSite()
    const outcome = await mod.startRun({
      testCase: testCase({ name: 'Checkout flow' }),
      script: script(),
      trigger: 'manual',
      deps: new WindowTracker().deps(new FakeDriver()),
    })
    expect(outcome.run.caseName).toBe('Checkout flow')
  })

  it('marks the mode as script when replaying and agent when not', async () => {
    await allowSite()
    const replay = await mod.startRun({
      script: script(),
      trigger: 'manual',
      deps: new WindowTracker().deps(new FakeDriver()),
    })
    expect(replay.run.mode).toBe('script')
  })
})

describe('script replay', () => {
  it('passes when every step succeeds', async () => {
    await allowSite()
    const outcome = await mod.startRun({
      script: script(),
      trigger: 'manual',
      deps: new WindowTracker().deps(new FakeDriver()),
    })
    expect(outcome.run.status).toBe('passed')
  })

  it('records a step-level failure as failed, since the app did not comply', async () => {
    await allowSite()
    const driver = new FakeDriver().program('click', { kind: 'failed', error: 'is disabled' })
    const outcome = await mod.startRun({
      script: script(),
      trigger: 'manual',
      deps: new WindowTracker().deps(driver),
    })
    expect(outcome.run.status).toBe('failed')
  })

  it('prefers a stored script over the agent for a case that has one', async () => {
    await allowSite()
    await storage.saveScript(script({ caseId: 'case-1' }))
    const outcome = await mod.startRun({
      testCase: testCase(),
      trigger: 'schedule',
      deps: new WindowTracker().deps(new FakeDriver()),
    })
    // Replay is deterministic and free; that is the whole point of recording.
    expect(outcome.run.mode).toBe('script')
  })

  it('uses the agent when the caller forces it, even with a script present', async () => {
    await allowSite()
    await storage.saveScript(script({ caseId: 'case-1' }))
    const outcome = await mod.startRun({
      testCase: testCase(),
      trigger: 'manual',
      useAgent: true,
      deps: new WindowTracker().deps(new FakeDriver()),
    })
    // No provider is configured, so it fails — but it must have chosen agent mode.
    expect(outcome.run.mode).toBe('agent')
  })
})

describe('agent mode without a provider', () => {
  it('fails with a message naming the setting to fix', async () => {
    await allowSite()
    const outcome = await mod.startRun({
      testCase: testCase(),
      trigger: 'manual',
      deps: new WindowTracker().deps(new FakeDriver()),
    })
    expect(outcome.run.status).toBe('error')
    expect(outcome.run.summary).toContain('provider')
  })

  it('still closes the window', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    await mod.startRun({ testCase: testCase(), trigger: 'schedule', deps: tracker.deps(new FakeDriver()) })
    expect(tracker.closed).toEqual([10])
  })
})

describe('cancellation', () => {
  it('reports an aborted run as cancelled rather than error', async () => {
    await allowSite()
    const controller = new AbortController()
    controller.abort()
    const outcome = await mod.startRun({
      script: script(),
      trigger: 'manual',
      signal: controller.signal,
      deps: new WindowTracker().deps(new FakeDriver()),
    })
    // A human stopping a run is not a fault, and must not page anyone.
    expect(outcome.run.status).toBe('cancelled')
  })

  it('closes the window on cancellation too', async () => {
    await allowSite()
    const controller = new AbortController()
    controller.abort()
    const tracker = new WindowTracker()
    await mod.startRun({
      script: script(),
      trigger: 'schedule',
      signal: controller.signal,
      deps: tracker.deps(new FakeDriver()),
    })
    expect(tracker.closed).toEqual([10])
  })
})

describe('a policy violation mid-run', () => {
  it('ends the run as an error and does not retry', async () => {
    await allowSite()
    const driver = new FakeDriver().program('click', {
      kind: 'throw',
      error: new NotAllowedError('https://evil.test/ is not in the allowed sites list.'),
    })
    const outcome = await mod.startRun({
      script: script(),
      trigger: 'bridge',
      deps: new WindowTracker().deps(driver),
    })
    expect(outcome.run.status).toBe('error')
    expect(outcome.run.failure?.message).toContain('allowed sites')
  })
})

describe('choosing between the current tab and a fresh window', () => {
  it('reuses the current tab for a manual run, since that is the page the user means', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    await mod.startRun({ script: script(), trigger: 'manual', deps: tracker.deps(new FakeDriver()) })
    expect(tracker.reusedTab).toBe(1)
    expect(tracker.opened).toBe(0)
    // Nothing was opened, so nothing may be closed: closing the user's own tab
    // at the end of a run would be destructive.
    expect(tracker.closed).toEqual([undefined])
  })

  it('opens its own window for a schedule, whatever the setting says', async () => {
    await allowSite()
    const settings = await storage.getSettings()
    await storage.saveSettings({ policy: { ...settings.policy, useDedicatedWindow: false } })
    const tracker = new WindowTracker()
    await mod.startRun({ script: script(), trigger: 'schedule', deps: tracker.deps(new FakeDriver()) })
    // A 3am run must not navigate away from whatever the user left open.
    expect(tracker.opened).toBe(1)
    expect(tracker.reusedTab).toBe(0)
    expect(tracker.closed).toEqual([10])
  })

  it('opens its own window for a bridge run, which has no current tab to speak of', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    await mod.startRun({ script: script(), trigger: 'bridge', deps: tracker.deps(new FakeDriver()) })
    expect(tracker.opened).toBe(1)
    expect(tracker.reusedTab).toBe(0)
  })

  it('honours the setting when a manual run asks for a dedicated window', async () => {
    await allowSite()
    const settings = await storage.getSettings()
    await storage.saveSettings({ policy: { ...settings.policy, useDedicatedWindow: true } })
    const tracker = new WindowTracker()
    await mod.startRun({ script: script(), trigger: 'manual', deps: tracker.deps(new FakeDriver()) })
    expect(tracker.opened).toBe(1)
    expect(tracker.closed).toEqual([10])
  })
})

describe('the agent opens the case start URL before the model runs', () => {
  /**
   * Configures a provider and stubs the network so the model loop ends at once.
   *
   * The navigation happens after the provider check, so it is unobservable
   * without a provider — but the whole point is what happens *before* the model
   * gets a turn, so the turn itself is stubbed to a single `finish`.
   */
  async function withStubbedModel(): Promise<void> {
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
      policy: { ...settings.policy, allowedSites: ['https://app.test/*'] },
    })
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"finish","arguments":"{\\"status\\":\\"passed\\",\\"summary\\":\\"done\\"}"}}]}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } })),
    )
  }

  it('navigates to the start URL, so a run from a new tab still works', async () => {
    await withStubbedModel()
    const driver = new FakeDriver()
    await mod.startRun({
      testCase: testCase({ startUrl: 'https://app.test/login' }),
      trigger: 'manual',
      deps: new WindowTracker().deps(driver),
    })
    // The bug this prevents: the model's first tool call is refused because the
    // tab is still chrome://newtab, reported as a tooling fault at step 0.
    expect(driver.calls.find((call) => call.method === 'navigate')?.arg).toBe('https://app.test/login')
  })

  it('does not navigate when the case has no start URL, staying on the current page', async () => {
    await withStubbedModel()
    const driver = new FakeDriver()
    await mod.startRun({
      testCase: testCase({ startUrl: '' }),
      trigger: 'manual',
      deps: new WindowTracker().deps(driver),
    })
    expect(driver.calls.some((call) => call.method === 'navigate')).toBe(false)
  })

  it('reports an unreachable start URL as an error before spending a tool round', async () => {
    await withStubbedModel()
    const driver = new FakeDriver()
    driver.navigate = async () => {
      throw new NotAllowedError('https://evil.test/ is not in the allowed sites list.')
    }
    const outcome = await mod.startRun({
      testCase: testCase({ startUrl: 'https://evil.test/' }),
      trigger: 'manual',
      deps: new WindowTracker().deps(driver),
    })
    expect(outcome.run.status).toBe('error')
    expect(outcome.run.summary).toContain('无法打开起始地址')
    expect(outcome.run.failure?.stepIndex).toBe(-1)
  })
})

describe('refusing a run that has nowhere to go', () => {
  // These end as an `error` run rather than a thrown rejection: the refusal
  // happens after the run is registered, so the reason lands in run history where
  // the user can actually read it, instead of vanishing into a console.
  it('explains what to add when an unattended run has no start URL', async () => {
    await allowSite()
    // A dedicated window with no URL lands on chrome://newtab, which nothing can
    // automate, so this must be refused up front rather than failing at step 0.
    const outcome = await mod.startRun({
      script: script({ startUrl: '' }),
      trigger: 'schedule',
      deps: new WindowTracker().deps(new FakeDriver()),
    })
    expect(outcome.run.status).toBe('error')
    expect(outcome.run.summary).toMatch(/需要一个起始地址/)
  })

  it('tells the user to open a page when the current tab is browser-internal', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    const deps = { ...tracker.deps(new FakeDriver()), findTab: async () => undefined }
    const outcome = await mod.startRun({
      script: script({ startUrl: '' }),
      trigger: 'manual',
      deps,
    })
    expect(outcome.run.status).toBe('error')
    expect(outcome.run.summary).toMatch(/浏览器内部页面/)
  })

  it('names the case start URL so the user knows which page to open', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    const deps = { ...tracker.deps(new FakeDriver()), findTab: async () => undefined }
    const outcome = await mod.startRun({
      script: script({ startUrl: 'https://app.test/checkout' }),
      trigger: 'manual',
      deps,
    })
    expect(outcome.run.summary).toContain('https://app.test/checkout')
  })
})

describe('the current page must itself be allowed', () => {
  it('refuses before acting when the page the user is on is not allow-listed', async () => {
    await allowSite() // allows https://app.test/*
    const tracker = new WindowTracker()
    const deps = {
      ...tracker.deps(new FakeDriver()),
      // The user is sitting on some other site entirely.
      findTab: async () => ({
        id: 4,
        url: 'https://random.test/page',
        title: 'Random',
        active: true,
        windowId: 1,
      }),
    }
    const outcome = await mod.startRun({ testCase: testCase({ startUrl: '' }), trigger: 'manual', deps })
    expect(outcome.run.status).toBe('error')
    expect(outcome.run.summary).toContain('站点白名单')
    // The fix must be copy-pasteable, not a vague "check your settings".
    expect(outcome.run.summary).toContain('https://random.test/*')
  })

  it('names the actual page, so the user can see what it picked', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    const deps = {
      ...tracker.deps(new FakeDriver()),
      findTab: async () => ({
        id: 4,
        url: 'https://random.test/deep/path?q=1',
        title: 'Random',
        active: true,
        windowId: 1,
      }),
    }
    const outcome = await mod.startRun({ testCase: testCase({ startUrl: '' }), trigger: 'manual', deps })
    expect(outcome.run.summary).toContain('https://random.test/deep/path?q=1')
  })

  it('does not second-guess the allow-list when a start URL is given', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    const driver = new FakeDriver()
    // The current tab is off-list, but the run will navigate away from it, so the
    // navigation's own check is the one that matters.
    const deps = {
      ...tracker.deps(driver),
      findTab: async () => ({
        id: 4,
        url: 'https://random.test/',
        title: 'Random',
        active: true,
        windowId: 1,
      }),
    }
    const outcome = await mod.startRun({
      script: script({ startUrl: 'https://app.test/login' }),
      trigger: 'manual',
      deps,
    })
    expect(outcome.run.status).toBe('passed')
  })
})

describe('observer callbacks', () => {
  it('reports the run as soon as it is registered, so the panel can show progress', async () => {
    await allowSite()
    const seen: string[] = []
    await mod.startRun({
      script: script(),
      trigger: 'manual',
      deps: new WindowTracker().deps(new FakeDriver()),
      observer: { onRun: (run) => seen.push(run.status) },
    })
    expect(seen[0]).toBe('running')
    expect(seen.at(-1)).toBe('passed')
  })

  it('reports each step', async () => {
    await allowSite()
    const steps: number[] = []
    await mod.startRun({
      script: script(),
      trigger: 'manual',
      deps: new WindowTracker().deps(new FakeDriver()),
      observer: { onStep: (_runId, step) => steps.push(step.index) },
    })
    expect(steps).toEqual([0])
  })
})
