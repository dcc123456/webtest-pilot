/**
 * Cancellation, end to end through `startRun`.
 *
 * Unit-testing the abort helpers is not enough for the guarantee that matters, which
 * is a *product* claim: pressing 取消 stops the run promptly and the result is
 * recorded as `cancelled` — not `error`, not `failed`.
 *
 * That distinction is the fault-attribution rule the whole tool rests on:
 *
 * - `failed` — the application was not in the state the test expects.
 * - `error` — the harness could not proceed. Nothing was learned about the app.
 * - `cancelled` — a human chose to stop. Not a fault at all.
 *
 * Misfiling a cancellation as `error` puts an orange run in the report and sends
 * someone looking for a broken selector that does not exist. Misfiling it as
 * `failed` is worse: it accuses the application.
 *
 * The runs here are driven through real SSE and a driver that is deliberately slow,
 * because the original bug was invisible to a fast fake: the signal reached the model
 * call, but not the polling loop where a run spends its time.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrchestratorDeps } from '../src/background/orchestrator'
import type { RunContext } from '../src/background/driver'
import type { Op, OpResult } from '../src/lib/ops'
import { installChromeFake } from './fake-chrome'
import { FakeDriver } from './fake-driver'
import type { TestCase, TestScript } from '../src/lib/types'

let mod: typeof import('../src/background/orchestrator')
let storage: typeof import('../src/lib/storage')

/**
 * A driver whose element lookups never resolve.
 *
 * This is the shape of a real slow page, and the only way to exercise the loop the
 * bug lived in. `waitFor` here delegates to the real polling contract: it must notice
 * `context.signal` rather than grinding on until the step timeout.
 */
class SlowDriver extends FakeDriver {
  waitForCalls = 0

  override async waitFor(context: RunContext, _op: Op, timeoutMs: number): Promise<OpResult> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      this.waitForCalls += 1
      const { throwIfCancelled, sleepUnlessCancelled } = await import('../src/background/driver')
      throwIfCancelled(context.signal)
      if (Date.now() >= deadline) {
        return { ok: false, found: false, frameUrl: 'https://app.test/', isTopFrame: true }
      }
      await sleepUnlessCancelled(50, context.signal)
    }
  }
}

function deps(driver: FakeDriver): OrchestratorDeps {
  return {
    createDriver: () => driver,
    openTab: async () => ({ tabId: 1, windowId: 10 }),
    closeTab: async () => {},
    findTab: async () => ({
      id: 1,
      url: 'https://app.test/cart',
      title: 'Cart',
      active: true,
      windowId: 10,
    }),
  }
}

/** Streams one tool call per request, slowly enough to be cancelled mid-flight. */
function stubSlowModel(perChunkMs = 40): { calls: () => number } {
  let call = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
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
                  function: {
                    name: 'wait_for',
                    arguments: JSON.stringify({ ref: 'e1', text: 'never' }),
                  },
                },
              ],
            },
          },
        ],
      })
      const chunks = [`data: ${payload}\n\n`, 'data: [DONE]\n\n']
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder()
          for (const chunk of chunks) {
            // Honours the caller's signal, like a real fetch: without this the test
            // would pass even if the orchestrator forgot to pass one along.
            if (init?.signal?.aborted) {
              controller.error(new DOMException('Aborted', 'AbortError'))
              return
            }
            await new Promise((resolve) => setTimeout(resolve, perChunkMs))
            controller.enqueue(encoder.encode(chunk))
          }
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }),
  )
  return { calls: () => call }
}

/** Streams a single `snapshot` tool call, immediately, for tool-path tests. */
function stubSnapshotModel(): void {
  let call = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
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
                  function: { name: 'snapshot', arguments: '{}' },
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
}

async function configure(): Promise<void> {
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
}

function slowCase(): TestCase {
  return {
    id: 'case-1',
    name: 'Slow page',
    startUrl: 'https://app.test/cart',
    steps: ['Wait for something that never appears'],
    expectations: ['It appears'],
    tags: [],
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
  }
}

