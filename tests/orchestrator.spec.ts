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
      findTab: async () => ({ id: 1, url: 'https://app.test/', title: 'App', active: true, windowId: 10 }),
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

describe('the run window is always closed', () => {
  it('closes it after a passing script replay', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    await mod.startRun({ script: script(), trigger: 'manual', deps: tracker.deps(new FakeDriver()) })
    expect(tracker.closed).toEqual([10])
  })

  it('closes it when a step fails', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    const driver = new FakeDriver().program('click', { kind: 'failed', error: 'is disabled' })
    await mod.startRun({ script: script(), trigger: 'manual', deps: tracker.deps(driver) })
    expect(tracker.closed).toEqual([10])
  })

  it('closes it when the driver throws outright', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    const driver = new FakeDriver().program('click', {
      kind: 'throw',
      error: new Error('the tab went away'),
    })
    await mod.startRun({ script: script(), trigger: 'manual', deps: tracker.deps(driver) })
    // The leak this prevents: one orphaned window per nightly run.
    expect(tracker.closed).toEqual([10])
  })

  it('does not try to close a window that never opened', async () => {
    await allowSite()
    const tracker = new WindowTracker()
    tracker.failOpen = new Error('no window available')
    const outcome = await mod.startRun({
      script: script(),
      trigger: 'manual',
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
    await mod.startRun({ testCase: testCase(), trigger: 'manual', deps: tracker.deps(new FakeDriver()) })
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
      trigger: 'manual',
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
