/**
 * @vitest-environment jsdom
 *
 * Kernel tests.
 *
 * Every case runs twice: once against the imported {@link runOp}, and once
 * against a copy rebuilt from `runOp.toString()` through `new Function`. The
 * rebuilt copy has no access to module scope, exactly like the version Chrome
 * evaluates in the page — so a helper accidentally left at module scope fails
 * here instead of failing in a user's run with `x is not defined`.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { runOp as importedRunOp } from '../src/inpage/kernel'
import { looksUnstable as libLooksUnstable, scoreSpec as libScoreSpec } from '../src/lib/selectors'
import type { Op, OpResult } from '../src/lib/ops'
import type { SelectorSpec, Target } from '../src/lib/selectors'

/**
 * The kernel as Chrome evaluates it: source text, no closure.
 *
 * `executeScript` serializes the function and evaluates the text in the page, so
 * this reconstruction is a faithful model of that boundary.
 */
const rebuiltRunOp = new Function(`return (${importedRunOp.toString()})`)() as typeof importedRunOp

/** Runs a table of assertions against both the imported and rebuilt kernels. */
function bothKernels(name: string, body: (runOp: typeof importedRunOp) => void): void {
  describe(name, () => {
    it('imported kernel', () => body(importedRunOp))
    it('rebuilt from source (no closure)', () => body(rebuiltRunOp))
  })
}

function html(markup: string): void {
  document.body.innerHTML = markup
}

/** Shorthand target from a single spec, matching what the recorder produces. */
function target(spec: SelectorSpec, fallbacks: SelectorSpec[] = []): Target {
  return { primary: spec, fallbacks }
}

function css(selector: string): Target {
  return target({ how: 'css', value: selector })
}

function run(runOp: typeof importedRunOp, op: Op): OpResult {
  return runOp(op)
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.title = 'Test page'
})

// --- The closure guard -------------------------------------------------------