/** A script whose first step waits for an element that never shows up. */
function slowScript(): TestScript {
  return {
    id: 'scr-1',
    caseId: 'case-1',
    version: 1,
    name: 'Slow page',
    startUrl: 'https://app.test/cart',
    steps: [
      {
        action: 'wait_for',
        target: { primary: { how: 'testid', value: 'never' }, fallbacks: [] },
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  }
}

beforeEach(async () => {
  installChromeFake()
  vi.resetModules()
  vi.unstubAllGlobals()
  storage = await import('../src/lib/storage')
  mod = await import('../src/background/orchestrator')
})

describe('cancelling an agent run', () => {
  it('settles as cancelled, not error', async () => {
    await configure()
    stubSlowModel()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 60)

    const outcome = await mod.startRun({
      testCase: slowCase(),
      trigger: 'manual',
      useAgent: true,
      signal: controller.signal,
      deps: deps(new SlowDriver()),
    })

    expect(outcome.run.status).toBe('cancelled')
    // The precise misattribution this asserts against: an `AbortError` escaping as a
    // generic failure would be filed as a harness fault.
    expect(outcome.run.status).not.toBe('error')
    expect(outcome.run.status).not.toBe('failed')
  })

  it('stops during a long element wait instead of running to the step timeout', async () => {
    await configure()
    const driver = new SlowDriver()
    const controller = new AbortController()

    const started = Date.now()
    // A script replay parked in `wait_for`, cancelled while the poll loop spins. The
    // replay path is used rather than the agent one because it reaches
    // `driver.waitFor` directly — which is precisely the loop the bug lived in.
    setTimeout(() => controller.abort(), 250)
    const outcome = await mod.startRun({
      testCase: slowCase(),
      script: slowScript(),
      trigger: 'manual',
      signal: controller.signal,
      deps: deps(driver),
    })
    const elapsed = Date.now() - started

    expect(outcome.run.status).toBe('cancelled')
    // The step budget is 10s. Before the signal reached the polling loop, this run
    // ground on for the whole of it after the user pressed cancel.
    expect(elapsed).toBeLessThan(3_000)
    // Proves the wait really was in progress, so the timing above is meaningful
    // rather than a run that never got there.
    expect(driver.waitForCalls).toBeGreaterThan(1)
  })

  it('records a summary that names cancellation as the reason', async () => {
    await configure()
    stubSlowModel()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 60)

    const outcome = await mod.startRun({
      testCase: slowCase(),
      trigger: 'manual',
      useAgent: true,
      signal: controller.signal,
      deps: deps(new SlowDriver()),
    })

    // A user who stopped a run should not have to guess why it ended.
    expect(outcome.run.summary ?? '').toContain('取消')
  })

  it('persists the cancelled run so history and CI agree', async () => {
    await configure()
    stubSlowModel()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 60)

    const outcome = await mod.startRun({
      testCase: slowCase(),
      trigger: 'manual',
      useAgent: true,
      signal: controller.signal,
      deps: deps(new SlowDriver()),
    })

    const runs = await storage.getRuns()
    const stored = runs.find((run) => run.id === outcome.run.id)
    // A bridge client polling for a verdict must see the same status the panel does.
    expect(stored?.status).toBe('cancelled')
    expect(stored?.finishedAt).toBeGreaterThan(0)
  })

  it('does not save a script from a cancelled run', async () => {
    await configure()
    stubSlowModel()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 60)

    await mod.startRun({
      testCase: slowCase(),
      trigger: 'manual',
      useAgent: true,
      signal: controller.signal,
      deps: deps(new SlowDriver()),
    })

    // Auto-save is for a run that demonstrably passed. Persisting a half-finished
    // cancelled run would hand the user a script that replays nothing useful.
    expect(await storage.getScripts()).toHaveLength(0)
  })

  it('closes a tab it opened even when cancelled', async () => {
    await configure()
    stubSlowModel()
    let closed = 0
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 60)

    await mod.startRun({
      testCase: slowCase(),
      trigger: 'manual',
      useAgent: true,
      signal: controller.signal,
      deps: {
        ...deps(new SlowDriver()),
        // No usable tab, so the run opens its own and owns its cleanup.
        findTab: async () => undefined,
        closeTab: async () => {
          closed += 1
        },
      },
    })

    // Cancellation must not leak a tab; the `finally` has to run on this path too.
    expect(closed).toBe(1)
  })
})

