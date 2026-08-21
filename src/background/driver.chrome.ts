/**
 * The Chrome implementation of {@link Driver}.
 *
 * Three things here are not obvious and are the reason this module exists as a
 * separate layer:
 *
 * 1. **Frame selection.** Injection uses `allFrames: true` and each frame reports
 *    whether it found the target (`OpResult.found`). The first frame that found
 *    it wins. This handles iframes without `webNavigation` permission and without
 *    the extension having to track frame ids across navigations.
 *
 * 2. **Navigation destroys the injection context.** A click that navigates makes
 *    Chrome reject the in-flight `executeScript` with "Frame with ID … was
 *    removed" or "context invalidated". Those are *expected* and are converted
 *    into a successful navigating result, because the click did in fact work.
 *
 * 3. **Screenshots are device-pixel bitmaps.** `captureVisibleTab` returns pixels
 *    at `devicePixelRatio`, while element rects are CSS pixels, so cropping
 *    multiplies by the ratio the page reported. Cropping runs on an
 *    `OffscreenCanvas`, which is available in a service worker where `Image` is
 *    not.
 *
 * @module background/driver.chrome
 */

import { runOp } from '../inpage/kernel'
import type { Op, OpResult, PageSnapshot } from '../lib/ops'
import { checkUrlAllowed, isAutomatableUrl } from '../lib/urlmatch'
import {
  CancelledError,
  DriverError,
  NotAllowedError,
  sleepUnlessCancelled,
  throwIfCancelled,
  type Driver,
  type DriverTab,
  type RunContext,
  type Screenshot,
} from './driver'

/** How often to re-check a pending condition. */
const POLL_INTERVAL_MS = 300

/** Cap on a single injected observation, so a hung page cannot stall a run. */
const EXEC_TIMEOUT_MS = 15_000

/** Error fragments Chrome produces when navigation invalidated the context. */
const CONTEXT_LOST_PATTERNS = [
  'was removed',
  'context invalidated',
  'no frame with id',
  'frame was removed',
  'the message port closed',
  'no tab with id',
  'cannot access contents',
  'target closed',
]