describe('serialization contract', () => {
  it('rebuilds and runs without touching module scope', () => {
    html('<button id="go">Go</button>')
    const result = rebuiltRunOp({ action: 'click', target: css('#go') })
    expect(result.ok).toBe(true)
  })

  it('does not reference any import in its source', () => {
    const source = importedRunOp.toString()
    // A surviving `import`/`require` would mean the bundler left a live binding
    // in the function body, which cannot resolve in the page.
    expect(source).not.toMatch(/\brequire\(/)
    expect(source).not.toMatch(/\bimport\s*\(/)
  })
})

// --- Mirrored logic ----------------------------------------------------------

describe('duplicated selector heuristics stay in sync with lib/selectors', () => {
  /**
   * The kernel cannot import `lib/selectors`, so it carries its own copy of
   * `looksUnstable` and `scoreSpec`. This pins the copies to the originals: a
   * change to one that is not mirrored fails here.
   */
  const values = [
    'login-button',
    'email',
    'user_name',
    'q',
    '',
    '1abc',
    ':r3:',
    'ember1234',
    'react-select-2-input',
    'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    'a1f9c3d2e4b6a8c0',
    'order-1234567',
    'btn_a1f9c3',
    'x'.repeat(65),
  ]

  it('agrees with the library on every stability verdict', () => {
    // The kernel exposes its verdict indirectly: an unstable id must not be
    // chosen as a selector for an element that has one.
    for (const value of values) {
      html(`<button id="${value.replace(/"/g, '')}">Press</button>`)
      const button = document.querySelector('button')
      if (!button) throw new Error('setup failed')
      const snapshot = importedRunOp({ action: 'snapshot' }).page
      const entry = snapshot?.elements.find((element) => element.tag === 'button')
      const specs = entry ? [entry.target.primary, ...entry.target.fallbacks] : []
      const usedId = specs.some((spec) => spec.how === 'id')
      expect(usedId, `${value} → id selector used`).toBe(!libLooksUnstable(value))
    }
  })

  it('agrees with the library on spec ranking', () => {
    // Ranking is observable through which spec becomes primary.
    html('<button data-testid="save" id="save-btn">Save</button>')
    const snapshot = importedRunOp({ action: 'snapshot' }).page
    const entry = snapshot?.elements.find((element) => element.tag === 'button')
    expect(entry?.target.primary.how).toBe('testid')
    expect(libScoreSpec({ how: 'testid', value: 'save' })).toBeGreaterThan(
      libScoreSpec({ how: 'id', value: 'save-btn' }),
    )
  })
})

// --- Resolution --------------------------------------------------------------

bothKernels('resolution', (runOp) => {
  html(`
    <div id="wrap">
      <button data-testid="save">Save</button>
      <button name="cancel">Cancel</button>
      <input id="email" name="email" />
    </div>
  `)

  expect(run(runOp, { action: 'click', target: target({ how: 'testid', value: 'save' }) }).ok).toBe(
    true,
  )
  expect(
    run(runOp, { action: 'click', target: target({ how: 'name', value: 'cancel' }) }).ok,
  ).toBe(true)
  expect(
    run(runOp, { action: 'fill', value: 'a@b.c', target: target({ how: 'id', value: 'email' }) }).ok,
  ).toBe(true)
})

bothKernels('reports not-found separately from failure', (runOp) => {
  html('<button>Save</button>')
  const result = run(runOp, { action: 'click', target: css('#missing') })
  expect(result.ok).toBe(false)
  // `found: false` is what lets the driver keep searching other frames.
  expect(result.found).toBe(false)
  expect(result.error).toContain('No element matched')
  expect(result.error).toContain('css|#missing')
})

bothKernels('falls back when the primary selector no longer matches', (runOp) => {
  html('<button data-testid="new-id">Save</button>')
  const result = run(runOp, {
    action: 'click',
    target: target({ how: 'testid', value: 'old-id' }, [{ how: 'text', value: 'Save', tag: 'button' }]),
  })
  expect(result.ok).toBe(true)
  expect(result.usedFallback).toBe(true)
  expect(result.usedSpec).toContain('text|Save')
})

bothKernels('an invalid selector is a clean miss, not an exception', (runOp) => {
  html('<button>Save</button>')
  const result = run(runOp, { action: 'click', target: css('###:::not valid') })
  expect(result.ok).toBe(false)
  expect(result.found).toBe(false)
})

bothKernels('honours nth so the right row is used', (runOp) => {
  html(`
    <table>
      <tr><td>Alice</td><td><button class="del">Delete</button></td></tr>
      <tr><td>Bob</td><td><button class="del">Delete</button></td></tr>
      <tr><td>Cara</td><td><button class="del">Delete</button></td></tr>
    </table>
  `)
  const clicked: string[] = []
  document.querySelectorAll('button.del').forEach((button, index) => {
    button.addEventListener('click', () => clicked.push(String(index)))
  })
  const result = run(runOp, {
    action: 'click',
    target: target({ how: 'css', value: 'button.del', nth: 1 }),
  })
  expect(result.ok).toBe(true)
  expect(clicked).toEqual(['1'])
  expect(result.matched).toBe(3)
})

bothKernels('reports the match count so an ambiguous selector is visible', (runOp) => {
  html('<button class="x">A</button><button class="x">B</button>')
  const result = run(runOp, { action: 'click', target: css('button.x') })
  expect(result.ok).toBe(true)
  expect(result.matched).toBe(2)
})

bothKernels('prefers a visible match over a hidden duplicate', (runOp) => {
  html(`
    <button class="menu" style="display:none">Menu</button>
    <button class="menu">Menu</button>
  `)
  let clickedVisible = false
  const buttons = document.querySelectorAll('button.menu')
  buttons[1]?.addEventListener('click', () => {
    clickedVisible = true
  })
  const result = run(runOp, { action: 'click', target: css('button.menu') })
  expect(result.ok).toBe(true)
  expect(clickedVisible).toBe(true)
})

bothKernels('resolves an id that is not a valid CSS id selector', (runOp) => {
  html('<button id=":r3:">Generated</button>')
  const result = run(runOp, { action: 'click', target: target({ how: 'id', value: ':r3:' }) })
  expect(result.ok).toBe(true)
})

bothKernels('text matching picks the deepest element, not its ancestors', (runOp) => {
  html('<div><span><button>Unique label</button></span></div>')
  const result = run(runOp, {
    action: 'click',
    target: target({ how: 'text', value: 'Unique label' }),
  })
  expect(result.ok).toBe(true)
  expect(result.usedSpec).toContain('text|Unique label')
})

bothKernels('role matching uses the accessible name', (runOp) => {
  html('<button aria-label="Close dialog">×</button>')
  const result = run(runOp, {
    action: 'click',
    target: target({ how: 'role', value: 'Close dialog', role: 'button' }),
  })
  expect(result.ok).toBe(true)
})

// --- Clicking ----------------------------------------------------------------

bothKernels('click fires the default action, not just an event', (runOp) => {
  html('<form id="f"><button type="submit">Send</button></form>')
  let submitted = false
  document.getElementById('f')?.addEventListener('submit', (event) => {
    event.preventDefault()
    submitted = true
  })
  const result = run(runOp, { action: 'click', target: css('button[type="submit"]') })
  expect(result.ok).toBe(true)
  expect(submitted).toBe(true)
  // The driver needs to know a navigation may follow.
  expect(result.mayNavigate).toBe(true)
})

bothKernels('click reports a plain button as non-navigating', (runOp) => {
  html('<button type="button">Toggle</button>')
  const result = run(runOp, { action: 'click', target: css('button') })
  expect(result.mayNavigate).toBe(false)
})

bothKernels('a fragment link is not treated as a navigation', (runOp) => {
  html('<a href="#section">Jump</a>')
  expect(run(runOp, { action: 'click', target: css('a') }).mayNavigate).toBe(false)
})

bothKernels('a real link is treated as a navigation', (runOp) => {
  html('<a href="/next">Next</a>')
  expect(run(runOp, { action: 'click', target: css('a') }).mayNavigate).toBe(true)
})

bothKernels('click refuses a disabled control instead of silently passing', (runOp) => {
  html('<button disabled>Save</button>')
  const result = run(runOp, { action: 'click', target: css('button') })
  expect(result.ok).toBe(false)
  expect(result.found).toBe(true)
  expect(result.error).toContain('disabled')
})

bothKernels('click refuses a control disabled through aria', (runOp) => {
  html('<div role="button" aria-disabled="true">Save</div>')
  const result = run(runOp, { action: 'click', target: css('[role="button"]') })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('disabled')
})

bothKernels('click refuses a control inside a disabled fieldset', (runOp) => {
  html('<fieldset disabled><button>Save</button></fieldset>')
  expect(run(runOp, { action: 'click', target: css('button') }).ok).toBe(false)
})

bothKernels('click refuses an element hidden by an ancestor', (runOp) => {
  html('<div style="display:none"><button>Hidden</button></div>')
  const result = run(runOp, { action: 'click', target: css('button') })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('not visible')
})

bothKernels('click refuses an aria-hidden subtree', (runOp) => {
  html('<div aria-hidden="true"><button>Hidden</button></div>')
  expect(run(runOp, { action: 'click', target: css('button') }).ok).toBe(false)
})

// --- Filling ----------------------------------------------------------------

bothKernels('fill sets the value and fires input and change', (runOp) => {
  html('<input id="email" />')
  const events: string[] = []
  const input = document.getElementById('email') as HTMLInputElement
  input.addEventListener('input', () => events.push('input'))
  input.addEventListener('change', () => events.push('change'))

  const result = run(runOp, { action: 'fill', target: css('#email'), value: 'a@b.c' })
  expect(result.ok).toBe(true)
  expect(input.value).toBe('a@b.c')
  expect(events).toEqual(['input', 'change'])
})

bothKernels('fill replaces the existing value by default', (runOp) => {
  html('<input id="q" value="old" />')
  run(runOp, { action: 'fill', target: css('#q'), value: 'new' })
  expect((document.getElementById('q') as HTMLInputElement).value).toBe('new')
})

bothKernels('fill appends when clear is false', (runOp) => {
  html('<input id="q" value="old" />')
  run(runOp, { action: 'fill', target: css('#q'), value: '+more', clear: false })
  expect((document.getElementById('q') as HTMLInputElement).value).toBe('old+more')
})

bothKernels('fill uses the prototype setter so framework trackers stay correct', (runOp) => {
  html('<input id="react-ish" />')
  const input = document.getElementById('react-ish') as HTMLInputElement
  // Emulate React's instance-level value setter, which shadows the prototype's.
  // A kernel that assigned `element.value` directly would hit this and never
  // reach the real DOM value, which is the bug this design avoids.
  let sawInstanceSetter = false
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() {
      return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.get?.call(this)
    },
    set() {
      sawInstanceSetter = true
    },
  })
  const result = run(runOp, { action: 'fill', target: css('#react-ish'), value: 'typed' })
  expect(result.ok).toBe(true)
  expect(sawInstanceSetter).toBe(false)
  const nativeGet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.get
  expect(nativeGet?.call(input)).toBe('typed')
})

