/**
 * The in-page kernel: every DOM operation this extension can perform.
 *
 * ## The one rule
 *
 * {@link runOp} is serialized by `chrome.scripting.executeScript` and evaluated
 * in the page. Serialization captures the function *source only* — not its
 * closure — so **every** helper it uses must be nested inside it. A reference to
 * anything at module scope compiles fine and then fails at run time with
 * `x is not defined`, in the page, where the stack trace is least useful.
 *
 * `tests/kernel.spec.ts` enforces this by rebuilding the function from
 * `runOp.toString()` via `new Function` and running the whole suite against the
 * rebuilt copy. A leaked reference fails the test rather than the user's run.
 *
 * Types are exempt: they erase at compile time, so `import type` is safe.
 *
 * ## Why it is synchronous
 *
 * Waiting is the driver's job, not the kernel's. Each injection makes one
 * observation or performs one action and returns; `wait_for` polls by
 * re-injecting. A kernel that awaited inside the page would hold the injection
 * open across navigations, which is exactly when the context is destroyed.
 *
 * @module inpage/kernel
 */

import type { Op, OpResult, PageSnapshot, SnapshotElement } from '../lib/ops'

/**
 * Performs one operation in the current frame.
 *
 * Never throws: every failure comes back as `ok: false` with a message already
 * phrased for a human, because a thrown error inside an injected function is
 * reported by Chrome as a generic script error with the detail stripped.
 *
 * `found` is separate from `ok`: with `allFrames: true` the driver injects into
 * every frame and must distinguish "this frame does not contain the element"
 * (normal, try the next frame) from "this frame contains it and the action
 * failed" (a real error to report).
 */