function isContextLost(message: string): boolean {
  const lower = message.toLowerCase()
  return CONTEXT_LOST_PATTERNS.some((pattern) => lower.includes(pattern))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function toDriverTab(tab: chrome.tabs.Tab): DriverTab {
  if (typeof tab.id !== 'number') throw new DriverError('A tab without an id cannot be driven.')
  return {
    id: tab.id,
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: tab.active === true,
    windowId: tab.windowId,
  }
}

/**
 * Chrome-backed driver, bound to one allow-list.
 *
 * The allow-list is a constructor dependency rather than read per call, so a
 * run's permissions are fixed when it starts. Otherwise a user editing Settings
 * mid-run could silently widen what an in-flight run is allowed to touch.
 */
export class ChromeDriver implements Driver {
  constructor(private readonly allowedSites: string[]) {}

  /**
   * Rejects a tab whose URL is not permitted.
   *
   * Called before *every* operation, not once per run: a page can navigate
   * itself — a redirect to an SSO provider, a link the model clicked — and
   * checking only at the start would let the rest of the run proceed on a site
   * the user never authorised.
   */
  private assertAllowed(tab: DriverTab): void {
    const verdict = checkUrlAllowed(tab.url, this.allowedSites)
    if (!verdict.allowed) {
      throw new NotAllowedError(verdict.reason ?? `${tab.url} is not an allowed site.`)
    }
  }

  async currentTab(context: RunContext): Promise<DriverTab> {
    try {
      return toDriverTab(await chrome.tabs.get(context.tabId))
    } catch (error) {
      throw new DriverError(
        `The run's tab is gone (${error instanceof Error ? error.message : String(error)}). It was probably closed.`,
      )
    }
  }

  async navigate(context: RunContext, url: string): Promise<DriverTab> {
    const trimmed = url.trim()
    if (!isAutomatableUrl(trimmed)) {
      throw new DriverError(
        `Cannot open "${trimmed}": only http(s) pages can be automated. Browser-internal, file, and Web Store pages are off limits to every extension.`,
      )
    }
    const verdict = checkUrlAllowed(trimmed, this.allowedSites)
    if (!verdict.allowed) {
      throw new NotAllowedError(verdict.reason ?? `${trimmed} is not an allowed site.`)
    }

    await chrome.tabs.update(context.tabId, { url: trimmed })
    await this.waitForLoad(context, 30_000)
    return this.currentTab(context)
  }

  /**
   * Waits for `document.readyState` to leave `loading`.
   *
   * Read from the page rather than trusting `tab.status`, which reports
   * `complete` for the *previous* document during the gap before a navigation
   * commits — the exact moment a post-click wait is most likely to be issued.
   */
  async waitForLoad(context: RunContext, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let sawLoading = false
    for (;;) {
      // Cancellation is checked before the deadline: a user who pressed Cancel is
      // not waiting for this page, and returning quietly (rather than throwing)
      // lets the caller's own signal check produce the `cancelled` verdict.
      if (context.signal?.aborted) return
      if (Date.now() > deadline) return // Best effort: the step's own wait decides.
      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId: context.tabId, frameIds: [0] },
          func: () => document.readyState,
        })
        const state = injection?.result as string | undefined
        if (state === 'complete' || state === 'interactive') {
          // One extra tick after a load we actually observed starting, so a
          // framework's first render lands before the next step queries the DOM.
          if (sawLoading) await sleepUnlessCancelled(POLL_INTERVAL_MS, context.signal)
          return
        }
        if (state === 'loading') sawLoading = true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Mid-navigation the frame does not exist yet; keep waiting.
        if (!isContextLost(message)) throw new DriverError(message)
      }
      await sleepUnlessCancelled(POLL_INTERVAL_MS, context.signal)
    }
  }

  /**
   * Runs one op in whichever frame contains the target.
   *
   * Results are ranked, not just filtered: a frame reporting `found` outranks one
   * that did not, and among those the top frame wins. Picking the first
   * successful frame arbitrarily would make a page with a duplicated widget in an
   * iframe behave differently between runs.
   */
  async exec(context: RunContext, op: Op): Promise<OpResult> {
    const tab = await this.currentTab(context)
    this.assertAllowed(tab)

    let injections: chrome.scripting.InjectionResult<unknown>[]
    try {
      injections = await this.withTimeout(
        chrome.scripting.executeScript({
          target: { tabId: context.tabId, allFrames: true },
          // Injected as a bare function: `runOp` is serialized, so it must not
          // close over anything. See the contract in `src/inpage/kernel.ts`.
          func: runOp as unknown as (...args: unknown[]) => unknown,
          args: [op as unknown as never],
        }),
        EXEC_TIMEOUT_MS,
        `${op.action} timed out after ${EXEC_TIMEOUT_MS / 1000}s`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isContextLost(message)) {
        // The page navigated out from under the injection. For an action that
        // was expected to navigate, the action succeeded — reporting an error
        // here would fail a step that in fact worked.
        return {
          ok: true,
          found: true,
          frameUrl: tab.url,
          isTopFrame: true,
          mayNavigate: true,
          note: 'The page navigated during this step, so the result was read from the new document.',
        }
      }
      throw new DriverError(`Could not run ${op.action} in the page: ${message}`)
    }

    const results: OpResult[] = []
    for (const injection of injections) {
      const value = injection?.result as OpResult | undefined
      if (value && typeof value === 'object') results.push(value)
    }
    if (results.length === 0) {
      throw new DriverError(
        `No frame in ${tab.url} could be scripted. The page may have just navigated, or it may be a restricted document.`,
      )
    }

    const rank = (result: OpResult): number =>
      (result.found ? 4 : 0) + (result.ok ? 2 : 0) + (result.isTopFrame ? 1 : 0)
    results.sort((a, b) => rank(b) - rank(a))
    return results[0] as OpResult
  }

  async snapshot(
    context: RunContext,
    maxChars = 8000,
    maxElements = 120,
  ): Promise<PageSnapshot> {
    const result = await this.exec(context, { action: 'snapshot', maxChars, maxElements })
    if (!result.page) {
      throw new DriverError(result.error ?? 'The page could not be read.')
    }
    return result.page
  }

  /**
   * Polls until the op succeeds or the deadline passes.
   *
   * Returns the last result rather than throwing, so the caller can distinguish
   * "never appeared" from "appeared but was covered" — different bugs with
   * different fixes.
   */
  async waitFor(context: RunContext, op: Op, timeoutMs: number): Promise<OpResult> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    let last: OpResult | null = null
    for (;;) {
      // The single most important cancellation check in the codebase. This loop is
      // where a run spends most of its wall-clock time — up to `stepTimeoutMs` per
      // step — so without this, pressing Cancel does nothing visible for ten
      // seconds and the button appears broken.
      throwIfCancelled(context.signal)
      try {
        last = await this.exec(context, op)
        if (last.ok) return last
      } catch (error) {
        if (error instanceof NotAllowedError) throw error
        if (error instanceof CancelledError) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (!isContextLost(message)) {
          last = {
            ok: false,
            found: false,
            frameUrl: '',
            isTopFrame: true,
            error: message,
          }
        }
      }
      if (Date.now() >= deadline) break
      await sleepUnlessCancelled(POLL_INTERVAL_MS, context.signal)
    }
    return (
      last ?? {
        ok: false,
        found: false,
        frameUrl: '',
        isTopFrame: true,
        error: `Condition not met within ${Math.round(timeoutMs / 1000)}s.`,
      }
    )
  }

  /**
   * Captures the visible area of the run's tab.
   *
   * `captureVisibleTab` photographs the *active* tab of a window, so the run's
   * tab is activated first. That is also why the run window is created
   * unfocused rather than minimized: an unfocused window still renders and can
   * be captured, a minimized one cannot.
   */
  async screenshot(
    context: RunContext,
    crop?: { x: number; y: number; width: number; height: number; dpr?: number },
  ): Promise<Screenshot> {
    const tab = await this.currentTab(context)
    this.assertAllowed(tab)
    if (!tab.active) {
      await chrome.tabs.update(context.tabId, { active: true })
      // One tick for the compositor; without it the capture can show the
      // previously active tab.
      await sleep(150)
    }

    let dataUrl: string
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'png',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new DriverError(
        `Could not capture the tab: ${message}. A minimized window cannot be captured.`,
      )
    }

    const bitmap = await this.decode(dataUrl)
    if (!crop || crop.width <= 0 || crop.height <= 0) {
      const full = { dataUrl, width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return full
    }

    // The bitmap is in device pixels, the rect in CSS pixels.
    const ratio = crop.dpr && crop.dpr > 0 ? crop.dpr : 1
    const x = Math.max(0, Math.round(crop.x * ratio))
    const y = Math.max(0, Math.round(crop.y * ratio))
    const width = Math.min(bitmap.width - x, Math.round(crop.width * ratio))
    const height = Math.min(bitmap.height - y, Math.round(crop.height * ratio))
    if (width <= 0 || height <= 0) {
      const full = { dataUrl, width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return full
    }

    const canvas = new OffscreenCanvas(width, height)
    const canvasContext = canvas.getContext('2d')
    if (!canvasContext) {
      bitmap.close()
      return { dataUrl, width: bitmap.width, height: bitmap.height }
    }
    canvasContext.drawImage(bitmap, x, y, width, height, 0, 0, width, height)
    bitmap.close()
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return { dataUrl: await this.blobToDataUrl(blob), width, height }
  }

  async newTab(context: RunContext, url?: string): Promise<DriverTab> {
    if (url !== undefined) {
      const verdict = checkUrlAllowed(url, this.allowedSites)
      if (!verdict.allowed) {
        throw new NotAllowedError(verdict.reason ?? `${url} is not an allowed site.`)
      }
    }
    const created = await chrome.tabs.create({
      ...(context.windowId ? { windowId: context.windowId } : {}),
      ...(url ? { url } : {}),
      active: true,
    })
    const tab = toDriverTab(created)
    // The caller updates the context; returning the tab lets it do so without a
    // second query.
    context.tabId = tab.id
    await this.waitForLoad(context, 30_000)
    return this.currentTab(context)
  }

  async listTabs(context: RunContext): Promise<DriverTab[]> {
    const query = context.windowId ? { windowId: context.windowId } : {}
    const tabs = await chrome.tabs.query(query)
    return tabs
      .filter((tab) => typeof tab.id === 'number')
      .map((tab) => toDriverTab(tab))
      .sort((a, b) => a.id - b.id)
  }

  async switchTab(context: RunContext, index: number): Promise<DriverTab> {
    const tabs = await this.listTabs(context)
    const target = tabs[index]
    if (!target) {
      throw new DriverError(
        `No tab at index ${index}. The run has ${tabs.length} tab(s), numbered from 0.`,
      )
    }
    await chrome.tabs.update(target.id, { active: true })
    context.tabId = target.id
    return this.currentTab(context)
  }

  async closeTab(context: RunContext, index: number): Promise<DriverTab> {
    const tabs = await this.listTabs(context)
    const target = tabs[index]
    if (!target) {
      throw new DriverError(`No tab at index ${index}. The run has ${tabs.length} tab(s).`)
    }
    if (tabs.length === 1) {
      throw new DriverError('Refusing to close the run\'s only tab; the run would have nowhere to go.')
    }
    await chrome.tabs.remove(target.id)
    const remaining = tabs.filter((tab) => tab.id !== target.id)
    const next = remaining[Math.max(0, index - 1)] ?? remaining[0]
    if (!next) throw new DriverError('Every tab in the run window was closed.')
    await chrome.tabs.update(next.id, { active: true })
    context.tabId = next.id
    return this.currentTab(context)
  }

  async goBack(context: RunContext): Promise<DriverTab> {
    await chrome.tabs.goBack(context.tabId)
    await this.waitForLoad(context, 30_000)
    const tab = await this.currentTab(context)
    this.assertAllowed(tab)
    return tab
  }

  // --- internals -------------------------------------------------------------

  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DriverError(message)), ms)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Decodes a data URL without `Image`, which service workers do not have. */
  private async decode(dataUrl: string): Promise<ImageBitmap> {
    const response = await fetch(dataUrl)
    const blob = await response.blob()
    return createImageBitmap(blob)
  }

  private async blobToDataUrl(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    // Chunked to stay well under the argument limit of `String.fromCharCode`,
    // which a full-window PNG would otherwise exceed.
    const chunkSize = 0x8000
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
    }
    return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
  }
}

