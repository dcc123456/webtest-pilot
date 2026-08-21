/**
 * The real `ChromeDriver` against a fake `chrome.scripting`.
 *
 * Written because a mutation survived: removing the cancellation check from
 * `waitFor`'s polling loop — the *original reported bug* — broke nothing, since every
 * other test drives a `FakeDriver` and asserts the fake's own loop. A guarantee about
 * `ChromeDriver` needs `ChromeDriver` in the room.
 *
 * The loop under test is where a run spends nearly all of its wall-clock time: up to
 * `stepTimeoutMs` per waiting step, re-injecting every 200ms. Cancellation that is
 * only noticed *between* steps is what made the 取消 button look broken.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChromeDriver } from '../src/background/driver.chrome'
import { CancelledError, type RunContext } from '../src/background/driver'

/** Counts injections so a test can prove the loop really was spinning. */
let injections = 0
/** What the injected kernel reports back. `found: false` keeps the loop polling. */
let injectionResult: unknown = { ok: false, found: false, frameUrl: 'https://app.test/', isTopFrame: true }

function installChromeApis(): void {
  injections = 0
  ;(globalThis as { chrome?: unknown }).chrome = {
    tabs: {
      get: async (tabId: number) => ({
        id: tabId,
        url: 'https://app.test/cart',
        title: 'Cart',
        active: true,
        windowId: 10,
      }),
    },
    scripting: {
      executeScript: async () => {
        injections += 1
        return [{ frameId: 0, result: injectionResult }]
      },
    },
    runtime: { lastError: undefined },
  }
}

beforeEach(() => {
  installChromeApis()
  vi.useRealTimers()
})

const ALLOWED = ['https://app.test/*']

describe('ChromeDriver.waitFor honours cancellation', () => {
  it('throws CancelledError instead of polling to the deadline', async () => {
    const driver = new ChromeDriver(ALLOWED)
    const controller = new AbortController()
    const context: RunContext = { tabId: 1, signal: controller.signal }

    // A 10s budget, matching the real default step timeout.
    const pending = driver.waitFor(context, { action: 'wait_for', target: { primary: { how: 'testid', value: 'never' }, fallbacks: [] } }, 10_000)
    setTimeout(() => controller.abort(), 120)

    const started = Date.now()
    // The dedicated error type matters: it is what lets the orchestrator record
    // `cancelled` rather than blaming the harness with `error`.
    await expect(pending).rejects.toBeInstanceOf(CancelledError)
    expect(Date.now() - started).toBeLessThan(3_000)
    // Proves the loop was genuinely mid-poll, so the timing above means something.
    expect(injections).toBeGreaterThan(0)
  })

  it('does not even start when already cancelled', async () => {
    const driver = new ChromeDriver(ALLOWED)
    const controller = new AbortController()
    controller.abort()

    await expect(
      driver.waitFor(
        { tabId: 1, signal: controller.signal },
        { action: 'wait_for', target: { primary: { how: 'testid', value: 'never' }, fallbacks: [] } },
        10_000,
      ),
    ).rejects.toBeInstanceOf(CancelledError)
    // An already-cancelled run must not touch the page at all.
    expect(injections).toBe(0)
  })

  it('still returns the last result when it times out without cancellation', async () => {
    const driver = new ChromeDriver(ALLOWED)
    // No signal: the ordinary path must be unaffected by the cancellation check.
    const result = await driver.waitFor(
      { tabId: 1 },
      { action: 'wait_for', target: { primary: { how: 'testid', value: 'never' }, fallbacks: [] } },
      120,
    )
    // Returned rather than thrown, so the caller can tell "never appeared" from
    // "appeared but was covered" — different bugs with different fixes.
    expect(result.ok).toBe(false)
    expect(injections).toBeGreaterThan(0)
  })

  it('returns promptly once the element appears', async () => {
    const driver = new ChromeDriver(ALLOWED)
    injectionResult = { ok: true, found: true, frameUrl: 'https://app.test/', isTopFrame: true }
    const result = await driver.waitFor(
      { tabId: 1 },
      { action: 'wait_for', target: { primary: { how: 'testid', value: 'ok' }, fallbacks: [] } },
      10_000,
    )
    expect(result.ok).toBe(true)
    injectionResult = { ok: false, found: false, frameUrl: 'https://app.test/', isTopFrame: true }
  })
})

describe('ChromeDriver.waitForLoad honours cancellation', () => {
  it('gives up quickly when the run is cancelled', async () => {
    const driver = new ChromeDriver(ALLOWED)
    injectionResult = 'loading' // never becomes interactive
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)

    const started = Date.now()
    // Returns rather than throws: the caller's own signal check decides the verdict,
    // and a page load is best-effort anyway.
    await driver.waitForLoad({ tabId: 1, signal: controller.signal }, 30_000)
    expect(Date.now() - started).toBeLessThan(3_000)

    injectionResult = { ok: false, found: false, frameUrl: 'https://app.test/', isTopFrame: true }
  })
})