bothKernels('fill works on a textarea', (runOp) => {
  html('<textarea id="notes"></textarea>')
  run(runOp, { action: 'fill', target: css('#notes'), value: 'line' })
  expect((document.getElementById('notes') as HTMLTextAreaElement).value).toBe('line')
})

bothKernels('fill works on a contenteditable region', (runOp) => {
  html('<div id="rich" contenteditable="true"></div>')
  const result = run(runOp, { action: 'fill', target: css('#rich'), value: 'rich text' })
  expect(result.ok).toBe(true)
  expect(document.getElementById('rich')?.textContent).toBe('rich text')
})

bothKernels('fill refuses a checkbox and names the right tool', (runOp) => {
  html('<input type="checkbox" id="agree" />')
  const result = run(runOp, { action: 'fill', target: css('#agree'), value: 'true' })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('set_checkbox')
})

bothKernels('fill refuses a file input with an explanation', (runOp) => {
  html('<input type="file" id="upload" />')
  const result = run(runOp, { action: 'fill', target: css('#upload'), value: 'C:/x.png' })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('File inputs')
})

bothKernels('fill refuses a non-field element', (runOp) => {
  html('<div id="plain">text</div>')
  const result = run(runOp, { action: 'fill', target: css('#plain'), value: 'x' })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('not a text field')
})

