import { describe, expect, it } from 'vitest'

import {
  parseCasesMarkdown,
  renderCaseForModel,
  renderCaseMarkdown,
  renderCasesMarkdown,
  toTestCase,
} from '../src/lib/markdown'
import type { TestCase } from '../src/lib/types'

function only(text: string) {
  const result = parseCasesMarkdown(text)
  const first = result.cases[0]
  if (!first) throw new Error(`no case parsed from:\n${text}`)
  return first
}

describe('parseCasesMarkdown: the canonical shape', () => {
  it('parses name, url, tags, steps, and expectations', () => {
    const parsed = only(`# Case: Login smoke

- url: https://app.test/login
- tags: smoke, auth

## Steps

1. Fill in the email field with qa@example.com
2. Fill in the password
3. Click Sign in

## Expect

- The dashboard heading is visible
- The URL contains /dashboard
`)

    expect(parsed.name).toBe('Login smoke')
    expect(parsed.startUrl).toBe('https://app.test/login')
    expect(parsed.tags).toEqual(['smoke', 'auth'])
    expect(parsed.steps).toEqual([
      'Fill in the email field with qa@example.com',
      'Fill in the password',
      'Click Sign in',
    ])
    expect(parsed.expectations).toEqual([
      'The dashboard heading is visible',
      'The URL contains /dashboard',
    ])
  })

  it('accepts a bare heading as the case name', () => {
    expect(only('# Login smoke\n\n## Steps\n1. Click x\n').name).toBe('Login smoke')
  })

  it('strips a Case/Test/用例 prefix from the heading', () => {
    expect(only('# Test: Checkout\n## Steps\n1. x').name).toBe('Checkout')
    expect(only('# 用例：结算流程\n## 步骤\n1. x').name).toBe('结算流程')
  })

  it('parses a description section', () => {
    const parsed = only(`# Case: Login

## Description

Covers the happy path for an existing user.

## Steps
1. Click Sign in
`)
    expect(parsed.description).toBe('Covers the happy path for an existing user.')
  })
})

describe('parseCasesMarkdown: Chinese documents', () => {
  it('parses Chinese headings and full-width colons', () => {
    const parsed = only(`# 用例：登录冒烟

- 地址：https://app.test/login
- 标签：冒烟，登录

## 步骤

1. 在邮箱输入框填入 qa@example.com
2. 填写密码
3. 点击登录按钮

## 预期结果

- 页面显示"控制台"标题
- 地址栏包含 /dashboard
`)

    expect(parsed.name).toBe('登录冒烟')
    expect(parsed.startUrl).toBe('https://app.test/login')
    expect(parsed.tags).toEqual(['冒烟', '登录'])
    expect(parsed.steps).toHaveLength(3)
    expect(parsed.expectations).toHaveLength(2)
  })

  it('accepts every documented heading alias', () => {
    const stepAliases = ['Steps', 'Step', 'Actions', 'Procedure', '步骤', '操作步骤', '测试步骤']
    for (const alias of stepAliases) {
      expect(only(`# C\n## ${alias}\n1. do it\n`).steps, alias).toEqual(['do it'])
    }
    const expectAliases = ['Expect', 'Expected', 'Expected Result', 'Assertions', 'Verify', '预期', '预期结果', '断言']
    for (const alias of expectAliases) {
      expect(only(`# C\n## Steps\n1. x\n## ${alias}\n- it works\n`).expectations, alias).toEqual([
        'it works',
      ])
    }
  })
})