export function runOp(op: Op): OpResult {
  const frameUrl = location.href
  const isTopFrame = window.self === window.top

  // --- Result helpers --------------------------------------------------------

  function base(): OpResult {
    return { ok: false, found: false, frameUrl, isTopFrame }
  }

  function fail(error: string, found = true): OpResult {
    return { ...base(), found, error }
  }

  function notFound(error: string): OpResult {
    return { ...base(), found: false, error }
  }

  // --- Text ------------------------------------------------------------------

  function collapse(text: string): string {
    return text.replace(/[\s\u00a0]+/g, ' ').trim()
  }

  function truncate(text: string, limit: number): { text: string; truncated: boolean } {
    if (text.length <= limit) return { text, truncated: false }
    return { text: text.slice(0, limit), truncated: true }
  }

  /** Visible text of an element, with script/style noise removed. */
  function visibleText(element: Element): string {
    const html = element as HTMLElement
    // `innerText` respects CSS visibility, which is what a user would read, but
    // it is layout-dependent and absent in some environments.
    if (typeof html.innerText === 'string' && html.innerText.length > 0) {
      return collapse(html.innerText)
    }
    const clone = element.cloneNode(true) as HTMLElement
    const noise = clone.querySelectorAll(
      'script, style, noscript, template, svg, canvas, iframe, object, embed',
    )
    for (let index = 0; index < noise.length; index += 1) noise[index]?.remove()
    return collapse(clone.textContent ?? '')
  }

  // --- Layout and visibility -------------------------------------------------

  /**
   * True when the engine reports real layout.
   *
   * jsdom answers every `getBoundingClientRect` with zeros, so layout-based
   * checks would reject every element there. Gating them on this keeps the same
   * code correct in a real browser and testable outside one, rather than
   * maintaining two visibility rules that can disagree.
   */
  function hasLayout(): boolean {
    const root = document.documentElement
    if (!root || typeof root.getBoundingClientRect !== 'function') return false
    const rect = root.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  }

  function styleOf(element: Element): CSSStyleDeclaration | null {
    try {
      return window.getComputedStyle(element)
    } catch {
      return null
    }
  }

  /** True when an element is rendered and could be seen by a user. */
  function isVisible(element: Element): boolean {
    if (!element.isConnected) return false

    const html = element as HTMLElement
    if (html.hidden === true) return false
    if (element.getAttribute('aria-hidden') === 'true') return false
    // `<input type="hidden">` has no visual presence at all.
    if (element instanceof HTMLInputElement && element.type === 'hidden') return false

    // An ancestor `display: none` or `visibility: hidden` hides descendants, so
    // the chain must be walked rather than checking the element alone.
    let node: Element | null = element
    while (node) {
      const style = styleOf(node)
      if (style) {
        if (style.display === 'none') return false
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (style.opacity !== '' && Number(style.opacity) === 0) return false
      }
      if (node.getAttribute('aria-hidden') === 'true' && node !== element) return false
      node = node.parentElement
    }

    if (hasLayout()) {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 && rect.height <= 0) {
        // A zero-size element can still be a styled control whose child carries
        // the box, so accept it when a descendant has one.
        const children = element.children
        let anyChildBox = false
        for (let index = 0; index < children.length; index += 1) {
          const child = children[index]
          if (!child) continue
          const childRect = child.getBoundingClientRect()
          if (childRect.width > 0 || childRect.height > 0) {
            anyChildBox = true
            break
          }
        }
        if (!anyChildBox) return false
      }
    }
    return true
  }

  function isInViewport(element: Element): boolean {
    if (!hasLayout()) return true
    const rect = element.getBoundingClientRect()
    const height = window.innerHeight || document.documentElement.clientHeight || 0
    const width = window.innerWidth || document.documentElement.clientWidth || 0
    return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width
  }

  function isDisabled(element: Element): boolean {
    if ((element as HTMLInputElement).disabled === true) return true
    if (element.getAttribute('aria-disabled') === 'true') return true
    // A `fieldset[disabled]` disables its controls without setting the property
    // on every descendant.
    const fieldset = element.closest('fieldset[disabled]')
    if (fieldset && !element.closest('fieldset[disabled] > legend:first-of-type')) return true
    return false
  }

  // --- Roles and names -------------------------------------------------------

  /** ARIA role, explicit or inferred from the tag. */
  function roleOf(element: Element): string {
    const explicit = element.getAttribute('role')
    if (explicit) return explicit.trim().split(/\s+/)[0] ?? ''

    const tag = element.tagName.toLowerCase()
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic'
    if (tag === 'button') return 'button'
    if (tag === 'select') {
      return (element as HTMLSelectElement).multiple ? 'listbox' : 'combobox'
    }
    if (tag === 'textarea') return 'textbox'
    if (tag === 'summary') return 'button'
    if (tag === 'img') return 'img'
    if (tag === 'nav') return 'navigation'
    if (tag === 'main') return 'main'
    if (tag === 'table') return 'table'
    if (tag === 'form') return 'form'
    if (tag === 'ul' || tag === 'ol') return 'list'
    if (tag === 'li') return 'listitem'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'input') {
      const type = ((element as HTMLInputElement).type || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') {
        return 'button'
      }
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      if (type === 'search') return 'searchbox'
      if (type === 'hidden') return 'none'
      return 'textbox'
    }
    return 'generic'
  }

  /**
   * Accessible name, following the parts of the ARIA algorithm that matter here.
   *
   * Order: `aria-labelledby`, `aria-label`, an associated `<label>`,
   * `placeholder`, `title`, `alt`, then the element's own text. This is the name
   * a user would say out loud, which is why it makes a good selector and a good
   * log line.
   */
  function accessibleName(element: Element): string {
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy) {
      const parts: string[] = []
      for (const id of labelledBy.trim().split(/\s+/)) {
        const referenced = document.getElementById(id)
        if (referenced) parts.push(visibleText(referenced))
      }
      const joined = collapse(parts.join(' '))
      if (joined) return joined
    }

    const ariaLabel = element.getAttribute('aria-label')
    if (ariaLabel && collapse(ariaLabel)) return collapse(ariaLabel)

    const labelable = element as HTMLInputElement
    if (typeof labelable.labels !== 'undefined' && labelable.labels) {
      const parts: string[] = []
      for (let index = 0; index < labelable.labels.length; index += 1) {
        const label = labelable.labels[index]
        if (label) parts.push(visibleText(label))
      }
      const joined = collapse(parts.join(' '))
      if (joined) return joined
    } else if (element.id) {
      // Environments without `labels` still have the `for` relationship.
      const escapedId = element.id.replace(/["\\]/g, '\\$&')
      const label = document.querySelector(`label[for="${escapedId}"]`)
      if (label) {
        const text = visibleText(label)
        if (text) return text
      }
    }

    // A wrapping label, e.g. `<label>Email <input></label>`.
    const wrapping = element.closest('label')
    if (wrapping) {
      const text = visibleText(wrapping)
      if (text) return text
    }

    const placeholder = element.getAttribute('placeholder')
    if (placeholder && collapse(placeholder)) return collapse(placeholder)

    const title = element.getAttribute('title')
    if (title && collapse(title)) return collapse(title)

    const alt = element.getAttribute('alt')
    if (alt && collapse(alt)) return collapse(alt)

    if (element instanceof HTMLInputElement) {
      const type = (element.type || '').toLowerCase()
      // A button's own `value` is its visible label.
      if (type === 'submit' || type === 'button' || type === 'reset') {
        if (collapse(element.value)) return collapse(element.value)
      }
      return ''
    }

    const own = visibleText(element)
    return own.length <= 120 ? own : own.slice(0, 120)
  }

  // --- Selector generation ---------------------------------------------------

  const TEST_ID_ATTRIBUTES = [
    'data-testid',
    'data-test-id',
    'data-test',
    'data-cy',
    'data-qa',
    'data-automation-id',
  ]

  /**
   * Mirrors `looksUnstable` in `src/lib/selectors.ts`.
   *
   * Duplicated deliberately: the kernel may not import it. The two are pinned
   * together by `tests/kernel.spec.ts`, which runs the same table of values
   * through both and asserts they agree — so a change to one that is not
   * mirrored in the other fails the suite.
   */
  function looksUnstable(value: string): boolean {
    const trimmed = value.trim()
    if (trimmed.length === 0) return true
    if (trimmed.length > 64) return true
    const patterns = [
      /^[0-9]/,
      /^(?:ember|react|vue|ng|mui|css|sc|jss|radix|headlessui)[-_]?[a-z]*[-_]?\d/i,
      /^:r[0-9a-z]+:$/i,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      /^[0-9a-f]{16,}$/i,
      /\d{5,}/,
      /^[a-z0-9_-]*[a-f0-9]{6,}[a-z0-9_-]*$/i,
    ]
    for (const pattern of patterns) if (pattern.test(trimmed)) return true
    return false
  }

  function quoteAttribute(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }

  /** Index of an element among same-tag siblings, 1-based, for `nth-of-type`. */
  function indexAmongType(element: Element): number {
    let index = 1
    let sibling = element.previousElementSibling
    while (sibling) {
      if (sibling.tagName === element.tagName) index += 1
      sibling = sibling.previousElementSibling
    }
    return index
  }

  /**
   * A structural CSS path, the last-resort selector.
   *
   * The walk stops early at the nearest ancestor with a stable id, which keeps
   * the path short and immune to reshuffling above that point. Without that, a
   * path from `body` breaks whenever a wrapper div is added.
   */
  function cssPath(element: Element): string {
    const parts: string[] = []
    let node: Element | null = element
    let depth = 0
    while (node && node.nodeType === 1 && depth < 12) {
      const tag = node.tagName.toLowerCase()
      if (tag === 'html' || tag === 'body') {
        parts.unshift(tag)
        break
      }
      if (node.id && !looksUnstable(node.id)) {
        parts.unshift(`${tag}[id=${quoteAttribute(node.id)}]`)
        break
      }
      const parent: Element | null = node.parentElement
      const sameTagSiblings = parent
        ? Array.prototype.filter.call(
            parent.children,
            (child: Element) => child.tagName === node?.tagName,
          ).length
        : 1
      parts.unshift(sameTagSiblings > 1 ? `${tag}:nth-of-type(${indexAmongType(node)})` : tag)
      node = parent
      depth += 1
    }
    return parts.join(' > ')
  }

  interface Spec {
    how: 'testid' | 'id' | 'name' | 'role' | 'text' | 'css' | 'xpath'
    value: string
    role?: string
    tag?: string
    nth?: number
  }

  /** Mirrors `scoreSpec` in `src/lib/selectors.ts`; pinned by the same test. */
  function scoreSpec(spec: Spec): number {
    const table: Record<string, number> = {
      testid: 100,
      id: 80,
      name: 70,
      role: 60,
      text: 40,
      css: 20,
      xpath: 10,
    }
    let score = table[spec.how] ?? 0
    if (typeof spec.nth === 'number' && spec.nth > 0) score -= 8
    if (spec.how === 'css') score -= Math.min(15, spec.value.split('>').length)
    if (spec.how === 'text' && spec.value.length > 40) score -= 5
    return score
  }

  function serializeSpec(spec: Spec): string {
    const parts: string[] = [spec.how, spec.value]
    if (spec.role) parts.push(`role=${spec.role}`)
    if (spec.tag) parts.push(`tag=${spec.tag}`)
    if (typeof spec.nth === 'number') parts.push(`nth=${spec.nth}`)
    return parts.join('|')
  }

  /**
   * Every way this element can be addressed, each with the index it needs.
   *
   * The index is computed *now*, while the element is in hand, by running the
   * candidate selector and finding this element's position among the matches.
   * Recording it is what lets "the third Delete button" replay correctly instead
   * of hitting the first row.
   */
  function specsFor(element: Element): Spec[] {
    const specs: Spec[] = []
    const tag = element.tagName.toLowerCase()

    const withIndex = (spec: Spec): Spec => {
      const matches = queryAll(spec)
      if (matches.length <= 1) return spec
      const position = matches.indexOf(element)
      if (position <= 0) return position === 0 ? spec : { ...spec, nth: 0 }
      return { ...spec, nth: position }
    }

    for (const attribute of TEST_ID_ATTRIBUTES) {
      const value = element.getAttribute(attribute)
      if (value && value.trim()) {
        const stored = attribute === 'data-testid' ? value : `${attribute}=${value}`
        specs.push(withIndex({ how: 'testid', value: stored }))
        break
      }
    }

    if (element.id && !looksUnstable(element.id)) {
      specs.push(withIndex({ how: 'id', value: element.id }))
    }

    const name = element.getAttribute('name')
    if (name && name.trim() && !looksUnstable(name)) {
      specs.push(withIndex({ how: 'name', value: name, tag }))
    }

    const role = roleOf(element)
    const label = accessibleName(element)
    if (role && role !== 'generic' && role !== 'none' && label && label.length <= 80) {
      specs.push(withIndex({ how: 'role', value: label, role }))
    }

    const own = visibleText(element)
    if (own && own.length <= 80 && element.children.length === 0) {
      specs.push(withIndex({ how: 'text', value: own, tag }))
    }

    specs.push(withIndex({ how: 'css', value: cssPath(element) }))
    return specs
  }

  /** Builds a durable target for an element, ranked best-first. */
  function targetFor(element: Element): {
    primary: Spec
    fallbacks: Spec[]
    frameHint?: string
    label?: string
  } {
    const specs = specsFor(element)
    const unique: Spec[] = []
    const seen: Record<string, true> = {}
    for (const spec of specs) {
      const key = serializeSpec(spec)
      if (seen[key]) continue
      seen[key] = true
      unique.push(spec)
    }
    unique.sort((a, b) => scoreSpec(b) - scoreSpec(a))
    const primary = unique[0] ?? { how: 'css' as const, value: cssPath(element) }
    const label = accessibleName(element) || visibleText(element).slice(0, 60)
    const built: { primary: Spec; fallbacks: Spec[]; frameHint?: string; label?: string } = {
      primary,
      fallbacks: unique.slice(1),
    }
    if (!isTopFrame) built.frameHint = frameUrl
    if (label) built.label = label
    return built
  }

  // --- Selector resolution ---------------------------------------------------

  function safeQuery(selector: string): Element[] {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(selector)) as Element[]
    } catch {
      // An invalid selector must be a clean "no match", not an exception that
      // aborts the whole operation.
      return []
    }
  }

  /** All elements matching one spec, in document order, before index selection. */
  function queryAll(spec: Spec): Element[] {
    const tagPrefix = spec.tag ?? ''
    switch (spec.how) {
      case 'testid': {
        const separator = spec.value.indexOf('=')
        const attribute = separator === -1 ? 'data-testid' : spec.value.slice(0, separator)
        const value = separator === -1 ? spec.value : spec.value.slice(separator + 1)
        return safeQuery(`${tagPrefix}[${attribute}=${quoteAttribute(value)}]`)
      }
      case 'id':
        // An attribute selector, not `#id`: a generated id like `:r3:` is not a
        // parseable CSS id but is a perfectly valid attribute value.
        return safeQuery(`${tagPrefix}[id=${quoteAttribute(spec.value)}]`)
      case 'name':
        return safeQuery(`${tagPrefix}[name=${quoteAttribute(spec.value)}]`)
      case 'css':
        return safeQuery(spec.value)
      case 'xpath': {
        try {
          const evaluated = document.evaluate(
            spec.value,
            document,
            null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
            null,
          )
          const found: Element[] = []
          for (let index = 0; index < evaluated.snapshotLength; index += 1) {
            const node = evaluated.snapshotItem(index)
            if (node && node.nodeType === 1) found.push(node as Element)
          }
          return found
        } catch {
          return []
        }
      }
      case 'role': {
        const wanted = (spec.role ?? '').toLowerCase()
        const all = safeQuery('*')
        const found: Element[] = []
        for (const candidate of all) {
          if (roleOf(candidate).toLowerCase() !== wanted) continue
          if (spec.value && accessibleName(candidate) !== spec.value) continue
          found.push(candidate)
        }
        return found
      }
      case 'text': {
        const wanted = spec.value
        const all = safeQuery(tagPrefix || '*')
        const exact: Element[] = []
        for (const candidate of all) {
          if (visibleText(candidate) !== wanted) continue
          // Keep only the deepest match, so `text: "Save"` resolves to the
          // button and not to every ancestor that happens to contain just it.
          let hasMatchingDescendant = false
          const descendants = candidate.querySelectorAll(tagPrefix || '*')
          for (let index = 0; index < descendants.length; index += 1) {
            const descendant = descendants[index]
            if (descendant && visibleText(descendant) === wanted) {
              hasMatchingDescendant = true
              break
            }
          }
          if (!hasMatchingDescendant) exact.push(candidate)
        }
        return exact
      }
    }
  }

  interface Resolution {
    element: Element
    matched: number
    usedSpec: string
    usedFallback: boolean
  }

  /**
   * Resolves a target to one element by trying each spec in order.
   *
   * Visible matches win over hidden ones with the same selector: a framework
   * that keeps an offscreen duplicate of a control (a mobile menu, a template)
   * would otherwise make replay click something the user cannot see.
   */
  function resolve(target: Op['target']): Resolution | null {
    if (!target) return null
    const candidates: Spec[] = [target.primary as Spec, ...((target.fallbacks ?? []) as Spec[])]
    for (let index = 0; index < candidates.length; index += 1) {
      const spec = candidates[index]
      if (!spec) continue
      const all = queryAll(spec)
      if (all.length === 0) continue

      let chosen: Element | undefined
      if (typeof spec.nth === 'number') {
        chosen = all[spec.nth]
      } else {
        const visible = all.filter((element) => isVisible(element))
        chosen = visible[0] ?? all[0]
      }
      if (!chosen) continue
      return {
        element: chosen,
        matched: all.length,
        usedSpec: serializeSpec(spec),
        usedFallback: index > 0,
      }
    }
    return null
  }

  // --- Interaction -----------------------------------------------------------

  function scrollIntoView(element: Element): void {
    try {
      element.scrollIntoView({ block: 'center', inline: 'center' })
    } catch {
      // Older signature, and jsdom, which has no scrolling at all.
      try {
        ;(element as HTMLElement).scrollIntoView()
      } catch {
        /* nothing further to try */
      }
    }
  }

  function rectOf(element: Element): { x: number; y: number; width: number; height: number } {
    const rect = element.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }

  /**
   * Whether something else is painted over the element's centre.
   *
   * This is the difference between a test that fails with "the cookie banner is
   * covering the button" and one that reports a mysterious click doing nothing:
   * a click dispatched onto a covered element still fires its handler, so
   * without this check an overlay bug looks like a pass.
   */
  function occludedBy(element: Element): Element | null {
    if (!hasLayout()) return null
    if (typeof document.elementFromPoint !== 'function') return null
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const top = document.elementFromPoint(x, y)
    if (!top) return null
    if (top === element) return null
    if (element.contains(top)) return null
    if (top.contains(element)) return null
    return top
  }

  function describeElement(element: Element): string {
    const tag = element.tagName.toLowerCase()
    const name = accessibleName(element)
    return name ? `<${tag}> "${name}"` : `<${tag}>`
  }

  function dispatchMouse(element: Element, type: string): void {
    const rect = hasLayout()
      ? element.getBoundingClientRect()
      : ({ left: 0, top: 0, width: 0, height: 0 } as DOMRect)
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      // `document.defaultView`, not the `window` global: they are the same in a
      // real page, but the constructor brand-checks this member and a global
      // that was copied rather than aliased fails that check.
      view: document.defaultView ?? undefined,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
      buttons: type === 'mouseup' || type === 'click' ? 0 : 1,
    }
    try {
      // PointerEvent is what modern frameworks listen for; fall back where absent.
      if (typeof PointerEvent === 'function' && type.startsWith('pointer')) {
        element.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, isPrimary: true }))
        return
      }
      element.dispatchEvent(new MouseEvent(type, init))
    } catch {
      // Some engines refuse one of the members above. A plain bubbling Event
      // still reaches every listener, which matters more than the coordinates:
      // losing the click entirely would be a false test failure.
      element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
    }
  }

  /**
   * Writes a value the way a user would, so frameworks notice.
   *
   * React installs its own `value` setter on the DOM node and tracks the last
   * value it wrote; assigning `element.value` directly updates the DOM but
   * leaves React's tracker unchanged, so React concludes nothing changed and
   * discards the `input` event. Calling the *prototype's* native setter
   * bypasses the instance property and keeps the tracker consistent.
   */
  function setControlValue(element: Element, value: string): void {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value)
    } else {
      ;(element as HTMLInputElement).value = value
    }
  }

  function fireInputAndChange(element: Element): void {
    const inputEvent =
      typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, cancelable: false })
        : new Event('input', { bubbles: true })
    element.dispatchEvent(inputEvent)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function focusElement(element: Element): void {
    try {
      ;(element as HTMLElement).focus({ preventScroll: true })
    } catch {
      try {
        ;(element as HTMLElement).focus()
      } catch {
        /* not focusable */
      }
    }
  }

  /** True when this element's activation is likely to navigate the page. */
  function mayNavigate(element: Element): boolean {
    const tag = element.tagName.toLowerCase()
    if (tag === 'a' && element.hasAttribute('href')) {
      const href = element.getAttribute('href') ?? ''
      // A pure fragment link does not leave the document.
      return !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:')
    }
    if (element instanceof HTMLInputElement && element.type === 'submit') return true
    if (element instanceof HTMLButtonElement) {
      const type = (element.getAttribute('type') ?? 'submit').toLowerCase()
      return type === 'submit' && element.form !== null
    }
    return false
  }

  // --- Observation -----------------------------------------------------------

  /** Interactive elements the model may address, plus form structure. */
  function buildSnapshot(maxChars: number, maxElements: number): PageSnapshot {
    const interactiveSelector = [
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      'summary',
      '[role]',
      '[tabindex]',
      '[contenteditable="true"]',
      '[onclick]',
    ].join(', ')

    const seen: Element[] = []
    const candidates = safeQuery(interactiveSelector)
    for (const candidate of candidates) {
      const role = roleOf(candidate)
      if (role === 'none' || role === 'presentation') continue
      if (!isVisible(candidate)) continue
      if (seen.indexOf(candidate) !== -1) continue
      seen.push(candidate)
    }

    const elements: SnapshotElement[] = []
    const limit = Math.max(1, maxElements)
    for (let index = 0; index < seen.length && elements.length < limit; index += 1) {
      const element = seen[index]
      if (!element) continue
      const tag = element.tagName.toLowerCase()
      const input = element as HTMLInputElement
      const type = tag === 'input' ? (input.type || 'text').toLowerCase() : undefined

      const entry: SnapshotElement = {
        ref: `e${elements.length + 1}`,
        role: roleOf(element),
        name: accessibleName(element),
        tag,
        inViewport: isInViewport(element),
        target: targetFor(element) as SnapshotElement['target'],
      }
      if (type) entry.type = type
      // A password value must never be read back: it would end up in the model
      // request, the transcript, and the run log.
      if (type !== 'password' && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
        const value = String(input.value ?? '')
        if (value) entry.value = value.length > 120 ? `${value.slice(0, 120)}…` : value
      }
      const placeholder = collapse(element.getAttribute('placeholder') ?? '')
      // Only when it differs from the name, which already falls back to it:
      // repeating it would cost tokens on every snapshot for no information.
      if (placeholder && placeholder !== entry.name) entry.placeholder = placeholder
      if (tag === 'a') {
        // `href` is the resolved absolute URL, so the model can compare it with
        // an expected destination without resolving relative paths itself.
        const href = (element as HTMLAnchorElement).href
        if (href) entry.href = href.length > 200 ? `${href.slice(0, 200)}…` : href
      }
      if (isDisabled(element)) entry.disabled = true
      if (type === 'checkbox' || type === 'radio') entry.checked = input.checked === true
      elements.push(entry)
    }

    const refByElement = new Map<Element, string>()
    for (let index = 0; index < elements.length; index += 1) {
      const element = seen[index]
      const entry = elements[index]
      if (element && entry) refByElement.set(element, entry.ref)
    }

    const forms: PageSnapshot['forms'] = []
    const formElements = safeQuery('form')
    for (const form of formElements) {
      if (!isVisible(form)) continue
      const fields: PageSnapshot['forms'][number]['fields'] = []
      const controls = form.querySelectorAll('input, select, textarea')
      for (let index = 0; index < controls.length; index += 1) {
        const control = controls[index]
        if (!control || !isVisible(control)) continue
        const ref = refByElement.get(control)
        if (!ref) continue
        const tag = control.tagName.toLowerCase()
        const field: PageSnapshot['forms'][number]['fields'][number] = {
          ref,
          label: accessibleName(control),
          tag,
        }
        if (tag === 'input') field.type = ((control as HTMLInputElement).type || 'text').toLowerCase()
        if ((control as HTMLInputElement).required) field.required = true
        if (control instanceof HTMLSelectElement) {
          const options: string[] = []
          for (let optionIndex = 0; optionIndex < control.options.length; optionIndex += 1) {
            const option = control.options[optionIndex]
            if (option) options.push(collapse(option.textContent ?? '') || option.value)
          }
          field.options = options
        }
        fields.push(field)
      }
      if (fields.length > 0) {
        forms.push({
          name: form.getAttribute('name') ?? form.id ?? accessibleName(form),
          fields,
        })
      }
    }

    const body = document.body ?? document.documentElement
    const rawText = body ? visibleText(body) : ''
    const { text, truncated } = truncate(rawText, Math.max(200, maxChars))
    const selection = collapse(window.getSelection()?.toString() ?? '')

    return {
      url: location.href,
      title: document.title,
      text,
      truncated,
      selection,
      elements,
      elementsTruncated: seen.length > elements.length,
      frameUrl,
      isTopFrame,
      forms,
    }
  }

  // --- Assertions ------------------------------------------------------------

  function textOfTargetOrPage(resolution: Resolution | null): string {
    if (resolution) return visibleText(resolution.element)
    const body = document.body ?? document.documentElement
    return body ? visibleText(body) : ''
  }

  function evaluateAssertion(
    resolution: Resolution | null,
  ): { passed: boolean; actual: string; expected: string; message: string } | null {
    const spec = op.assert
    if (!spec) return null
    const expected = spec.expected ?? ''
    let passed = false
    let actual = ''

    switch (spec.kind) {
      case 'url':
        actual = location.href
        passed = actual.indexOf(expected) !== -1
        break
      case 'title':
        actual = document.title
        passed = actual.indexOf(expected) !== -1
        break
      case 'text':
        actual = textOfTargetOrPage(resolution)
        passed = actual.indexOf(collapse(expected)) !== -1
        break
      case 'visible':
        actual = resolution ? 'present' : 'absent'
        passed = resolution !== null && isVisible(resolution.element)
        break
      case 'hidden':
        actual = resolution ? (isVisible(resolution.element) ? 'visible' : 'hidden') : 'absent'
        passed = resolution === null || !isVisible(resolution.element)
        break
      case 'value':
        actual = resolution ? String((resolution.element as HTMLInputElement).value ?? '') : ''
        passed = resolution !== null && actual === expected
        break
      case 'attr':
        actual = resolution ? (resolution.element.getAttribute(spec.attr ?? '') ?? '') : ''
        passed = resolution !== null && actual.indexOf(expected) !== -1
        break
      case 'count': {
        const target = op.target
        const count = target ? queryAll(target.primary as Spec).length : 0
        actual = String(count)
        passed = count === Number(expected)
        break
      }
      case 'enabled':
        actual = resolution ? (isDisabled(resolution.element) ? 'disabled' : 'enabled') : 'absent'
        passed = resolution !== null && !isDisabled(resolution.element)
        break
      case 'checked':
        actual = resolution
          ? (resolution.element as HTMLInputElement).checked === true
            ? 'checked'
            : 'unchecked'
          : 'absent'
        passed = resolution !== null && (resolution.element as HTMLInputElement).checked === true
        break
    }

    if (spec.negate) passed = !passed
    const not = spec.negate ? 'not ' : ''
    const actualShort = actual.length > 200 ? `${actual.slice(0, 200)}…` : actual
    return {
      passed,
      actual: actualShort,
      expected,
      message: passed
        ? `${spec.kind} ${not}matched`
        : `expected ${spec.kind} to ${not}be "${expected}", got "${actualShort}"`,
    }
  }

  // --- Dispatch --------------------------------------------------------------

  try {
    // Observation operations need no target.
    if (op.action === 'read_page' || op.action === 'snapshot') {
      const page = buildSnapshot(op.maxChars ?? 8000, op.maxElements ?? 120)
      return { ...base(), ok: true, found: true, page }
    }

    if (op.action === 'assert' && op.assert) {
      const needsTarget =
        op.assert.kind !== 'url' && op.assert.kind !== 'title' && op.target !== undefined
      const resolution = needsTarget ? resolve(op.target) : null
      const assertion = evaluateAssertion(resolution)
      if (!assertion) return fail('Assertion had no specification.')
      // A frame that cannot see the element reports `found: false` so the driver
      // keeps looking; a frame that can decides the outcome.
      const found = !needsTarget || resolution !== null || op.assert.kind === 'hidden'
      const result: OpResult = { ...base(), ok: assertion.passed, found, assertion }
      if (resolution) {
        result.matched = resolution.matched
        result.usedSpec = resolution.usedSpec
        result.usedFallback = resolution.usedFallback
      }
      if (!assertion.passed) result.error = assertion.message
      return result
    }

    if (op.action === 'scroll' && !op.target) {
      const spec = op.scroll ?? { mode: 'by' as const, y: 600 }
      // Wrapped: an engine without a scrolling implementation throws here, and a
      // failed scroll must not fail the step — the next action re-checks
      // visibility and scrolls the element into view anyway.
      try {
        if (spec.mode === 'top') window.scrollTo({ top: 0, left: 0 })
        else if (spec.mode === 'bottom') {
          const height = document.documentElement.scrollHeight ?? 0
          window.scrollTo({ top: height, left: 0 })
        } else if (spec.mode === 'by') {
          window.scrollBy({ top: spec.y ?? 0, left: spec.x ?? 0 })
        }
      } catch {
        /* no scrolling available in this engine */
      }
      return { ...base(), ok: true, found: true, note: `scrolled ${spec.mode}` }
    }

    if (op.action === 'press_key' && !op.target) {
      const key = String(op.value ?? '')
      if (!key) return fail('press_key needs a key name.')
      const active = (document.activeElement ?? document.body) as Element
      const init: KeyboardEventInit = { key, code: key, bubbles: true, cancelable: true }
      active.dispatchEvent(new KeyboardEvent('keydown', init))
      active.dispatchEvent(new KeyboardEvent('keyup', init))
      return { ...base(), ok: true, found: true, note: `pressed ${key}` }
    }

    // Everything below needs an element.
    if (!op.target) return fail(`${op.action} needs a target element.`, false)

    const resolution = resolve(op.target)
    if (!resolution) {
      const tried = [op.target.primary as Spec, ...((op.target.fallbacks ?? []) as Spec[])]
        .map((spec) => serializeSpec(spec))
        .join(', ')
      return notFound(`No element matched. Tried: ${tried}`)
    }

    const element = resolution.element
    const withMeta = (result: OpResult): OpResult => ({
      ...result,
      matched: resolution.matched,
      usedSpec: resolution.usedSpec,
      usedFallback: resolution.usedFallback,
    })

    // `wait_for` and `probeOnly` are pure observations of a resolved element.
    if (op.action === 'wait_for' || op.probeOnly) {
      const visible = isVisible(element)
      return withMeta({
        ...base(),
        ok: visible,
        found: true,
        rect: hasLayout() ? rectOf(element) : undefined,
        ...(visible ? {} : { error: `${describeElement(element)} exists but is not visible.` }),
      })
    }

    if (op.action === 'extract') {
      const what = op.extract ?? { kind: 'text' as const }
      const spec = op.target.primary as Spec
      const all = queryAll(spec)
      const chosen = all.length > 0 ? all : [element]

      if (what.kind === 'table') {
        const table = element.closest('table') ?? element.querySelector('table')
        if (!table) return withMeta(fail('No <table> found at that target.'))
        const headers: string[] = []
        const headerCells = table.querySelectorAll('thead th, thead td, tr:first-child th')
        for (let index = 0; index < headerCells.length; index += 1) {
          const cell = headerCells[index]
          if (cell) headers.push(visibleText(cell))
        }
        const rows: string[][] = []
        const bodyRows = table.querySelectorAll('tbody tr, tr')
        for (let index = 0; index < bodyRows.length; index += 1) {
          const row = bodyRows[index]
          if (!row) continue
          const cells = row.querySelectorAll('td')
          if (cells.length === 0) continue
          const values: string[] = []
          for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
            const cell = cells[cellIndex]
            if (cell) values.push(visibleText(cell))
          }
          rows.push(values)
        }
        return withMeta({
          ...base(),
          ok: true,
          found: true,
          extracted: { kind: 'table', headers, rows },
        })
      }

      const values: string[] = []
      for (const candidate of chosen) {
        if (what.kind === 'text') values.push(visibleText(candidate))
        else if (what.kind === 'value') values.push(String((candidate as HTMLInputElement).value ?? ''))
        else if (what.kind === 'html') values.push((candidate as HTMLElement).innerHTML ?? '')
        else values.push(candidate.getAttribute(what.attr) ?? '')
      }
      return withMeta({
        ...base(),
        ok: true,
        found: true,
        extracted: { kind: 'strings', values },
      })
    }

    if (op.action === 'screenshot') {
      scrollIntoView(element)
      return withMeta({
        ...base(),
        ok: true,
        found: true,
        rect: hasLayout() ? rectOf(element) : undefined,
        dpr: window.devicePixelRatio,
      })
    }

    if (op.action === 'scroll') {
      const spec = op.scroll ?? { mode: 'into_view' as const }
      try {
        if (spec.mode === 'into_view') scrollIntoView(element)
        else if (spec.mode === 'by') element.scrollBy?.({ top: spec.y ?? 0, left: spec.x ?? 0 })
        else if (spec.mode === 'top') element.scrollTo?.({ top: 0 })
        else element.scrollTo?.({ top: element.scrollHeight })
      } catch {
        /* no scrolling available in this engine */
      }
      return withMeta({ ...base(), ok: true, found: true })
    }

    // Interactions: scroll into view, then verify interactability.
    scrollIntoView(element)

    if (!isVisible(element)) {
      return withMeta(fail(`${describeElement(element)} exists but is not visible.`))
    }

    if (op.action === 'hover') {
      dispatchMouse(element, 'pointerover')
      dispatchMouse(element, 'mouseover')
      dispatchMouse(element, 'mousemove')
      return withMeta({ ...base(), ok: true, found: true })
    }

    if (op.action === 'click') {
      if (isDisabled(element)) {
        return withMeta(fail(`${describeElement(element)} is disabled, so it cannot be clicked.`))
      }
      const blocker = occludedBy(element)
      if (blocker) {
        return withMeta(
          fail(
            `${describeElement(element)} is covered by ${describeElement(blocker)}, so a click would not reach it.`,
          ),
        )
      }
      const navigates = mayNavigate(element)
      dispatchMouse(element, 'pointerdown')
      dispatchMouse(element, 'mousedown')
      focusElement(element)
      dispatchMouse(element, 'pointerup')
      dispatchMouse(element, 'mouseup')
      // `click()` runs the element's default action (submit, follow link), which
      // a synthetic `click` event alone does not.
      ;(element as HTMLElement).click()
      return withMeta({ ...base(), ok: true, found: true, mayNavigate: navigates })
    }

    if (op.action === 'fill') {
      if (isDisabled(element)) {
        return withMeta(fail(`${describeElement(element)} is disabled, so it cannot be filled.`))
      }
      const value = op.value === undefined || op.value === null ? '' : String(op.value)
      const editable = element.getAttribute('contenteditable')
      focusElement(element)

      if (editable === '' || editable === 'true') {
        ;(element as HTMLElement).textContent = value
        fireInputAndChange(element)
        return withMeta({ ...base(), ok: true, found: true })
      }

      const isField =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      if (!isField) {
        return withMeta(
          fail(
            `${describeElement(element)} is not a text field. Use click for buttons, or select_option for dropdowns.`,
          ),
        )
      }
      if (element instanceof HTMLInputElement) {
        const type = (element.type || 'text').toLowerCase()
        if (type === 'checkbox' || type === 'radio') {
          return withMeta(
            fail(`${describeElement(element)} is a ${type}; use set_checkbox instead of fill.`),
          )
        }
        if (type === 'file') {
          return withMeta(
            fail(
              'File inputs cannot be filled from an extension: the browser only accepts a real user file selection.',
            ),
          )
        }
      }
      // `clear` defaults to true: "fill" means the field ends up holding exactly
      // this value, which is what a test author means by it.
      const next = op.clear === false ? `${(element as HTMLInputElement).value ?? ''}${value}` : value
      setControlValue(element, next)
      fireInputAndChange(element)
      return withMeta({ ...base(), ok: true, found: true })
    }

    if (op.action === 'select_option') {
      if (!(element instanceof HTMLSelectElement)) {
        return withMeta(fail(`${describeElement(element)} is not a <select>.`))
      }
      const wanted = Array.isArray(op.value) ? op.value.map(String) : [String(op.value ?? '')]
      const available: string[] = []
      const chosen: HTMLOptionElement[] = []
      for (let index = 0; index < element.options.length; index += 1) {
        const option = element.options[index]
        if (!option) continue
        const label = collapse(option.textContent ?? '')
        available.push(label || option.value)
        // Match by value first, then by visible label: a test author reads the
        // label, while a generated script tends to carry the value.
        if (wanted.indexOf(option.value) !== -1 || wanted.indexOf(label) !== -1) {
          chosen.push(option)
        }
      }
      if (chosen.length === 0) {
        return withMeta(
          fail(
            `No option matched ${JSON.stringify(wanted)}. Available options: ${available.join(', ')}`,
          ),
        )
      }
      focusElement(element)
      if (element.multiple) {
        for (let index = 0; index < element.options.length; index += 1) {
          const option = element.options[index]
          if (option) option.selected = chosen.indexOf(option) !== -1
        }
      } else {
        const first = chosen[0]
        if (first) setControlValue(element, first.value)
      }
      fireInputAndChange(element)
      return withMeta({ ...base(), ok: true, found: true })
    }

    if (op.action === 'set_checkbox') {
      const input = element as HTMLInputElement
      const type = (input.type || '').toLowerCase()
      if (type !== 'checkbox' && type !== 'radio') {
        return withMeta(fail(`${describeElement(element)} is not a checkbox or radio.`))
      }
      if (isDisabled(element)) {
        return withMeta(fail(`${describeElement(element)} is disabled.`))
      }
      const desired = op.value === undefined ? true : op.value === true || op.value === 'true'
      if (input.checked === desired) {
        return withMeta({ ...base(), ok: true, found: true, note: 'already in the desired state' })
      }
      // Clicking rather than assigning `checked`, so framework handlers and
      // radio-group exclusivity behave exactly as they do for a user.
      ;(element as HTMLElement).click()
      const ok = input.checked === desired
      return withMeta({
        ...base(),
        ok,
        found: true,
        ...(ok ? {} : { error: 'The control did not change state; something is intercepting it.' }),
      })
    }

    if (op.action === 'press_key') {
      const key = String(op.value ?? '')
      if (!key) return withMeta(fail('press_key needs a key name.'))
      focusElement(element)
      const init: KeyboardEventInit = { key, code: key, bubbles: true, cancelable: true }
      element.dispatchEvent(new KeyboardEvent('keydown', init))
      element.dispatchEvent(new KeyboardEvent('keypress', init))
      element.dispatchEvent(new KeyboardEvent('keyup', init))
      let navigates = false
      // Enter in a single-input form submits it; reproduce that explicitly
      // because a synthetic keydown does not trigger implicit submission.
      if (key === 'Enter') {
        const form = (element as HTMLInputElement).form
        if (form) {
          navigates = true
          if (typeof form.requestSubmit === 'function') form.requestSubmit()
          else form.submit()
        }
      }
      return withMeta({ ...base(), ok: true, found: true, mayNavigate: navigates })
    }

    return fail(`${op.action} is not something the page kernel can do.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...base(), error: `In-page failure: ${message}` }
  }
}