bothKernels('fill refuses a disabled field', (runOp) => {
  html('<input id="q" disabled />')
  expect(run(runOp, { action: 'fill', target: css('#q'), value: 'x' }).ok).toBe(false)
})

bothKernels('fill treats a missing value as clearing the field', (runOp) => {
  html('<input id="q" value="old" />')
  const result = run(runOp, { action: 'fill', target: css('#q') })
  expect(result.ok).toBe(true)
  expect((document.getElementById('q') as HTMLInputElement).value).toBe('')
})

// --- Selects and checkboxes --------------------------------------------------

bothKernels('select_option matches by value or by visible label', (runOp) => {
  html(`
    <select id="city">
      <option value="bj">Beijing</option>
      <option value="sh">Shanghai</option>
    </select>
  `)
  const select = document.getElementById('city') as HTMLSelectElement

  expect(run(runOp, { action: 'select_option', target: css('#city'), value: 'sh' }).ok).toBe(true)
  expect(select.value).toBe('sh')

  expect(run(runOp, { action: 'select_option', target: css('#city'), value: 'Beijing' }).ok).toBe(
    true,
  )
  expect(select.value).toBe('bj')
})

bothKernels('select_option lists the available options when nothing matches', (runOp) => {
  html('<select id="city"><option value="bj">Beijing</option></select>')
  const result = run(runOp, { action: 'select_option', target: css('#city'), value: 'Paris' })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('Beijing')
})

bothKernels('select_option handles a multiple select', (runOp) => {
  html(`
    <select id="tags" multiple>
      <option value="a">Alpha</option>
      <option value="b">Beta</option>
      <option value="c">Gamma</option>
    </select>
  `)
  const result = run(runOp, { action: 'select_option', target: css('#tags'), value: ['a', 'c'] })
  expect(result.ok).toBe(true)
  const select = document.getElementById('tags') as HTMLSelectElement
  expect([...select.selectedOptions].map((option) => option.value)).toEqual(['a', 'c'])
})

bothKernels('select_option refuses a non-select element', (runOp) => {
  html('<input id="q" />')
  expect(run(runOp, { action: 'select_option', target: css('#q'), value: 'x' }).ok).toBe(false)
})

bothKernels('set_checkbox checks and unchecks through a real click', (runOp) => {
  html('<input type="checkbox" id="agree" />')
  const box = document.getElementById('agree') as HTMLInputElement

  expect(run(runOp, { action: 'set_checkbox', target: css('#agree'), value: true }).ok).toBe(true)
  expect(box.checked).toBe(true)

  expect(run(runOp, { action: 'set_checkbox', target: css('#agree'), value: false }).ok).toBe(true)
  expect(box.checked).toBe(false)
})

bothKernels('set_checkbox is idempotent and says so', (runOp) => {
  html('<input type="checkbox" id="agree" checked />')
  const result = run(runOp, { action: 'set_checkbox', target: css('#agree'), value: true })
  expect(result.ok).toBe(true)
  expect(result.note).toContain('already')
})

bothKernels('set_checkbox respects radio-group exclusivity', (runOp) => {
  html(`
    <input type="radio" name="plan" id="basic" value="basic" checked />
    <input type="radio" name="plan" id="pro" value="pro" />
  `)
  run(runOp, { action: 'set_checkbox', target: css('#pro'), value: true })
  expect((document.getElementById('pro') as HTMLInputElement).checked).toBe(true)
  expect((document.getElementById('basic') as HTMLInputElement).checked).toBe(false)
})

