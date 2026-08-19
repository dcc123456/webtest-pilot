/**
 * Page operations: the complete vocabulary of things this extension can do to a
 * page, and the shapes they return.
 *
 * These are *type-only* declarations. They are deliberately kept out of
 * `src/inpage/kernel.ts` because that module is serialized by
 * `chrome.scripting.executeScript` and may not reference anything outside
 * itself; types erase at compile time, so importing them here is safe while
 * importing a value would not be.
 *
 * @module lib/ops
 */

import type { Target } from './selectors'

/** Every action a step can perform. */
export type ActionName =
  // Navigation and tabs (handled by the driver, not the in-page kernel).
  | 'open_url'
  | 'tab_new'
  | 'tab_switch'
  | 'tab_close'
  | 'go_back'
  // In-page interaction.
  | 'click'
  | 'hover'
  | 'fill'
  | 'select_option'
  | 'set_checkbox'
  | 'press_key'
  | 'scroll'
  | 'wait_for'
  | 'assert'
  // Observation.
  | 'read_page'
  | 'snapshot'
  | 'extract'
  | 'screenshot'

/** How an assertion compares the page against an expectation. */
export type AssertKind =
  /** Target's text contains `expected`. */
  | 'text'
  /** Target exists and is visible. */
  | 'visible'
  /** Target is absent or hidden. */
  | 'hidden'
  /** Form control's value equals `expected`. */
  | 'value'
  /** Page URL contains `expected`. */
  | 'url'
  /** Page title contains `expected`. */
  | 'title'
  /** Target's attribute `attr` contains `expected`. */
  | 'attr'
  /** Number of elements matching the target equals `expected`. */
  | 'count'
  /** Target is enabled (not `disabled`, not `aria-disabled`). */
  | 'enabled'
  /** Checkbox or radio is checked. */
  | 'checked'

/** A concrete assertion. */
export interface AssertSpec {
  kind: AssertKind
  /** The expected value. Compared as a string; `count` parses it as a number. */
  expected: string
  /** Attribute name, required for `kind: 'attr'`. */
  attr?: string
  /** Negates the check, so "text does NOT contain" is expressible. */
  negate?: boolean
}

/** What `scroll` should do. */
export type ScrollSpec =
  /** Scroll a target element into view. */
  | { mode: 'into_view' }
  /** Scroll the page by a pixel delta. */
  | { mode: 'by'; x?: number; y?: number }
  /** Jump to the top or bottom of the page. */
  | { mode: 'top' }
  | { mode: 'bottom' }

/** What `extract` should pull out of the matched elements. */
export type ExtractWhat =
  | { kind: 'text' }
  | { kind: 'value' }
  | { kind: 'html' }
  | { kind: 'attr'; attr: string }
  /** Parses the matched `<table>` into a header row plus data rows. */
  | { kind: 'table' }

/**
 * One in-page operation, as handed to the kernel.
 *
 * The kernel receives a plain object because it crosses a structured-clone
 * boundary; nothing here may be a class instance or a function.
 */
export interface Op {
  action: ActionName
  target?: Target
  /** Text to type, option to select, or key to press. */
  value?: string | string[] | boolean
  assert?: AssertSpec
  scroll?: ScrollSpec
  extract?: ExtractWhat
  /**
   * Whether to clear an input before typing. Defaults to true: "fill" means the
   * field ends up holding exactly this value, which is what a test author means.
   */
  clear?: boolean
  /** Character budget for `read_page` text. */
  maxChars?: number
  /** Max elements listed by `snapshot`. */
  maxElements?: number
  /**
   * When set, the kernel resolves the target but performs no action, so the
   * driver can probe reachability before committing to a step.
   */
  probeOnly?: boolean
}

/** A snapshot entry: one interactive element the model may address. */
export interface SnapshotElement {
  /** Snapshot-local handle, `e1`, `e2`, … Valid only for the current snapshot. */
  ref: string
  role: string
  /** Accessible name, or trimmed text when there is no better name. */
  name: string
  tag: string
  /** Input type for `<input>`, otherwise absent. */
  type?: string
  /** Current value of a form control, truncated. Never for password inputs. */
  value?: string
  /**
   * Placeholder text, when present.
   *
   * Reported separately from `name` because a field whose only label is its
   * placeholder is common, and the model needs to tell "labelled Email" from
   * "unlabelled, hints Email" when it decides what to fill.
   */
  placeholder?: string
  /**
   * Resolved destination of a link.
   *
   * Lets the model verify where a link goes without clicking it, which is often
   * the whole assertion — and avoids a navigation it would then have to undo.
   */
  href?: string
  disabled?: boolean
  checked?: boolean
  /** True when the element is inside the viewport right now. */
  inViewport: boolean
  /**
   * The durable target for this element, computed in-page while the element is
   * still in hand. Persisting this is what makes a recorded step replayable.
   */
  target: Target
}

/** Structured page reading. */
export interface PageSnapshot {
  url: string
  title: string
  /** Visible text, whitespace-collapsed. */
  text: string
  /** True when `text` hit its budget. */
  truncated: boolean
  /** Current selection, if any. */
  selection: string
  /** Interactive elements, in document order. */
  elements: SnapshotElement[]
  /** True when `elements` hit its budget. */
  elementsTruncated: boolean
  /** Frame URL this snapshot came from. */
  frameUrl: string
  /** True when this is the top frame. */
  isTopFrame: boolean
  /** Visible form controls grouped by their form, for form-filling context. */
  forms: FormSummary[]
}

/** One `<form>` (or the implicit whole-document form) and its fields. */
export interface FormSummary {
  /** Form's name, id, or accessible name; empty when unnamed. */
  name: string
  fields: {
    ref: string
    label: string
    tag: string
    type?: string
    required?: boolean
    /** Options for a `<select>`, so the model can choose a valid one. */
    options?: string[]
  }[]
}

/**
 * Result of one op inside one frame.
 *
 * `matched` is reported even on success so replay can flag a selector that now
 * matches several elements — a silent source of "clicked the wrong row".
 */
export interface OpResult {
  ok: boolean
  /** Present when the op failed; already phrased for a human. */
  error?: string
  /** How many elements the winning spec matched. */
  matched?: number
  /** Serialized form of the spec that actually resolved the target. */
  usedSpec?: string
  /** True when a fallback spec was needed, i.e. the primary selector drifted. */
  usedFallback?: boolean
  /** Frame URL this result came from. */
  frameUrl: string
  isTopFrame: boolean
  /** True when the frame found the target at all; drives frame selection. */
  found: boolean
  /** Op-specific payload. */
  page?: PageSnapshot
  extracted?: ExtractedValue
  /** Assertion outcome, with the actual value for the failure message. */
  assertion?: { passed: boolean; actual: string; expected: string; message: string }
  /** Set when the op probably triggered a navigation, so the driver can wait. */
  mayNavigate?: boolean
  /** Element's bounding box in CSS pixels, for cropping a screenshot. */
  rect?: { x: number; y: number; width: number; height: number }
  /**
   * Device pixel ratio of the frame.
   *
   * `captureVisibleTab` returns a bitmap in device pixels while `rect` is in CSS
   * pixels, so cropping needs this factor or it crops the wrong region on any
   * HiDPI display.
   */
  dpr?: number
  /** Human-readable note, surfaced in the run log. */
  note?: string
}

/** Whatever `extract` produced. */
export type ExtractedValue =
  | { kind: 'strings'; values: string[] }
  | { kind: 'table'; headers: string[]; rows: string[][] }
