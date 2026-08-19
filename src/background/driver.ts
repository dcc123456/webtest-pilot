/**
 * The Driver interface: everything the runner and the agent need from a browser.
 *
 * Extracted as an interface so the execution logic — retries, timeouts,
 * assertions, run bookkeeping — can be tested against a fake in Node, with no
 * Chrome and no network. That is the difference between a test suite that covers
 * the interesting failure modes and one that can only be run by hand.
 *
 * @module background/driver
 */

import type { Op, OpResult, PageSnapshot } from '../lib/ops'

/** A tab as the driver sees it. */
export interface DriverTab {
  id: number
  url: string
  title: string
  active: boolean
  windowId: number
}

/** Where a run's pages live. */
export interface RunContext {
  /** Tab operations target this tab unless the op says otherwise. */
  tabId: number
  /** Window opened for the run, when a dedicated one was created. */
  windowId?: number
}

/**
 * A captured screenshot.
 *
 * A data URL rather than a Blob: it survives the structured-clone boundary
 * between worker and panel, and IndexedDB stores it unchanged.
 */
export interface Screenshot {
  dataUrl: string
  width: number
  height: number
}

/**
 * Raised when an operation cannot proceed for a reason the *tool* owns — no tab,
 * a restricted URL, injection refused.
 *
 * Distinct from an operation that ran and reported failure: that is a test
 * result, this is an error. The runner maps the two onto `failed` and `error`
 * respectively, and conflating them would send people debugging their app when
 * the problem is the harness.
 */
export class DriverError extends Error {}

/** Raised when a URL is outside the configured allow-list. */
export class NotAllowedError extends DriverError {}

export interface Driver {
  /** Opens a URL in the run's tab and waits for the document to be ready. */
  navigate(context: RunContext, url: string): Promise<DriverTab>

  /** Runs one op, searching every frame; returns the frame's result. */
  exec(context: RunContext, op: Op): Promise<OpResult>

  /** Convenience wrapper returning a structured page snapshot. */
  snapshot(context: RunContext, maxChars?: number, maxElements?: number): Promise<PageSnapshot>

  /**
   * Polls `exec` until it succeeds or the deadline passes.
   *
   * Polling rather than a single long wait, because MV3 evicts an idle worker:
   * repeated activity is what keeps it alive across a slow page load.
   */
  waitFor(context: RunContext, op: Op, timeoutMs: number): Promise<OpResult>

  /** Captures the visible area of the run's tab, optionally cropped. */
  screenshot(
    context: RunContext,
    crop?: { x: number; y: number; width: number; height: number; dpr?: number },
  ): Promise<Screenshot>

  /** Opens a new tab and makes it the run's target. */
  newTab(context: RunContext, url?: string): Promise<DriverTab>

  /** Lists the run window's tabs, or all tabs when there is no run window. */
  listTabs(context: RunContext): Promise<DriverTab[]>

  /** Switches the run's target tab by index within the run window. */
  switchTab(context: RunContext, index: number): Promise<DriverTab>

  /** Closes a tab by index, then targets a surviving one. */
  closeTab(context: RunContext, index: number): Promise<DriverTab>

  /** Goes back in history and waits for readiness. */
  goBack(context: RunContext): Promise<DriverTab>

  /** Current state of the run's tab. */
  currentTab(context: RunContext): Promise<DriverTab>

  /** Waits for the document to finish loading, up to a timeout. */
  waitForLoad(context: RunContext, timeoutMs: number): Promise<void>
}
