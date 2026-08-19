/**
 * Element targeting.
 *
 * A recorded script must survive the page it was recorded on being re-rendered,
 * so a step never stores a live element reference or a snapshot-local id. It
 * stores a {@link SelectorSpec}: a declarative description that the in-page
 * kernel re-resolves from scratch on every run.
 *
 * This module holds only the *pure* parts — the type, its scoring, its
 * serialization, and its fallback ordering — so they are testable without a DOM
 * and shared by the UI, the exporter, and the kernel's type checking. The DOM
 * side (generating specs from a real element, resolving one back to an element)
 * lives in `src/inpage/kernel.ts`, which must stay self-contained.
 *
 * @module lib/selectors
 */

/** How an element is addressed. Ordered loosely from most to least durable. */
export type SelectorHow =
  /** `[data-testid=…]` and friends: authored for tests, so the most durable. */
  | 'testid'
  /** `#id`, only when the id does not look framework-generated. */
  | 'id'
  /** `[name=…]`, scoped by tag when needed — stable for form controls. */
  | 'name'
  /** ARIA role plus accessible name, the way a human describes a control. */
  | 'role'
  /** Visible text, exact after whitespace collapsing. */
  | 'text'
  /** A structural CSS path. Last resort: breaks when the DOM is reshaped. */
  | 'css'
  /** An XPath, only produced by import from external tooling. */
  | 'xpath'

/**
 * One way to find an element.
 *
 * `nth` disambiguates a spec that matches several elements. It is recorded
 * rather than silently ignored, because "the second Delete button" is a real
 * intent and dropping it would make replay click the wrong row.
 */
export interface SelectorSpec {
  how: SelectorHow
  /**
   * The selector payload: attribute value, id, text, CSS path, or XPath. For
   * `role`, this is the accessible name (empty means "any element of the role").
   */
  value: string
  /** Required for `how: 'role'`, e.g. `button`, `textbox`, `link`. */
  role?: string
  /** Tag hint that narrows `name`/`text`/`role` matches, lowercase. */
  tag?: string
  /** Zero-based index among matches. Absent means "expect exactly one". */
  nth?: number
}

/**
 * A step's target: one preferred spec plus ordered fallbacks.
 *
 * Fallbacks exist because the durable-looking choice is not always the one that
 * survives: a `data-testid` can be removed in a refactor while the button text
 * stays. Replay tries `primary` first, then each fallback in order, and reports
 * which one matched so a drifting selector is visible instead of silent.
 */
export interface Target {
  primary: SelectorSpec
  fallbacks: SelectorSpec[]
  /**
   * URL of the frame the element was found in, when it was not the top frame.
   * A hint only: replay still searches all frames, because a frame's URL can
   * legitimately change between runs.
   */
  frameHint?: string
  /** Human-readable description, for logs, the UI, and exported comments. */
  label?: string
}

/** Attributes treated as test hooks, in the order they are preferred. */
export const TEST_ID_ATTRIBUTES = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-cy',
  'data-qa',
  'data-automation-id',
] as const

/**
 * Durability score for a spec kind. Higher is preferred.
 *
 * Ordering, not the absolute numbers, is what matters; gaps leave room for
 * penalties applied by {@link scoreSpec} without reordering across kinds.
 */
const HOW_SCORE: Record<SelectorHow, number> = {
  testid: 100,
  id: 80,
  name: 70,
  role: 60,
  text: 40,
  css: 20,
  xpath: 10,
}

/**
 * Patterns for ids and class names that are generated per build or per render.
 *
 * Such a value looks specific but is worthless on the next deploy, so it is
 * rejected as a selector even though it would match right now. Being
 * conservative here is deliberate: a false "unstable" verdict costs a slightly
 * uglier fallback, while a false "stable" verdict costs a flaky test.
 */
const UNSTABLE_PATTERNS: RegExp[] = [
  /^[0-9]/, // a leading digit is not even a valid bare CSS id
  // A known UI-library prefix followed by an instance counter, with an optional
  // word in between: `ember1234`, `mui-4`, `react-select-2-input`.
  /^(?:ember|react|vue|ng|mui|css|sc|jss|radix|headlessui)[-_]?[a-z]*[-_]?\d/i,
  /^:r[0-9a-z]+:$/i, // React 18 useId
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9a-f]{16,}$/i, // long hex blob
  /\d{5,}/, // an embedded long number is almost always a counter or timestamp
  /^[a-z0-9_-]*[a-f0-9]{6,}[a-z0-9_-]*$/i, // hashed suffix, e.g. `btn_a1f9c3`
]

/**
 * True when an id or class looks generated rather than authored.
 *
 * Short values are accepted: a two-character id is more likely a terse author
 * choice than a hash, and the alternative (rejecting everything short) would
 * discard many perfectly good selectors.
 */