describe('cancelling a script replay', () => {
  it('settles as cancelled rather than a failed assertion', async () => {
    await configure()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 120)

    const outcome = await mod.startRun({
      testCase: slowCase(),
      script: slowScript(),
      trigger: 'manual',
      signal: controller.signal,
      deps: deps(new SlowDriver()),
    })

    // A replay parked in `wait_for` would otherwise report `failed` — accusing the
    // application of a bug when the user simply pressed stop.
    expect(outcome.run.status).toBe('cancelled')
  })

  it('does not record a failure against the step it was stopped on', async () => {
    await configure()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 120)

    const outcome = await mod.startRun({
      testCase: slowCase(),
      script: slowScript(),
      trigger: 'manual',
      signal: controller.signal,
      deps: deps(new SlowDriver()),
    })

    // `failure` drives the Feishu card and the JUnit `<failure>` element. A
    // cancellation is not a finding, so it must not populate one.
    expect(outcome.run.failure).toBeUndefined()
  })
})

describe('CancelledError is trusted on its own', () => {
  /**
   * A driver that reports cancellation without any signal being aborted.
   *
   * This covers the race the `error instanceof CancelledError` clause exists for: a
   * driver already inside its polling loop can raise `CancelledError` and win the
   * throw before the orchestrator re-reads `signal.aborted`. Judging by the signal
   * alone would then file a deliberate stop as a harness `error` — an orange run in
   * the report and someone sent looking for a broken selector.
   *
   * Testing it without an aborted signal is the whole point: it isolates the clause
   * instead of letting the signal check mask it.
   */
  class AbruptDriver extends FakeDriver {
    override async waitFor(): Promise<never> {
      const { CancelledError } = await import('../src/background/driver')
      throw new CancelledError()
    }
  }

  it('reports cancelled even when the signal was never aborted', async () => {
    await configure()

    const outcome = await mod.startRun({
      testCase: slowCase(),
      script: slowScript(),
      trigger: 'manual',
      // Deliberately no signal at all.
      deps: deps(new AbruptDriver()),
    })

    expect(outcome.run.status).toBe('cancelled')
    expect(outcome.run.status).not.toBe('error')
    expect(outcome.run.failure).toBeUndefined()
  })

  it('ends an agent run instead of reporting cancellation to the model as a tool error', async () => {
    await configure()
    // The agent asks for a snapshot; the driver reports cancellation instead.
    stubSnapshotModel()

    class CancellingSnapshotDriver extends FakeDriver {
      snapshotCalls = 0
      override async snapshot(): Promise<never> {
        this.snapshotCalls += 1
        const { CancelledError } = await import('../src/background/driver')
        throw new CancelledError()
      }
    }
    const driver = new CancellingSnapshotDriver()

    const outcome = await mod.startRun({
      testCase: slowCase(),
      trigger: 'manual',
      useAgent: true,
      deps: deps(driver),
    })

    // The bug this guards: `dispatchTool` used to fold any unrecognised error into
    // `Error running snapshot: …` and hand it back to the model, which then happily
    // called the next tool while the user waited for the run to stop.
    expect(outcome.run.status).toBe('cancelled')
    // Called once and only once: a swallowed cancellation would loop for all 24
    // rounds, burning tokens on a run nobody wants any more.
    expect(driver.snapshotCalls).toBe(1)
  })
})