describe('parseCasesMarkdown: forgiving input', () => {
  it('accepts a bare list with no headings at all, as pasted into chat', () => {
    const parsed = only(`Open https://app.test and log in
- Click the login button
- Fill in the form
`)
    expect(parsed.steps).toEqual(['Click the login button', 'Fill in the form'])
    // The URL mentioned in prose must not be lost.
    expect(parsed.startUrl).toBe('https://app.test')
  })

  it('accepts bulleted steps as readily as numbered ones', () => {
    expect(only('# C\n## Steps\n- one\n* two\n+ three\n1) four\n').steps).toEqual([
      'one',
      'two',
      'three',
      'four',
    ])
  })

  it('finds a URL written inside a step', () => {
    expect(only('# C\n## Steps\n1. Open https://shop.test/cart and check the total\n').startUrl).toBe(
      'https://shop.test/cart',
    )
  })

  it('does not swallow trailing punctuation into a URL', () => {
    expect(only('# C\n## Steps\n1. 打开 https://app.test/login，然后登录\n').startUrl).toBe(
      'https://app.test/login',
    )
    expect(only('# C\n## Steps\n1. Open https://app.test/login, then log in.\n').startUrl).toBe(
      'https://app.test/login',
    )
  })

  it('tolerates markdown emphasis around a metadata key', () => {
    expect(only('# C\n- **url**: https://a.test\n## Steps\n1. x\n').startUrl).toBe('https://a.test')
  })

  it('splits tags on commas, semicolons, and spaces, and strips a leading hash', () => {
    expect(only('# C\n- tags: #smoke, auth; billing regression\n## Steps\n1. x\n').tags).toEqual([
      'smoke',
      'auth',
      'billing',
      'regression',
    ])
  })

  it('deduplicates tags while keeping the author order', () => {
    expect(only('# C\n- tags: smoke, Smoke, auth\n## Steps\n1. x\n').tags).toEqual(['smoke', 'auth'])
  })

  it('reads a name from a metadata line when the heading is a section', () => {
    const parsed = only('- name: Renamed case\n## Steps\n1. x\n')
    expect(parsed.name).toBe('Renamed case')
  })

  it('does not treat a step containing a colon as metadata', () => {
    expect(only('# C\n## Steps\n1. url: should stay a step\n').steps).toEqual([
      'url: should stay a step',
    ])
  })

  it('keeps a fenced code block inside the step it belongs to', () => {
    const parsed = only(`# C

## Steps
1. Paste this payload:
\`\`\`json
{ "url": "https://not-the-start.test" }
\`\`\`
2. Submit
`)
    expect(parsed.steps).toHaveLength(2)
    expect(parsed.steps[0]).toContain('"url"')
    // A URL inside a fenced block is data, not the start URL.
    expect(parsed.startUrl).toBeUndefined()
  })

  it('treats a deep heading inside a description as prose, not a new case', () => {
    const result = parseCasesMarkdown(`# Case A

## Description
Intro text.
### A sub-heading
More text.

## Steps
1. x
`)
    expect(result.cases).toHaveLength(1)
    expect(result.cases[0]?.description).toContain('A sub-heading')
  })

  it('normalises CRLF line endings', () => {
    const parsed = only('# C\r\n## Steps\r\n1. one\r\n2. two\r\n')
    expect(parsed.steps).toEqual(['one', 'two'])
  })
})

describe('parseCasesMarkdown: multiple cases', () => {
  it('splits on level-1 and level-2 headings', () => {
    const result = parseCasesMarkdown(`# Case: First

## Steps
1. a

## Expect
- a happened

# Case: Second

## Steps
1. b
`)
    expect(result.cases.map((parsed) => parsed.name)).toEqual(['First', 'Second'])
    expect(result.cases[0]?.expectations).toEqual(['a happened'])
    expect(result.cases[1]?.steps).toEqual(['b'])
  })

  it('does not leak the first case url into the second', () => {
    const result = parseCasesMarkdown(`# First
- url: https://a.test
## Steps
1. a

# Second
## Steps
1. b
`)
    expect(result.cases[0]?.startUrl).toBe('https://a.test')
    expect(result.cases[1]?.startUrl).toBeUndefined()
  })

  it('names an unnamed case rather than dropping it', () => {
    const result = parseCasesMarkdown('## Steps\n1. a\n')
    expect(result.cases[0]?.name).toBe('Case 1')
  })
})

describe('parseCasesMarkdown: problems', () => {
  it('reports an empty document instead of silently importing nothing', () => {
    const result = parseCasesMarkdown('   \n\n')
    expect(result.cases).toHaveLength(0)
    expect(result.problems[0]?.message).toContain('No test case found')
  })

  it('reports a case with a name but nothing to run', () => {
    const result = parseCasesMarkdown('# Case: Empty\n')
    expect(result.cases).toHaveLength(1)
    expect(result.problems[0]?.message).toContain('nothing to run')
  })

  it('accepts a case with expectations but no steps', () => {
    const result = parseCasesMarkdown('# C\n## Expect\n- the page loads\n')
    expect(result.problems).toHaveLength(0)
    expect(result.cases[0]?.expectations).toEqual(['the page loads'])
  })
})

