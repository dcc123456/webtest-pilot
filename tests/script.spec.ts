import { describe, expect, it } from 'vitest'

import {
  DEFAULT_STEP_TIMEOUT_MS,
  describeStep,
  describeValue,
  exportPlaywright,
  exportScriptMarkdown,
  isBrowserAction,
  parseScriptJson,
  specToPlaywright,
  toScriptJson,
  validateScript,
} from '../src/lib/script'
import { SCRIPT_VERSION, type ScriptStep, type TestScript } from '../src/lib/types'

let counter = 0
const newId = (): string => `id-${(counter += 1)}`

function script(steps: ScriptStep[], overrides: Partial<TestScript> = {}): TestScript {
  return {
    id: 's1',
    name: 'Login smoke',
    startUrl: 'https://app.test/login',
    steps,
    version: SCRIPT_VERSION,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const submit = {
  primary: { how: 'testid' as const, value: 'submit' },
  fallbacks: [{ how: 'text' as const, value: 'Sign in', tag: 'button' }],
  label: 'Sign in',
}
const email = { primary: { how: 'id' as const, value: 'email' }, fallbacks: [], label: 'Email' }

describe('validateScript', () => {
  it('accepts a complete script', () => {
    expect(
      validateScript(
        script([
          { action: 'fill', target: email, value: 'a@b.c' },
          { action: 'click', target: submit },
          { action: 'assert', assert: { kind: 'url', expected: '/dashboard' } },
        ]),
      ),
    ).toEqual([])
  })

  it('requires a name and at least one step', () => {
    const problems = validateScript(script([], { name: '  ' }))
    const messages = problems.map((problem) => problem.message).join(' ')
    expect(messages).toContain('name')
    expect(messages).toContain('no steps')
  })

  it('requires a target for actions that need one', () => {
    for (const action of ['click', 'hover', 'fill', 'select_option', 'set_checkbox'] as const) {
      const problems = validateScript(script([{ action, value: 'x' }]))
      expect(problems[0]?.message, action).toContain('needs a target')
      expect(problems[0]?.stepIndex).toBe(0)
    }
  })

  it('lets fill carry an empty value, which is how a field is cleared', () => {
    expect(validateScript(script([{ action: 'fill', target: email }]))).toEqual([])
  })

  it('requires a value for actions that need one', () => {
    expect(validateScript(script([{ action: 'press_key', target: email }]))[0]?.message).toContain(
      'needs a value',
    )
    expect(validateScript(script([{ action: 'open_url' }]))[0]?.message).toContain('needs a value')
  })

  it('accepts a secretRef in place of a value', () => {
    expect(
      validateScript(script([{ action: 'fill', target: email, secretRef: 'LOGIN_PW' }])),
    ).toEqual([])
  })

  it('rejects a step with both a literal value and a secretRef', () => {
    const problems = validateScript(
      script([{ action: 'fill', target: email, value: 'x', secretRef: 'PW' }]),
    )
    expect(problems.some((problem) => problem.message.includes('both'))).toBe(true)
  })

  it('requires an assertion specification for assert', () => {
    expect(validateScript(script([{ action: 'assert' }]))[0]?.message).toContain('assertion')
  })

  it('requires an attribute name for an attr assertion', () => {
    const problems = validateScript(
      script([{ action: 'assert', target: submit, assert: { kind: 'attr', expected: 'x' } }]),
    )
    expect(problems[0]?.message).toContain('attribute name')
  })

  it('requires a numeric expectation for a count assertion', () => {
    const problems = validateScript(
      script([{ action: 'assert', target: submit, assert: { kind: 'count', expected: 'many' } }]),
    )
    expect(problems[0]?.message).toContain('numeric')
  })

  it('rejects a non-http start URL and open_url value', () => {
    const startUrlProblems = validateScript(
      script([{ action: 'go_back' }], { startUrl: 'file:///x' }),
    )
    expect(startUrlProblems.map((problem) => problem.message).join(' ')).toContain('http')
    expect(
      validateScript(script([{ action: 'open_url', value: 'chrome://settings' }]))[0]?.message,
    ).toContain('http')
  })

  it('rejects a non-positive timeout', () => {
    expect(
      validateScript(script([{ action: 'click', target: submit, timeoutMs: 0 }]))[0]?.message,
    ).toContain('positive')
  })

  it('reports every problem, not just the first', () => {
    const problems = validateScript(script([{ action: 'click' }, { action: 'assert' }], { name: '' }))
    expect(problems.length).toBeGreaterThanOrEqual(3)
  })
})

describe('isBrowserAction', () => {
  it('separates browser-level actions from in-page ones', () => {
    expect(isBrowserAction('open_url')).toBe(true)
    expect(isBrowserAction('tab_new')).toBe(true)
    expect(isBrowserAction('go_back')).toBe(true)
    expect(isBrowserAction('click')).toBe(false)
    expect(isBrowserAction('assert')).toBe(false)
  })
})

describe('describeValue', () => {
  it('masks a secret instead of printing it', () => {
    expect(describeValue({ action: 'fill', secretRef: 'LOGIN_PW' })).toBe('«LOGIN_PW»')
  })

  it('joins a multi-select value', () => {
    expect(describeValue({ action: 'select_option', value: ['a', 'b'] })).toBe('a, b')
  })

  it('renders a boolean and an absent value', () => {
    expect(describeValue({ action: 'set_checkbox', value: true })).toBe('true')
    expect(describeValue({ action: 'click' })).toBe('')
  })
})

describe('describeStep', () => {
  it('reads as an instruction for every action', () => {
    const cases: [ScriptStep, string][] = [
      [{ action: 'open_url', value: 'https://a.test' }, 'open https://a.test'],
      [{ action: 'click', target: submit }, 'click Sign in'],
      [{ action: 'hover', target: submit }, 'hover Sign in'],
      [{ action: 'fill', target: email, value: 'a@b.c' }, 'fill Email with "a@b.c"'],
      [{ action: 'select_option', target: email, value: 'Pro' }, 'select "Pro" in Email'],
      [{ action: 'set_checkbox', target: submit, value: true }, 'check Sign in'],
      [{ action: 'set_checkbox', target: submit, value: false }, 'uncheck Sign in'],
      [{ action: 'press_key', value: 'Enter' }, 'press Enter'],
      [{ action: 'scroll', scroll: { mode: 'bottom' } }, 'scroll bottom'],
      [{ action: 'scroll', target: submit }, 'scroll Sign in into view'],
      [{ action: 'wait_for', target: submit }, 'wait for Sign in'],
      [{ action: 'go_back' }, 'go back'],
      [{ action: 'read_page' }, 'read the page'],
      [{ action: 'snapshot' }, 'snapshot the page'],
      [{ action: 'tab_new', value: 'https://a.test' }, 'open a new tab at https://a.test'],
      [{ action: 'tab_switch', value: '1' }, 'switch to tab 1'],
      [{ action: 'tab_close', value: '1' }, 'close tab 1'],
      [{ action: 'screenshot' }, 'screenshot'],
    ]
    for (const [step, expected] of cases) {
      expect(describeStep(step), step.action).toBe(expected)
    }
  })

  it('describes each assertion kind', () => {
    const kinds: [ScriptStep['assert'], string][] = [
      [{ kind: 'text', expected: 'Hi' }, 'text contains "Hi"'],
      [{ kind: 'visible', expected: '' }, 'is visible'],
      [{ kind: 'hidden', expected: '' }, 'is hidden'],
      [{ kind: 'value', expected: 'v' }, 'value equals "v"'],
      [{ kind: 'url', expected: '/x' }, 'URL contains "/x"'],
      [{ kind: 'title', expected: 'T' }, 'title contains "T"'],
      [{ kind: 'attr', attr: 'href', expected: '/x' }, 'attribute href contains "/x"'],
      [{ kind: 'count', expected: '3' }, 'count is 3'],
      [{ kind: 'enabled', expected: '' }, 'is enabled'],
      [{ kind: 'checked', expected: '' }, 'is checked'],
    ]
    for (const [assert, fragment] of kinds) {
      expect(describeStep({ action: 'assert', target: submit, assert }), assert?.kind).toContain(
        fragment,
      )
    }
  })

  it('marks a negated assertion', () => {
    expect(
      describeStep({
        action: 'assert',
        target: submit,
        assert: { kind: 'visible', expected: '', negate: true },
      }),
    ).toContain('not visible')
  })

  it('masks a secret in the description', () => {
    const description = describeStep({ action: 'fill', target: email, secretRef: 'LOGIN_PW' })
    expect(description).toContain('LOGIN_PW')
    expect(description).not.toContain('hunter2')
  })
})

describe('parseScriptJson', () => {
  it('round-trips a script through JSON', () => {
    const original = script([
      { action: 'fill', target: email, value: 'a@b.c' },
      { action: 'click', target: submit },
      { action: 'assert', assert: { kind: 'url', expected: '/done' } },
    ])
    const parsed = parseScriptJson(toScriptJson(original), newId)
    expect(parsed.name).toBe(original.name)
    expect(parsed.startUrl).toBe(original.startUrl)
    expect(parsed.steps).toEqual(original.steps)
  })

  it('preserves every optional step field', () => {
    const original = script([
      {
        action: 'extract',
        target: email,
        extract: { kind: 'attr', attr: 'href' },
        saveAs: 'link',
        timeoutMs: 5000,
        optional: true,
        note: 'grab the link',
      },
      { action: 'fill', target: email, secretRef: 'PW' },
      { action: 'scroll', scroll: { mode: 'by', y: 300 } },
    ])
    const parsed = parseScriptJson(toScriptJson(original), newId)
    expect(parsed.steps).toEqual(original.steps)
  })

  it('generates an id when the JSON has none', () => {
    const text = JSON.stringify({ name: 'x', steps: [{ action: 'go_back' }] })
    expect(parseScriptJson(text, () => 'generated').id).toBe('generated')
  })

  it('rejects invalid JSON with the parser message', () => {
    expect(() => parseScriptJson('{not json', newId)).toThrow(/not valid JSON/i)
  })

  it('rejects a script without a steps array', () => {
    expect(() => parseScriptJson('{"name":"x"}', newId)).toThrow(/steps/)
    expect(() => parseScriptJson('[]', newId)).toThrow(/steps/)
    expect(() => parseScriptJson('"text"', newId)).toThrow(/object/)
  })

  it('rejects a step without an action', () => {
    expect(() => parseScriptJson('{"steps":[{"target":{}}]}', newId)).toThrow(/no action/)
  })

  it('rejects an unknown selector kind rather than failing at run time', () => {
    const text = JSON.stringify({
      steps: [{ action: 'click', target: { primary: { how: 'magic', value: 'x' } } }],
    })
    expect(() => parseScriptJson(text, newId)).toThrow(/unknown selector kind/)
  })

  it('rejects a selector without a value', () => {
    const text = JSON.stringify({
      steps: [{ action: 'click', target: { primary: { how: 'css' } } }],
    })
    expect(() => parseScriptJson(text, newId)).toThrow(/without a value/)
  })

  it('rejects a script that parses but could not run', () => {
    const text = JSON.stringify({ name: 'x', steps: [{ action: 'click' }] })
    expect(() => parseScriptJson(text, newId)).toThrow(/not runnable/)
  })

  it('defaults missing fallbacks to an empty list', () => {
    const text = JSON.stringify({
      steps: [{ action: 'click', target: { primary: { how: 'css', value: '#a' } } }],
    })
    expect(parseScriptJson(text, newId).steps[0]?.target?.fallbacks).toEqual([])
  })

  it('stamps the current version on an imported script', () => {
    const text = JSON.stringify({ version: 99, steps: [{ action: 'go_back' }] })
    expect(parseScriptJson(text, newId).version).toBe(SCRIPT_VERSION)
  })
})

describe('specToPlaywright', () => {
  it('uses semantic locators where Playwright has them', () => {
    expect(specToPlaywright({ how: 'testid', value: 'submit' })).toBe(
      "page.getByTestId('submit')",
    )
    expect(specToPlaywright({ how: 'role', value: 'Sign in', role: 'button' })).toBe(
      "page.getByRole('button', { name: 'Sign in', exact: true })",
    )
    expect(specToPlaywright({ how: 'text', value: 'Save' })).toBe(
      "page.getByText('Save', { exact: true })",
    )
  })

  it('falls back to an attribute selector for a non-default test-id attribute', () => {
    expect(specToPlaywright({ how: 'testid', value: 'data-cy=submit' })).toBe(
      `page.locator('[data-cy="submit"]')`,
    )
  })

  it('handles id, name, css, and xpath', () => {
    expect(specToPlaywright({ how: 'id', value: 'email' })).toBe(`page.locator('[id="email"]')`)
    expect(specToPlaywright({ how: 'name', value: 'pw' })).toBe(`page.locator('[name="pw"]')`)
    expect(specToPlaywright({ how: 'css', value: 'form > button' })).toBe(
      "page.locator('form > button')",
    )
    expect(specToPlaywright({ how: 'xpath', value: '//button' })).toBe(
      "page.locator('xpath=//button')",
    )
  })

  it('escapes quotes and backslashes in a locator string', () => {
    expect(specToPlaywright({ how: 'text', value: "it's" })).toContain("\\'")
    expect(specToPlaywright({ how: 'css', value: 'a\\b' })).toContain('\\\\')
  })

  it('omits the name option for a role with no accessible name', () => {
    expect(specToPlaywright({ how: 'role', value: '', role: 'textbox' })).toBe(
      "page.getByRole('textbox')",
    )
  })
})

describe('exportPlaywright', () => {
  it('produces a runnable-looking test with the start URL and each action', () => {
    const code = exportPlaywright(
      script([
        { action: 'fill', target: email, value: 'a@b.c' },
        { action: 'click', target: submit },
        { action: 'assert', target: submit, assert: { kind: 'visible', expected: '' } },
      ]),
    )
    expect(code).toContain("import { expect, test } from '@playwright/test'")
    expect(code).toContain("test('Login smoke', async ({ page }) => {")
    expect(code).toContain("await page.goto('https://app.test/login')")
    expect(code).toContain(`await page.locator('[id="email"]').fill('a@b.c')`)
    expect(code).toContain("await page.getByTestId('submit').click()")
    expect(code).toContain("await expect(page.getByTestId('submit')).toBeVisible()")
    expect(code.trimEnd().endsWith('})')).toBe(true)
  })

  it('emits a secret as an environment lookup, never a literal', () => {
    const code = exportPlaywright(
      script([{ action: 'fill', target: email, secretRef: 'login-pw' }]),
    )
    expect(code).toContain('process.env.LOGIN_PW')
    expect(code).not.toContain('hunter2')
  })

  it('translates each assertion kind', () => {
    const expectations: [ScriptStep['assert'], string][] = [
      [{ kind: 'text', expected: 'Hi' }, 'toContainText'],
      [{ kind: 'visible', expected: '' }, 'toBeVisible'],
      [{ kind: 'hidden', expected: '' }, 'toBeHidden'],
      [{ kind: 'value', expected: 'v' }, 'toHaveValue'],
      [{ kind: 'url', expected: '/x' }, 'toHaveURL'],
      [{ kind: 'title', expected: 'T' }, 'toHaveTitle'],
      [{ kind: 'attr', attr: 'href', expected: '/x' }, 'toHaveAttribute'],
      [{ kind: 'count', expected: '3' }, 'toHaveCount(3)'],
      [{ kind: 'enabled', expected: '' }, 'toBeEnabled'],
      [{ kind: 'checked', expected: '' }, 'toBeChecked'],
    ]
    for (const [assert, fragment] of expectations) {
      const code = exportPlaywright(script([{ action: 'assert', target: submit, assert }]))
      expect(code, assert?.kind).toContain(fragment)
    }
  })

  it('emits .not for a negated assertion', () => {
    const code = exportPlaywright(
      script([
        { action: 'assert', target: submit, assert: { kind: 'visible', expected: '', negate: true } },
      ]),
    )
    expect(code).toContain('.not.toBeVisible()')
  })

  it('escapes a regex-special expectation in a URL assertion', () => {
    const code = exportPlaywright(
      script([{ action: 'assert', assert: { kind: 'url', expected: '/a.b?c=1' } }]),
    )
    expect(code).toContain('\\\\.')
  })

  it('adds .nth for an indexed target', () => {
    const code = exportPlaywright(
      script([
        {
          action: 'click',
          target: { primary: { how: 'text', value: 'Delete', nth: 2 }, fallbacks: [] },
        },
      ]),
    )
    expect(code).toContain('.nth(2)')
  })

  it('keeps a step note as a comment', () => {
    const code = exportPlaywright(
      script([{ action: 'click', target: submit, note: 'dismiss the banner' }]),
    )
    expect(code).toContain('// dismiss the banner')
  })

  it('comments actions that have no Playwright equivalent instead of dropping them', () => {
    const code = exportPlaywright(
      script([
        { action: 'snapshot' },
        { action: 'read_page' },
        { action: 'tab_switch', value: '0' },
      ]),
    )
    expect(code).toContain('no Playwright equivalent')
    expect(code.match(/no Playwright equivalent/g)).toHaveLength(3)
  })

  it('translates checkbox, key, scroll, and tab actions', () => {
    const code = exportPlaywright(
      script([
        { action: 'set_checkbox', target: submit, value: true },
        { action: 'set_checkbox', target: submit, value: false },
        { action: 'press_key', value: 'Enter' },
        { action: 'press_key', target: email, value: 'Escape' },
        { action: 'scroll', scroll: { mode: 'by', y: 400 } },
        { action: 'scroll', target: submit },
        { action: 'wait_for', target: submit },
        { action: 'go_back' },
        { action: 'tab_new', value: 'https://a.test' },
        { action: 'screenshot' },
        { action: 'screenshot', target: submit },
      ]),
    )
    expect(code).toContain('.check()')
    expect(code).toContain('.uncheck()')
    expect(code).toContain("page.keyboard.press('Enter')")
    expect(code).toContain(".press('Escape')")
    expect(code).toContain('page.mouse.wheel(0, 400)')
    expect(code).toContain('scrollIntoViewIfNeeded')
    expect(code).toContain("waitFor({ state: 'visible' })")
    expect(code).toContain('page.goBack()')
    expect(code).toContain('context().newPage()')
    expect(code).toContain('page.screenshot')
  })

  it('emits an extraction into a named variable', () => {
    const code = exportPlaywright(
      script([
        { action: 'extract', target: submit, extract: { kind: 'text' }, saveAs: 'order total' },
      ]),
    )
    expect(code).toContain('const order_total = await')
  })

  it('carries a non-default timeout into the generated call', () => {
    const code = exportPlaywright(
      script([{ action: 'click', target: submit, timeoutMs: DEFAULT_STEP_TIMEOUT_MS + 5000 }]),
    )
    expect(code).toContain('timeout: 15000')
  })

  it('omits goto when there is no start URL', () => {
    const code = exportPlaywright(script([{ action: 'go_back' }], { startUrl: '' }))
    expect(code).not.toContain('page.goto')
  })
})

describe('exportScriptMarkdown', () => {
  it('documents the script in reviewable prose', () => {
    const markdown = exportScriptMarkdown(
      script([
        { action: 'fill', target: email, value: 'a@b.c' },
        { action: 'click', target: submit, optional: true },
      ]),
    )
    expect(markdown).toContain('# Login smoke')
    expect(markdown).toContain('- Start URL: https://app.test/login')
    expect(markdown).toContain('1. fill Email with "a@b.c"')
    expect(markdown).toContain('2. click Sign in *(optional)*')
    // The submit target has one fallback, which should be noted.
    expect(markdown).toContain('fallbacks: 1')
  })
})