/**
 * Opens a tab for a run that has no usable current page.
 *
 * A tab in the user's own window, deliberately not a new window: the whole point
 * of this tool is to drive the browser the user already has, so a run inherits
 * their logged-in session and existing data. A separate window would still share
 * the profile's cookies, but it starts blank and adds a window to their desktop
 * for no benefit.
 *
 * `active: false` so an unattended run does not yank the foreground tab away
 * mid-sentence. The tab still renders, which `captureVisibleTab` needs.
 */
export async function openRunTab(startUrl?: string): Promise<{ tabId: number; windowId?: number }> {
  const created = await chrome.tabs.create({
    ...(startUrl ? { url: startUrl } : {}),
    active: false,
  })
  if (typeof created.id !== 'number') {
    throw new DriverError('Could not open a tab for the run.')
  }
  return { tabId: created.id, ...(typeof created.windowId === 'number' ? { windowId: created.windowId } : {}) }
}

/** Closes a tab the run opened, ignoring one the user already closed. */
export async function closeRunTab(tabId: number | undefined): Promise<void> {
  if (typeof tabId !== 'number') return
  try {
    await chrome.tabs.remove(tabId)
  } catch {
    /* already gone */
  }
}

/**
 * True when this tab can host a run.
 *
 * Exported so the orchestrator can re-check a tab it was handed, rather than
 * duplicating the rule.
 */