bothKernels('set_checkbox refuses a non-checkbox', (runOp) => {
  html('<input type="text" id="q" />')
  expect(run(runOp, { action: 'set_checkbox', target: css('#q'), value: true }).ok).toBe(false)
})

bothKernels('set_checkbox reports a click that was intercepted', (runOp) => {
  html('<input type="checkbox" id="agree" />')
  document.getElementById('agree')?.addEventListener('click', (event) => event.preventDefault())
  const result = run(runOp, { action: 'set_checkbox', target: css('#agree'), value: true })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('intercepting')
})

// --- Keyboard ---------------------------------------------------------------

bothKernels('press_key dispatches a key sequence at the target', (runOp) => {
  html('<input id="q" />')
  const keys: string[] = []
  document.getElementById('q')?.addEventListener('keydown', (event) => keys.push(event.key))
  const result = run(runOp, { action: 'press_key', target: css('#q'), value: 'Escape' })
  expect(result.ok).toBe(true)
  expect(keys).toEqual(['Escape'])
})

bothKernels('Enter in a form submits it, as it would for a user', (runOp) => {
  html('<form id="f"><input id="q" /></form>')
  let submitted = false
  document.getElementById('f')?.addEventListener('submit', (event) => {
    event.preventDefault()
    submitted = true
  })
  const result = run(runOp, { action: 'press_key', target: css('#q'), value: 'Enter' })
  expect(result.ok).toBe(true)
  expect(submitted).toBe(true)
  expect(result.mayNavigate).toBe(true)
})

bothKernels('press_key without a target goes to the focused element', (runOp) => {
  html('<input id="q" />')
  const input = document.getElementById('q') as HTMLInputElement
  input.focus()
  const keys: string[] = []
  document.addEventListener('keydown', (event) => keys.push(event.key), { once: true })
  const result = run(runOp, { action: 'press_key', value: 'Tab' })
  expect(result.ok).toBe(true)
  expect(keys).toEqual(['Tab'])
})

bothKernels('press_key needs a key name', (runOp) => {
  html('<input id="q" />')
  expect(run(runOp, { action: 'press_key', target: css('#q'), value: '' }).ok).toBe(false)
  expect(run(runOp, { action: 'press_key' }).ok).toBe(false)
})

// --- Assertions --------------------------------------------------------------

bothKernels('assert text checks the target, or the page without one', (runOp) => {
  html('<div id="banner">Welcome back, Alice</div>')

  const scoped = run(runOp, {
    action: 'assert',
    target: css('#banner'),
    assert: { kind: 'text', expected: 'Welcome back' },
  })
  expect(scoped.ok).toBe(true)
  expect(scoped.assertion?.passed).toBe(true)

  const page = run(runOp, { action: 'assert', assert: { kind: 'text', expected: 'Alice' } })
  expect(page.ok).toBe(true)
})

bothKernels('a failed assertion reports the actual value', (runOp) => {
  html('<div id="banner">Goodbye</div>')
  const result = run(runOp, {
    action: 'assert',
    target: css('#banner'),
    assert: { kind: 'text', expected: 'Welcome' },
  })
  expect(result.ok).toBe(false)
  expect(result.assertion?.actual).toBe('Goodbye')
  expect(result.error).toContain('Goodbye')
})

bothKernels('assert visible and hidden are genuinely opposite', (runOp) => {
  html('<div id="a">shown</div><div id="b" style="display:none">gone</div>')
  expect(run(runOp, { action: 'assert', target: css('#a'), assert: { kind: 'visible', expected: '' } }).ok).toBe(true)
  expect(run(runOp, { action: 'assert', target: css('#b'), assert: { kind: 'visible', expected: '' } }).ok).toBe(false)
  expect(run(runOp, { action: 'assert', target: css('#b'), assert: { kind: 'hidden', expected: '' } }).ok).toBe(true)
  expect(run(runOp, { action: 'assert', target: css('#a'), assert: { kind: 'hidden', expected: '' } }).ok).toBe(false)
})

bothKernels('assert hidden passes for an element that is absent entirely', (runOp) => {
  html('<div>nothing here</div>')
  const result = run(runOp, {
    action: 'assert',
    target: css('#never'),
    assert: { kind: 'hidden', expected: '' },
  })
  expect(result.ok).toBe(true)
})

bothKernels('assert value compares exactly', (runOp) => {
  html('<input id="q" value="abc" />')
  expect(run(runOp, { action: 'assert', target: css('#q'), assert: { kind: 'value', expected: 'abc' } }).ok).toBe(true)
  expect(run(runOp, { action: 'assert', target: css('#q'), assert: { kind: 'value', expected: 'ab' } }).ok).toBe(false)
})