export function looksUnstable(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) return true
  if (trimmed.length > 64) return true
  return UNSTABLE_PATTERNS.some((pattern) => pattern.test(trimmed))
}

/**
 * Ranks a spec's expected durability.
 *
 * Penalties encode the two ways a good-looking spec goes bad: needing an index
 * (so it depends on sibling order) and a deep CSS path (so it depends on the
 * whole ancestor chain).
 */
export function scoreSpec(spec: SelectorSpec): number {
  let score = HOW_SCORE[spec.how] ?? 0
  if (typeof spec.nth === 'number' && spec.nth > 0) score -= 8
  if (spec.how === 'css') {
    const depth = spec.value.split('>').length
    score -= Math.min(15, depth)
  }
  if (spec.how === 'text' && spec.value.length > 40) score -= 5
  return score
}

/**
 * Picks a primary spec and orders the rest as fallbacks.
 *
 * Duplicates are collapsed first, so a target built from several sources cannot
 * end up retrying the identical selector. Returns null when given nothing,
 * letting the caller decide whether that is an error.
 */
export function buildTarget(
  specs: SelectorSpec[],
  extra: { frameHint?: string; label?: string } = {},
): Target | null {
  const unique: SelectorSpec[] = []
  const seen = new Set<string>()
  for (const spec of specs) {
    const key = serializeSpec(spec)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(spec)
  }
  if (unique.length === 0) return null

  const ranked = [...unique].sort((a, b) => scoreSpec(b) - scoreSpec(a))
  const [primary, ...fallbacks] = ranked
  if (!primary) return null

  const target: Target = { primary, fallbacks }
  if (extra.frameHint) target.frameHint = extra.frameHint
  if (extra.label) target.label = extra.label
  return target
}

/** Stable string form of a spec; used for dedupe keys and log lines. */
export function serializeSpec(spec: SelectorSpec): string {
  const parts = [spec.how, spec.value]
  if (spec.role) parts.push(`role=${spec.role}`)
  if (spec.tag) parts.push(`tag=${spec.tag}`)
  if (typeof spec.nth === 'number') parts.push(`nth=${spec.nth}`)
  return parts.join('|')
}

/** Short human-readable form, for the UI and exported script comments. */
export function describeSpec(spec: SelectorSpec): string {
  const suffix = typeof spec.nth === 'number' && spec.nth > 0 ? ` #${spec.nth + 1}` : ''
  switch (spec.how) {
    case 'testid':
      return `test id "${spec.value}"${suffix}`
    case 'id':
      return `id "${spec.value}"${suffix}`
    case 'name':
      return `name "${spec.value}"${suffix}`
    case 'role':
      return spec.value
        ? `${spec.role ?? 'element'} named "${spec.value}"${suffix}`
        : `${spec.role ?? 'element'}${suffix}`
    case 'text':
      return `text "${spec.value}"${suffix}`
    case 'css':
      return `css ${spec.value}${suffix}`
    case 'xpath':
      return `xpath ${spec.value}${suffix}`
  }
}

/** Describes a whole target, preferring the recorded human label. */
export function describeTarget(target: Target | undefined): string {
  if (!target) return 'the page'
  return target.label?.trim() || describeSpec(target.primary)
}

/**
 * Every spec to try, in order.
 *
 * Replay and the exporter both need this exact sequence, so it is defined once
 * here rather than reconstructed at each call site.
 */
export function candidateSpecs(target: Target): SelectorSpec[] {
  return [target.primary, ...target.fallbacks]
}

/** CSS-escapes an attribute value for embedding in a `[attr="…"]` selector. */
export function quoteAttributeValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Best-effort CSS translation of a spec, for the Playwright exporter and for
 * showing the user what will be queried.
 *
 * `text` and `role` have no CSS equivalent and return null: the exporter emits
 * a Playwright locator for those instead of a CSS string.
 */
export function specToCss(spec: SelectorSpec): string | null {
  const tag = spec.tag ?? ''
  switch (spec.how) {
    case 'testid': {
      // The attribute name is not recorded separately: the value is stored
      // together with the winning attribute in `value` as `attr=value` when it
      // is not the default, so split it back apart here.
      const [attribute, ...rest] = spec.value.split('=')
      if (rest.length > 0 && attribute) {
        return `${tag}[${attribute}=${quoteAttributeValue(rest.join('='))}]`
      }
      return `${tag}[data-testid=${quoteAttributeValue(spec.value)}]`
    }
    case 'id':
      return `${tag}[id=${quoteAttributeValue(spec.value)}]`
    case 'name':
      return `${tag}[name=${quoteAttributeValue(spec.value)}]`
    case 'css':
      return spec.value
    default:
      return null
  }
}