export function isUsableTab(tab: { id?: number; url?: string } | undefined): boolean {
  return Boolean(tab && typeof tab.id === 'number' && isAutomatableUrl(tab.url))
}

/**
 * Finds the tab a run should drive when not opening a window.
 *
 * This is a Chrome extension, so "the current page" is the whole point: with no
 * start URL the run belongs on the tab the user is looking at, full stop. Ranging
 * over other tabs would be a guess, and a wrong guess here is destructive — it
 * would type into a page the user never pointed at, in a window they may not even
 * be looking at.
 *
 * So the active tab is the only candidate unless a start URL says otherwise:
 *
 * 1. The active tab of the focused window — what the user means by "this page".
 * 2. Only when a start URL is given, a tab already showing that origin, so
 *    re-running a case does not navigate a second time.
 *
 * Returns undefined when the active tab is a restricted page (new tab, chrome://,
 * the Web Store). The caller reports that with instructions, rather than silently
 * picking some other tab or opening a window the user did not ask for.
 */
export async function findUsableTab(preferUrl?: string): Promise<DriverTab | undefined> {
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const wanted = preferUrl?.trim() ?? ''

  // With no URL to aim at, the active tab is the only answer. If it is a
  // restricted page, say so — do not go hunting through the user's other windows.
  if (!wanted) {
    if (focused && typeof focused.id === 'number' && isAutomatableUrl(focused.url)) {
      return toDriverTab(focused)
    }
    return undefined
  }

  // The run will navigate anyway, so the active tab is still the right host…
  if (focused && typeof focused.id === 'number' && isAutomatableUrl(focused.url)) {
    return toDriverTab(focused)
  }

  // …unless it cannot be used, in which case a tab already on the target origin
  // is a reasonable second choice: same site, and the user did name it.
  const targetOrigin = originOf(wanted)
  if (targetOrigin) {
    const all = await chrome.tabs.query({})
    const sameOrigin = all.find(
      (tab) =>
        typeof tab.id === 'number' &&
        isAutomatableUrl(tab.url) &&
        originOf(tab.url ?? '') === targetOrigin,
    )
    if (sameOrigin) return toDriverTab(sameOrigin)
  }
  return undefined
}

/** The origin of a URL, or undefined when it is not parseable. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}