bothKernels('assert count counts every match', (runOp) => {
  html('<li class="row">1</li><li class="row">2</li><li class="row">3</li>')
  expect(run(runOp, { action: 'assert', target: css('li.row'), assert: { kind: 'count', expected: '3' } }).ok).toBe(true)
  expect(run(runOp, { action: 'assert', target: css('li.row'), assert: { kind: 'count', expected: '2' } }).ok).toBe(false)
})

bothKernels('assert attr, enabled, and checked', (runOp) => {
  html(`
    <a id="link" href="/next" >Next</a>
    <button id="on">On</button>
    <button id="off" disabled>Off</button>
    <input type="checkbox" id="box" checked />
  `)
  expect(run(runOp, { action: 'assert', target: css('#link'), assert: { kind: 'attr', attr: 'href', expected: '/next' } }).ok).toBe(true)
  expect(run(runOp, { action: 'assert', target: css('#on'), assert: { kind: 'enabled', expected: '' } }).ok).toBe(true)
  expect(run(runOp, { action: 'assert', target: css('#off'), assert: { kind: 'enabled', expected: '' } }).ok).toBe(false)
  expect(run(runOp, { action: 'assert', target: css('#box'), assert: { kind: 'checked', expected: '' } }).ok).toBe(true)
})

bothKernels('assert url and title need no target', (runOp) => {
  document.title = 'Dashboard'
  expect(run(runOp, { action: 'assert', assert: { kind: 'title', expected: 'Dash' } }).ok).toBe(true)
  expect(run(runOp, { action: 'assert', assert: { kind: 'url', expected: 'localhost' } }).ok).toBe(true)
  expect(run(runOp, { action: 'assert', assert: { kind: 'url', expected: 'nowhere.test' } }).ok).toBe(false)
})

bothKernels('negate inverts the outcome', (runOp) => {
  html('<div id="banner">Goodbye</div>')
  const result = run(runOp, {
    action: 'assert',
    target: css('#banner'),
    assert: { kind: 'text', expected: 'Welcome', negate: true },
  })
  expect(result.ok).toBe(true)
})

bothKernels('assert collapses whitespace before comparing text', (runOp) => {
  html('<div id="banner">Welcome\n\n   back</div>')
  expect(
    run(runOp, {
      action: 'assert',
      target: css('#banner'),
      assert: { kind: 'text', expected: 'Welcome back' },
    }).ok,
  ).toBe(true)
})

// --- Extraction --------------------------------------------------------------

bothKernels('extract pulls text from every match', (runOp) => {
  html('<li class="row">One</li><li class="row">Two</li>')
  const result = run(runOp, { action: 'extract', target: css('li.row'), extract: { kind: 'text' } })
  expect(result.ok).toBe(true)
  expect(result.extracted).toEqual({ kind: 'strings', values: ['One', 'Two'] })
})

bothKernels('extract reads values and attributes', (runOp) => {
  html('<input id="q" value="typed" /><a id="l" href="/x">L</a>')
  expect(
    run(runOp, { action: 'extract', target: css('#q'), extract: { kind: 'value' } }).extracted,
  ).toEqual({ kind: 'strings', values: ['typed'] })
  expect(
    run(runOp, { action: 'extract', target: css('#l'), extract: { kind: 'attr', attr: 'href' } })
      .extracted,
  ).toEqual({ kind: 'strings', values: ['/x'] })
})

bothKernels('extract parses a table into headers and rows', (runOp) => {
  html(`
    <table id="t">
      <thead><tr><th>Name</th><th>Age</th></tr></thead>
      <tbody>
        <tr><td>Alice</td><td>30</td></tr>
        <tr><td>Bob</td><td>41</td></tr>
      </tbody>
    </table>
  `)
  const result = run(runOp, { action: 'extract', target: css('#t'), extract: { kind: 'table' } })
  expect(result.ok).toBe(true)
  expect(result.extracted).toEqual({
    kind: 'table',
    headers: ['Name', 'Age'],
    rows: [
      ['Alice', '30'],
      ['Bob', '41'],
    ],
  })
})

bothKernels('extract table fails clearly when there is no table', (runOp) => {
  html('<div id="d">not a table</div>')
  const result = run(runOp, { action: 'extract', target: css('#d'), extract: { kind: 'table' } })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('table')
})

// --- Snapshot ---------------------------------------------------------------

