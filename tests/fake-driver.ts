/**
 * A scripted {@link Driver} for tests.
 *
 * Programmed per action name with a queue of outcomes, so a test can express
 * "this element is missing twice, then appears" — the retry behaviour that
 * matters most and is impossible to trigger reliably against a real browser.
 *
 * Every call is recorded in {@link FakeDriver.calls}, so a test can assert both
 * the outcome and that the runner did not, say, retry a step with a side effect.
 */

import type { Op, OpResult, PageSnapshot } from '../src/lib/ops'
import { DriverError, NotAllowedError, type Driver, type DriverTab, type RunContext, type Screenshot } from '../src/background/driver'

/** What the fake should do for one call. */
export type Outcome =
  | { kind: 'ok'; result?: Partial<OpResult> }
  | { kind: 'notFound'; error?: string }
  | { kind: 'failed'; error: string }
  | { kind: 'assertFailed'; actual: string; expected: string }
  | { kind: 'throw'; error: Error }

export interface RecordedCall {
  method: string
  op?: Op
  arg?: unknown
}

export class FakeDriver implements Driver {
  readonly calls: RecordedCall[] = []
  /** Queued outcomes per action; the last one repeats once the queue is empty. */
  private readonly queues = new Map<string, Outcome[]>()
  private defaultOutcome: Outcome = { kind: 'ok' }
  private tab: DriverTab = {
    id: 1,
    url: 'https://app.test/',
    title: 'App',
    active: true,
    windowId: 10,
  }
  private tabs: DriverTab[] = [this.tab]
  snapshotToReturn: PageSnapshot | null = null
  screenshotCount = 0
  /** Set to make every screenshot attempt fail, as a locked screen would. */
  screenshotFails = false
  waitForLoadCount = 0

  /** Queues outcomes for an action, consumed in order. */
  program(action: string, ...outcomes: Outcome[]): this {
    this.queues.set(action, [...(this.queues.get(action) ?? []), ...outcomes])
    return this
  }

  setDefault(outcome: Outcome): this {
    this.defaultOutcome = outcome
    return this
  }

  setUrl(url: string): this {
    this.tab = { ...this.tab, url }
    this.tabs = this.tabs.map((tab) => (tab.id === this.tab.id ? this.tab : tab))
    return this
  }

  /** Number of times an action was attempted. */
  countOf(action: string): number {
    return this.calls.filter((call) => call.op?.action === action).length
  }

  private next(action: string): Outcome {
    const queue = this.queues.get(action)
    if (!queue || queue.length === 0) return this.defaultOutcome
    return queue.length === 1 ? (queue[0] as Outcome) : (queue.shift() as Outcome)
  }

  async exec(_context: RunContext, op: Op): Promise<OpResult> {
    this.calls.push({ method: 'exec', op })
    const outcome = this.next(op.action)
    const base: OpResult = { ok: false, found: false, frameUrl: this.tab.url, isTopFrame: true }

    switch (outcome.kind) {
      case 'throw':
        throw outcome.error
      case 'notFound':
        return { ...base, error: outcome.error ?? 'No element matched.' }
      case 'failed':
        return { ...base, found: true, error: outcome.error }
      case 'assertFailed':
        return {
          ...base,
          found: true,
          error: `expected "${outcome.expected}", got "${outcome.actual}"`,
          assertion: {
            passed: false,
            actual: outcome.actual,
            expected: outcome.expected,
            message: 'assertion failed',
          },
        }
      case 'ok':
        return {
          ...base,
          ok: true,
          found: true,
          ...(op.action === 'assert'
            ? {
                assertion: {
                  passed: true,
                  actual: op.assert?.expected ?? '',
                  expected: op.assert?.expected ?? '',
                  message: 'matched',
                },
              }
            : {}),
          ...(op.action === 'extract'
            ? { extracted: { kind: 'strings' as const, values: ['fake value'] } }
            : {}),
          ...outcome.result,
        }
    }
  }

  async waitFor(context: RunContext, op: Op, _timeoutMs: number): Promise<OpResult> {
    // Single attempt: tests control the outcome directly, so polling would only
    // slow the suite down without exercising anything the runner owns.
    return this.exec(context, op)
  }

  async snapshot(_context: RunContext): Promise<PageSnapshot> {
    this.calls.push({ method: 'snapshot' })
    if (this.snapshotToReturn) return this.snapshotToReturn
    return {
      url: this.tab.url,
      title: this.tab.title,
      text: 'fake page text',
      truncated: false,
      selection: '',
      elements: [],
      elementsTruncated: false,
      frameUrl: this.tab.url,
      isTopFrame: true,
      forms: [],
    }
  }

  async navigate(_context: RunContext, url: string): Promise<DriverTab> {
    this.calls.push({ method: 'navigate', arg: url })
    const outcome = this.next('open_url')
    if (outcome.kind === 'throw') throw outcome.error
    if (outcome.kind === 'failed') throw new DriverError(outcome.error)
    if (outcome.kind === 'notFound') throw new NotAllowedError(outcome.error ?? 'not allowed')
    this.tab = { ...this.tab, url }
    this.tabs = this.tabs.map((tab) => (tab.id === this.tab.id ? this.tab : tab))
    return this.tab
  }

  async screenshot(_context: RunContext): Promise<Screenshot> {
    this.calls.push({ method: 'screenshot' })
    if (this.screenshotFails) throw new DriverError('capture unavailable')
    this.screenshotCount += 1
    return { dataUrl: `data:image/png;base64,shot${this.screenshotCount}`, width: 100, height: 50 }
  }

  async newTab(_context: RunContext, url?: string): Promise<DriverTab> {
    this.calls.push({ method: 'newTab', arg: url })
    const outcome = this.next('tab_new')
    if (outcome.kind === 'throw') throw outcome.error
    const created: DriverTab = {
      id: this.tabs.length + 1,
      url: url ?? 'about:blank',
      title: 'New',
      active: true,
      windowId: this.tab.windowId,
    }
    this.tabs.push(created)
    this.tab = created
    return created
  }

  async listTabs(): Promise<DriverTab[]> {
    this.calls.push({ method: 'listTabs' })
    return [...this.tabs]
  }

  async switchTab(_context: RunContext, index: number): Promise<DriverTab> {
    this.calls.push({ method: 'switchTab', arg: index })
    const outcome = this.next('tab_switch')
    if (outcome.kind === 'throw') throw outcome.error
    const target = this.tabs[index]
    if (!target) throw new DriverError(`No tab at index ${index}.`)
    this.tab = target
    return target
  }

  async closeTab(_context: RunContext, index: number): Promise<DriverTab> {
    this.calls.push({ method: 'closeTab', arg: index })
    const outcome = this.next('tab_close')
    if (outcome.kind === 'throw') throw outcome.error
    if (this.tabs.length === 1) throw new DriverError('Refusing to close the only tab.')
    this.tabs.splice(index, 1)
    this.tab = this.tabs[0] as DriverTab
    return this.tab
  }

  async goBack(): Promise<DriverTab> {
    this.calls.push({ method: 'goBack' })
    const outcome = this.next('go_back')
    if (outcome.kind === 'throw') throw outcome.error
    return this.tab
  }

  async currentTab(): Promise<DriverTab> {
    return this.tab
  }

  async waitForLoad(): Promise<void> {
    this.waitForLoadCount += 1
  }
}