describe('toTestCase', () => {
  it('fills in ids, source, and timestamps', () => {
    const testCase = toTestCase(only('# C\n- url: https://a.test\n## Steps\n1. x\n'), {
      id: 'case-1',
      source: 'markdown',
      now: 999,
    })
    expect(testCase).toMatchObject({
      id: 'case-1',
      source: 'markdown',
      createdAt: 999,
      updatedAt: 999,
      startUrl: 'https://a.test',
    })
  })

  it('omits absent optional fields rather than storing empty strings', () => {
    const testCase = toTestCase(only('# C\n## Steps\n1. x\n'), { id: 'a', source: 'chat' })
    expect(testCase).not.toHaveProperty('description')
    expect(testCase).not.toHaveProperty('startUrl')
  })
})

describe('renderCaseMarkdown', () => {
  const testCase: TestCase = {
    id: 'case-1',
    name: 'Login smoke',
    description: 'Happy path for an existing user.',
    tags: ['smoke', 'auth'],
    source: 'markdown',
    startUrl: 'https://app.test/login',
    steps: ['Fill the email field', 'Click Sign in'],
    expectations: ['The dashboard is visible'],
    createdAt: 1,
    updatedAt: 1,
  }

  it('renders the canonical shape', () => {
    const markdown = renderCaseMarkdown(testCase)
    expect(markdown).toContain('# Case: Login smoke')
    expect(markdown).toContain('- url: https://app.test/login')
    expect(markdown).toContain('- tags: smoke, auth')
    expect(markdown).toContain('## Steps')
    expect(markdown).toContain('1. Fill the email field')
    expect(markdown).toContain('## Expect')
    expect(markdown).toContain('- The dashboard is visible')
  })

  it('round-trips without losing anything', () => {
    const reparsed = only(renderCaseMarkdown(testCase))
    expect(reparsed.name).toBe(testCase.name)
    expect(reparsed.startUrl).toBe(testCase.startUrl)
    expect(reparsed.tags).toEqual(testCase.tags)
    expect(reparsed.steps).toEqual(testCase.steps)
    expect(reparsed.expectations).toEqual(testCase.expectations)
    expect(reparsed.description).toBe(testCase.description)
  })

  it('round-trips a Chinese case', () => {
    const chinese: TestCase = {
      ...testCase,
      name: '登录冒烟',
      description: '覆盖已注册用户的正常登录流程。',
      tags: ['冒烟', '登录'],
      steps: ['在邮箱框填入 qa@example.com', '点击"登录"按钮'],
      expectations: ['页面出现"控制台"'],
    }
    const reparsed = only(renderCaseMarkdown(chinese))
    expect(reparsed.name).toBe(chinese.name)
    expect(reparsed.steps).toEqual(chinese.steps)
    expect(reparsed.expectations).toEqual(chinese.expectations)
    expect(reparsed.tags).toEqual(chinese.tags)
  })

  it('renders a case with no steps or expectations without producing garbage', () => {
    const markdown = renderCaseMarkdown({ ...testCase, steps: [], expectations: [] })
    expect(markdown).toContain('(no steps)')
    expect(markdown).toContain('(no expectations)')
  })

  it('renders several cases so they parse back as several cases', () => {
    const second: TestCase = { ...testCase, id: 'case-2', name: 'Checkout' }
    const result = parseCasesMarkdown(renderCasesMarkdown([testCase, second]))
    expect(result.cases.map((parsed) => parsed.name)).toEqual(['Login smoke', 'Checkout'])
  })
})

describe('renderCaseForModel', () => {
  const testCase: TestCase = {
    id: 'case-1',
    name: 'Login smoke',
    tags: [],
    source: 'chat',
    startUrl: 'https://app.test/login',
    steps: ['Fill the email field', 'Click Sign in'],
    expectations: ['The dashboard is visible'],
    createdAt: 1,
    updatedAt: 1,
  }

  it('states the pass criteria and demands assertions', () => {
    const prompt = renderCaseForModel(testCase)
    expect(prompt).toContain('Test case: Login smoke')
    expect(prompt).toContain('Start URL: https://app.test/login')
    expect(prompt).toContain('PASSES only if')
    expect(prompt).toContain('The dashboard is visible')
    // Guarding against a model that "reads" a pass off the page text.
    expect(prompt).toContain('assert tool call')
  })

  it('says what passing means when no expectations were given', () => {
    const prompt = renderCaseForModel({ ...testCase, expectations: [] })
    expect(prompt).toContain('without error')
    expect(prompt).not.toContain('PASSES only if')
  })

  it('includes the description when there is one', () => {
    const prompt = renderCaseForModel({ ...testCase, description: 'Some context.' })
    expect(prompt).toContain('Some context.')
  })
})