bothKernels('snapshot lists interactive elements with durable targets', (runOp) => {
  html(`
    <h1>Login</h1>
    <form name="login">
      <label for="user">Username</label>
      <input id="user" name="user" required />
      <label for="pw">Password</label>
      <input id="pw" name="pw" type="password" value="secret" />
      <select id="role" name="role"><option value="a">Admin</option><option value="u">User</option></select>
      <button data-testid="submit" type="submit">Sign in</button>
    </form>
  `)
  const result = run(runOp, { action: 'snapshot' })
  expect(result.ok).toBe(true)
  const page = result.page
  if (!page) throw new Error('no page')

  expect(page.title).toBe('Test page')
  expect(page.elements.length).toBeGreaterThanOrEqual(4)
  expect(page.elements.map((element) => element.ref)).toEqual(
    page.elements.map((_, index) => `e${index + 1}`),
  )

  const submit = page.elements.find((element) => element.tag === 'button')
  expect(submit?.target.primary).toEqual({ how: 'testid', value: 'submit' })
  expect(submit?.name).toBe('Sign in')
  expect(submit?.role).toBe('button')

  const user = page.elements.find((element) => element.tag === 'input' && element.type === 'text')
  expect(user?.name).toBe('Username')
})

bothKernels('snapshot never reveals a password value', (runOp) => {
  html('<input id="pw" type="password" value="hunter2" />')
  const page = run(runOp, { action: 'snapshot' }).page
  const field = page?.elements.find((element) => element.type === 'password')
  expect(field).toBeDefined()
  expect(field).not.toHaveProperty('value')
  expect(JSON.stringify(page)).not.toContain('hunter2')
})

bothKernels('snapshot reports disabled and checked state', (runOp) => {
  html(`
    <button id="off" disabled>Off</button>
    <input type="checkbox" id="box" checked />
  `)
  const page = run(runOp, { action: 'snapshot' }).page
  expect(page?.elements.find((element) => element.tag === 'button')?.disabled).toBe(true)
  const box = page?.elements.find((element) => element.type === 'checkbox')
  expect(box?.checked).toBe(true)
})

bothKernels('snapshot omits hidden elements', (runOp) => {
  html(`
    <button>Visible</button>
    <button style="display:none">Hidden</button>
    <input type="hidden" name="csrf" value="x" />
  `)
  const page = run(runOp, { action: 'snapshot' }).page
  const names = page?.elements.map((element) => element.name) ?? []
  expect(names).toContain('Visible')
  expect(names).not.toContain('Hidden')
  expect(page?.elements.some((element) => element.type === 'hidden')).toBe(false)
})

bothKernels('snapshot summarises forms with select options', (runOp) => {
  html(`
    <form name="signup">
      <label for="email">Email</label><input id="email" name="email" required />
      <select id="plan" name="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
    </form>
  `)
  const page = run(runOp, { action: 'snapshot' }).page
  expect(page?.forms).toHaveLength(1)
  const form = page?.forms[0]
  expect(form?.name).toBe('signup')
  const email = form?.fields.find((field) => field.label === 'Email')
  expect(email?.required).toBe(true)
  const plan = form?.fields.find((field) => field.tag === 'select')
  expect(plan?.options).toEqual(['Free', 'Pro'])
})

bothKernels('snapshot honours the element budget and flags truncation', (runOp) => {
  html(Array.from({ length: 10 }, (_, index) => `<button>B${index}</button>`).join(''))
  const page = run(runOp, { action: 'snapshot', maxElements: 3 }).page
  expect(page?.elements).toHaveLength(3)
  expect(page?.elementsTruncated).toBe(true)
})

bothKernels('read_page truncates long text and flags it', (runOp) => {
  html(`<p>${'x'.repeat(1000)}</p>`)
  const page = run(runOp, { action: 'read_page', maxChars: 200 }).page
  expect(page?.text.length).toBe(200)
  expect(page?.truncated).toBe(true)
})

bothKernels('read_page excludes script and style content', (runOp) => {
  html('<p>Real text</p><script>var secret = "do not read me"</script><style>.a{color:red}</style>')
  const page = run(runOp, { action: 'read_page' }).page
  expect(page?.text).toContain('Real text')
  expect(page?.text).not.toContain('do not read me')
  expect(page?.text).not.toContain('color:red')
})

// --- Accessible names -------------------------------------------------------

