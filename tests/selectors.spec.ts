import { describe, expect, it } from 'vitest'

import {
  buildTarget,
  describeSpec,
  describeTarget,
  candidateSpecs,
  looksUnstable,
  quoteAttributeValue,
  scoreSpec,
  serializeSpec,
  specToCss,
  type SelectorSpec,
} from '../src/lib/selectors'

describe('looksUnstable', () => {
  it('accepts hand-authored identifiers', () => {
    for (const value of ['login-button', 'email', 'user_name', 'submitForm', 'q']) {
      expect(looksUnstable(value), value).toBe(false)
    }
  })

  it('rejects framework-generated identifiers', () => {
    const generated = [
      '',
      '   ',
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
    for (const value of generated) {
      expect(looksUnstable(value), value).toBe(true)
    }
  })
})

describe('scoreSpec', () => {
  it('prefers test ids over structural css', () => {
    const testid = scoreSpec({ how: 'testid', value: 'submit' })
    const css = scoreSpec({ how: 'css', value: 'div > form > button' })
    expect(testid).toBeGreaterThan(css)
  })

  it('penalises an indexed match', () => {
    const plain = scoreSpec({ how: 'text', value: 'Delete' })
    const indexed = scoreSpec({ how: 'text', value: 'Delete', nth: 2 })
    expect(indexed).toBeLessThan(plain)
  })

  it('does not penalise nth of zero, which still means the only match', () => {
    expect(scoreSpec({ how: 'text', value: 'Delete', nth: 0 })).toBe(
      scoreSpec({ how: 'text', value: 'Delete' }),
    )
  })

  it('penalises deeper css paths more', () => {
    const shallow = scoreSpec({ how: 'css', value: 'form > button' })
    const deep = scoreSpec({ how: 'css', value: 'body > div > div > form > div > button' })
    expect(deep).toBeLessThan(shallow)
  })
})

describe('buildTarget', () => {
  it('promotes the most durable spec to primary and keeps the rest ordered', () => {
    const target = buildTarget([
      { how: 'css', value: 'form > button' },
      { how: 'text', value: 'Sign in' },
      { how: 'testid', value: 'signin' },
    ])
    expect(target?.primary).toEqual({ how: 'testid', value: 'signin' })
    expect(target?.fallbacks.map((spec) => spec.how)).toEqual(['text', 'css'])
  })

  it('collapses duplicate specs so replay never retries the same selector', () => {
    const duplicate: SelectorSpec = { how: 'id', value: 'email' }
    const target = buildTarget([duplicate, { ...duplicate }, { how: 'text', value: 'Email' }])
    expect(target?.fallbacks).toHaveLength(1)
  })

  it('treats specs differing only by nth as distinct', () => {
    const target = buildTarget([
      { how: 'text', value: 'Delete' },
      { how: 'text', value: 'Delete', nth: 1 },
    ])
    expect(candidateSpecs(target!)).toHaveLength(2)
  })

  it('returns null when there is nothing to target', () => {
    expect(buildTarget([])).toBeNull()
  })

  it('carries the frame hint and label only when supplied', () => {
    const bare = buildTarget([{ how: 'id', value: 'a' }])
    expect(bare).not.toHaveProperty('frameHint')
    expect(bare).not.toHaveProperty('label')

    const full = buildTarget([{ how: 'id', value: 'a' }], {
      frameHint: 'https://example.com/frame',
      label: 'Submit',
    })
    expect(full?.frameHint).toBe('https://example.com/frame')
    expect(full?.label).toBe('Submit')
  })
})

describe('serializeSpec', () => {
  it('distinguishes specs that differ only in role or index', () => {
    const a = serializeSpec({ how: 'role', value: 'Save', role: 'button' })
    const b = serializeSpec({ how: 'role', value: 'Save', role: 'link' })
    const c = serializeSpec({ how: 'role', value: 'Save', role: 'button', nth: 1 })
    expect(new Set([a, b, c]).size).toBe(3)
  })
})

describe('describeSpec', () => {
  it('renders each kind readably and one-indexes nth for humans', () => {
    expect(describeSpec({ how: 'testid', value: 'submit' })).toBe('test id "submit"')
    expect(describeSpec({ how: 'id', value: 'email' })).toBe('id "email"')
    expect(describeSpec({ how: 'name', value: 'pw' })).toBe('name "pw"')
    expect(describeSpec({ how: 'role', value: 'Save', role: 'button' })).toBe(
      'button named "Save"',
    )
    expect(describeSpec({ how: 'role', value: '', role: 'textbox' })).toBe('textbox')
    expect(describeSpec({ how: 'text', value: 'Delete', nth: 1 })).toBe('text "Delete" #2')
    expect(describeSpec({ how: 'css', value: 'form > button' })).toBe('css form > button')
    expect(describeSpec({ how: 'xpath', value: '//button' })).toBe('xpath //button')
  })
})

describe('describeTarget', () => {
  it('prefers the recorded label, falling back to the primary spec', () => {
    const target = buildTarget([{ how: 'id', value: 'email' }], { label: 'Email field' })!
    expect(describeTarget(target)).toBe('Email field')

    const unlabelled = buildTarget([{ how: 'id', value: 'email' }])!
    expect(describeTarget(unlabelled)).toBe('id "email"')
    expect(describeTarget(undefined)).toBe('the page')
  })

  it('ignores a whitespace-only label', () => {
    const target = buildTarget([{ how: 'id', value: 'email' }], { label: '   ' })!
    expect(describeTarget(target)).toBe('id "email"')
  })
})

describe('specToCss', () => {
  it('builds attribute selectors and escapes quotes', () => {
    expect(specToCss({ how: 'testid', value: 'submit' })).toBe('[data-testid="submit"]')
    expect(specToCss({ how: 'testid', value: 'data-cy=submit' })).toBe('[data-cy="submit"]')
    expect(specToCss({ how: 'id', value: 'email', tag: 'input' })).toBe('input[id="email"]')
    expect(specToCss({ how: 'name', value: 'pw' })).toBe('[name="pw"]')
    expect(specToCss({ how: 'css', value: 'form > button' })).toBe('form > button')
  })

  it('uses an attribute selector for ids, so generated ids never break the query', () => {
    // `#:r3:` is not a parseable CSS id selector; `[id=":r3:"]` is.
    expect(specToCss({ how: 'id', value: ':r3:' })).toBe('[id=":r3:"]')
  })

  it('has no css equivalent for text and role', () => {
    expect(specToCss({ how: 'text', value: 'Save' })).toBeNull()
    expect(specToCss({ how: 'role', value: 'Save', role: 'button' })).toBeNull()
  })
})

describe('quoteAttributeValue', () => {
  it('escapes backslashes before quotes', () => {
    expect(quoteAttributeValue('a"b')).toBe('"a\\"b"')
    expect(quoteAttributeValue('a\\b')).toBe('"a\\\\b"')
  })
})