bothKernels('accessible name follows aria-labelledby, aria-label, then label', (runOp) => {
  html(`
    <span id="lbl">From labelledby</span>
    <button aria-labelledby="lbl" aria-label="ignored">x</button>
    <button aria-label="From aria-label">y</button>
    <label for="i1">From label</label><input id="i1" />
    <input id="i2" placeholder="From placeholder" />
    <input id="i3" title="From title" />
    <label>Wrapping <input id="i4" /></label>
  `)
  const page = run(runOp, { action: 'snapshot' }).page
  const names = page?.elements.map((element) => element.name) ?? []
  expect(names).toContain('From labelledby')
  expect(names).toContain('From aria-label')
  expect(names).toContain('From label')
  expect(names).toContain('From placeholder')
  expect(names).toContain('From title')
  expect(names).toContain('Wrapping')
})

bothKernels('a submit input is named by its value', (runOp) => {
  html('<input type="submit" value="Send it" />')
  const page = run(runOp, { action: 'snapshot' }).page
  expect(page?.elements[0]?.name).toBe('Send it')
})

// --- Roles ------------------------------------------------------------------

bothKernels('roles are inferred from tag and input type', (runOp) => {
  html(`
    <a href="/x">link</a>
    <button>button</button>
    <input type="text" /><input type="checkbox" /><input type="radio" />
    <input type="submit" value="s" /><input type="search" /><input type="number" />
    <select><option>o</option></select>
    <textarea></textarea>
    <div role="tab">tab</div>
  `)
  const page = run(runOp, { action: 'snapshot' }).page
  const roles = page?.elements.map((element) => element.role) ?? []
  expect(roles).toContain('link')
  expect(roles).toContain('button')
  expect(roles).toContain('textbox')
  expect(roles).toContain('checkbox')
  expect(roles).toContain('radio')
  expect(roles).toContain('searchbox')
  expect(roles).toContain('spinbutton')
  expect(roles).toContain('combobox')
  expect(roles).toContain('tab')
})

bothKernels('an anchor without href is not a link', (runOp) => {
  html('<a data-testid="anchor">no href</a>')
  const page = run(runOp, { action: 'snapshot' }).page
  const anchor = page?.elements.find((element) => element.tag === 'a')
  // Without href it is not interactive, so it should not be listed as a link.
  expect(anchor?.role).not.toBe('link')
})

// --- Frames and shape -------------------------------------------------------

bothKernels('every result carries frame identity', (runOp) => {
  html('<button id="b">B</button>')
  const result = run(runOp, { action: 'click', target: css('#b') })
  expect(typeof result.frameUrl).toBe('string')
  expect(result.isTopFrame).toBe(true)
})

bothKernels('an unsupported action fails instead of throwing', (runOp) => {
  html('<button id="b">B</button>')
  const result = run(runOp, { action: 'open_url' as Op['action'], target: css('#b') })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('kernel')
})

bothKernels('an action needing a target says so when given none', (runOp) => {
  const result = run(runOp, { action: 'click' })
  expect(result.ok).toBe(false)
  expect(result.found).toBe(false)
  expect(result.error).toContain('needs a target')
})

bothKernels('probeOnly resolves without acting', (runOp) => {
  html('<button id="b">B</button>')
  let clicked = false
  document.getElementById('b')?.addEventListener('click', () => {
    clicked = true
  })
  const result = run(runOp, { action: 'click', target: css('#b'), probeOnly: true })
  expect(result.ok).toBe(true)
  expect(clicked).toBe(false)
})

bothKernels('wait_for reports whether the element is visible yet', (runOp) => {
  html('<div id="spinner" style="display:none">Loading</div><div id="done">Ready</div>')
  expect(run(runOp, { action: 'wait_for', target: css('#done') }).ok).toBe(true)
  const pending = run(runOp, { action: 'wait_for', target: css('#spinner') })
  expect(pending.ok).toBe(false)
  expect(pending.found).toBe(true)
})

bothKernels('scroll without a target scrolls the window', (runOp) => {
  html('<div style="height:3000px">tall</div>')
  const result = run(runOp, { action: 'scroll', scroll: { mode: 'bottom' } })
  expect(result.ok).toBe(true)
  expect(result.note).toContain('bottom')
})

bothKernels('scroll with a target scrolls it into view', (runOp) => {
  html('<div id="target">here</div>')
  const result = run(runOp, { action: 'scroll', target: css('#target'), scroll: { mode: 'into_view' } })
  expect(result.ok).toBe(true)
})

bothKernels('screenshot resolves the element and reports its box', (runOp) => {
  html('<button id="b">B</button>')
  const result = run(runOp, { action: 'screenshot', target: css('#b') })
  expect(result.ok).toBe(true)
  expect(result.found).toBe(true)
})
