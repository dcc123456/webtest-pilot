/**
 * Markdown ⇄ test case conversion.
 *
 * Markdown is the interchange format for cases: a person can write one in any
 * editor, paste it into chat, drop it in the side panel, or POST it to the local
 * bridge from CI. So the parser is written to be *forgiving about form and strict
 * about meaning* — several heading spellings, both English and Chinese, ordered
 * or bulleted lists — because a case rejected on formatting is a case nobody
 * writes.
 *
 * Round-tripping is covered by tests: `parse(render(case)) ≈ case`. Without that
 * guarantee, exporting a case to share it would quietly lose information.
 *
 * @module lib/markdown
 */

import type { CaseSource, TestCase } from './types'

/** A parsed case before ids and timestamps are assigned. */
export interface ParsedCase {
  name: string
  description?: string
  tags: string[]
  startUrl?: string
  steps: string[]
  expectations: string[]
}

/** A problem that made a document unusable, phrased for the author. */
export interface MarkdownProblem {
  line: number
  message: string
}

export interface ParseResult {
  cases: ParsedCase[]
  problems: MarkdownProblem[]
}

/**
 * Section heading aliases.
 *
 * Both languages are accepted because a bilingual team writes both, and there is
 * no upside to making one of them wrong.
 */
const STEP_HEADINGS = [
  'steps',
  'step',
  'actions',
  'action',
  'procedure',
  '步骤',
  '操作',
  '操作步骤',
  '测试步骤',
]
const EXPECT_HEADINGS = [
  'expect',
  'expected',
  'expectations',
  'expected result',
  'expected results',
  'assertions',
  'assert',
  'verify',
  '预期',
  '预期结果',
  '断言',
  '验证',
  '校验',
]
const DESCRIPTION_HEADINGS = ['description', 'about', 'summary', 'context', '描述', '说明', '背景']

/** Metadata keys recognised in a `- key: value` line. */
const URL_KEYS = ['url', 'starturl', 'start url', 'start_url', '起始url', '地址', '链接', '入口']
const TAG_KEYS = ['tags', 'tag', 'labels', '标签', '分类']
const NAME_KEYS = ['name', 'case', 'title', '名称', '标题', '用例']
const DESCRIPTION_KEYS = ['description', 'desc', '描述', '说明']

function normalizeHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[:：]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchesHeading(text: string, aliases: string[]): boolean {
  const normalized = normalizeHeading(text)
  return aliases.some((alias) => normalized === alias || normalized.startsWith(`${alias} `))
}

/** Strips a list marker (`1.`, `-`, `*`, `+`, `1)`) from a line. */
function stripListMarker(line: string): string | null {
  const match = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
  return match ? (match[1] ?? '').trim() : null
}

/** Splits a `key: value` pair, tolerating the full-width colon. */
function splitKeyValue(text: string): { key: string; value: string } | null {
  const match = /^([^:：]{1,40})[:：]\s*(.*)$/.exec(text)
  if (!match) return null
  return {
    key: normalizeHeading(match[1] ?? ''),
    value: (match[2] ?? '').trim(),
  }
}

/** Removes surrounding markdown emphasis, so `**url**: x` still parses. */
function unemphasize(text: string): string {
  return text.replace(/^\*\*(.+?)\*\*$/, '$1').replace(/^__(.+?)__$/, '$1').trim()
}

function parseTags(value: string): string[] {
  return value
    .split(/[,，;；\s]+/)
    .map((tag) => tag.replace(/^#/, '').trim())
    .filter((tag) => tag.length > 0)
}

/**
 * Removes fenced code blocks from a string.
 *
 * Used before scanning prose for a URL: a URL inside a fenced block is a payload
 * the test *sends*, not the page it starts on, and treating it as the start URL
 * would send the run somewhere the author never mentioned.
 */
function stripFences(text: string): string {
  return text.replace(/(?:```|~~~)[\s\S]*?(?:```|~~~|$)/g, ' ')
}

/**
 * Extracts a bare URL from prose.
 *
 * People write "打开 https://app.test/login 页面" rather than a tidy key-value
 * line, and losing the URL there would mean the run has nowhere to start.
 */
function findUrl(text: string): string | undefined {
  const match = /https?:\/\/[^\s<>"'）)，,；;]+/i.exec(text)
  return match ? match[0] : undefined
}

/**
 * Parses one or more cases from a Markdown document.
 *
 * A document with no `#` heading is still parsed: the whole thing becomes a
 * single case whose steps are its list items. That is what a pasted chat message
 * looks like, and refusing it would push the work back onto the user for no gain.
 */
export function parseCasesMarkdown(text: string): ParseResult {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const problems: MarkdownProblem[] = []
  const cases: ParsedCase[] = []

  type Section = 'none' | 'steps' | 'expect' | 'description'

  let current: ParsedCase | null = null
  let section: Section = 'none'
  let descriptionLines: string[] = []
  let inFence = false

  const flush = (): void => {
    if (!current) return
    const description = descriptionLines.join('\n').trim()
    if (description) current.description = description
    if (!current.startUrl) {
      // Last resort: any URL mentioned in the case's own prose. The name is
      // included because a chat-pasted case often has no heading and its first
      // line — which becomes the name — is where the URL was written. Fenced
      // blocks are stripped first: a URL in a payload is data the test sends,
      // not the page it starts on.
      const haystack = stripFences(
        [current.name, current.description ?? '', ...current.steps].join('\n'),
      )
      const found = findUrl(haystack)
      if (found) current.startUrl = found
    }
    cases.push(current)
    current = null
    descriptionLines = []
    section = 'none'
  }

  const ensureCase = (): ParsedCase => {
    if (!current) {
      current = { name: '', tags: [], steps: [], expectations: [] }
    }
    return current
  }

  lines.forEach((rawLine) => {
    const line = rawLine.replace(/\s+$/, '')

    // A fenced block is content, never structure: a step containing a code
    // sample must not be reinterpreted as headings and lists. The fence markers
    // are kept in the step text so a later scan can still tell code from prose.
    const isFenceMarker = /^\s*(?:```|~~~)/.test(line)
    if (isFenceMarker) inFence = !inFence
    if (isFenceMarker || inFence) {
      if (current && section === 'description') descriptionLines.push(line)
      else if (current && section !== 'expect' && current.steps.length > 0) {
        current.steps[current.steps.length - 1] += `\n${line}`
      } else if (current && section === 'expect' && current.expectations.length > 0) {
        current.expectations[current.expectations.length - 1] += `\n${line}`
      }
      return
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = (heading[1] ?? '').length
      const title = (heading[2] ?? '').trim()

      if (matchesHeading(title, STEP_HEADINGS)) {
        ensureCase()
        section = 'steps'
        return
      }
      if (matchesHeading(title, EXPECT_HEADINGS)) {
        ensureCase()
        section = 'expect'
        return
      }
      if (matchesHeading(title, DESCRIPTION_HEADINGS)) {
        ensureCase()
        section = 'description'
        return
      }

      // Any other heading at level 1 or 2 starts a new case. Deeper headings
      // inside a section are treated as prose, so an author can structure a
      // description without accidentally splitting the case.
      if (level <= 2 || !current) {
        flush()
        const created = ensureCase()
        // `# Case: Login` and `# Login` both name the case.
        const withoutPrefix = /^(?:case|test|用例|测试)\s*[:：]\s*(.+)$/i.exec(title)
        created.name = (withoutPrefix?.[1] ?? title).trim()
        section = 'none'
        return
      }
      if (section === 'description') descriptionLines.push(line)
      return
    }

    const item = stripListMarker(line)
    if (item !== null) {
      const content = unemphasize(item)
      const pair = splitKeyValue(content)

      // Outside a step/expect section, a `key: value` item is metadata.
      if (pair && (section === 'none' || section === 'description')) {
        const target = ensureCase()
        if (URL_KEYS.includes(pair.key)) {
          const url = findUrl(pair.value) ?? pair.value
          if (url) target.startUrl = url
          return
        }
        if (TAG_KEYS.includes(pair.key)) {
          target.tags = [...target.tags, ...parseTags(pair.value)]
          return
        }
        if (NAME_KEYS.includes(pair.key)) {
          if (!target.name) target.name = pair.value
          return
        }
        if (DESCRIPTION_KEYS.includes(pair.key)) {
          descriptionLines.push(pair.value)
          return
        }
      }

      const target = ensureCase()
      if (section === 'expect') {
        if (content) target.expectations.push(content)
        return
      }
      if (section === 'steps') {
        if (content) target.steps.push(content)
        return
      }
      // A list before any section heading is read as steps: that is how a chat
      // message looks, and it is the only sensible interpretation.
      if (content) target.steps.push(content)
      return
    }

    if (line.trim().length === 0) return

    // Plain prose.
    if (section === 'description') {
      descriptionLines.push(line)
      return
    }
    if (!current) {
      // Text before any heading becomes the name if we have none yet.
      const created = ensureCase()
      if (!created.name) {
        created.name = line.trim().slice(0, 120)
        return
      }
    }
    const target = ensureCase()
    const pair = splitKeyValue(unemphasize(line))
    if (pair && URL_KEYS.includes(pair.key)) {
      target.startUrl = findUrl(pair.value) ?? pair.value
      return
    }
    if (pair && TAG_KEYS.includes(pair.key)) {
      target.tags = [...target.tags, ...parseTags(pair.value)]
      return
    }
    if (section === 'steps') target.steps.push(line.trim())
    else if (section === 'expect') target.expectations.push(line.trim())
    else descriptionLines.push(line)
  })

  flush()

  const usable = cases.filter(
    (parsed) => parsed.steps.length > 0 || parsed.expectations.length > 0 || parsed.name.length > 0,
  )
  usable.forEach((parsed, index) => {
    if (!parsed.name) parsed.name = `Case ${index + 1}`
    // Dedupe tags while preserving the author's order.
    const seen = new Set<string>()
    parsed.tags = parsed.tags.filter((tag) => {
      const key = tag.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (parsed.steps.length === 0 && parsed.expectations.length === 0) {
      problems.push({
        line: 0,
        message: `"${parsed.name}" has no steps and no expectations, so there is nothing to run.`,
      })
    }
  })

  if (usable.length === 0) {
    problems.push({
      line: 0,
      message:
        'No test case found. Write a heading for the case, then a "## Steps" list and a "## Expect" list.',
    })
  }

  return { cases: usable, problems }
}

/** Converts a parsed case into a stored one. */
export function toTestCase(
  parsed: ParsedCase,
  meta: { id: string; source: CaseSource; now?: number },
): TestCase {
  const now = meta.now ?? Date.now()
  const testCase: TestCase = {
    id: meta.id,
    name: parsed.name,
    tags: parsed.tags,
    source: meta.source,
    steps: parsed.steps,
    expectations: parsed.expectations,
    createdAt: now,
    updatedAt: now,
  }
  if (parsed.description) testCase.description = parsed.description
  if (parsed.startUrl) testCase.startUrl = parsed.startUrl
  return testCase
}

/**
 * Renders a case back to Markdown.
 *
 * The exact shape the parser prefers, so export → edit → import is lossless.
 */
export function renderCaseMarkdown(testCase: TestCase): string {
  const lines: string[] = [`# Case: ${testCase.name}`, '']
  if (testCase.startUrl) lines.push(`- url: ${testCase.startUrl}`)
  if (testCase.tags.length > 0) lines.push(`- tags: ${testCase.tags.join(', ')}`)
  if (testCase.startUrl || testCase.tags.length > 0) lines.push('')

  if (testCase.description) {
    lines.push('## Description', '', testCase.description, '')
  }

  lines.push('## Steps', '')
  if (testCase.steps.length === 0) lines.push('- (no steps)')
  testCase.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step}`)
  })
  lines.push('')

  lines.push('## Expect', '')
  if (testCase.expectations.length === 0) lines.push('- (no expectations)')
  for (const expectation of testCase.expectations) lines.push(`- ${expectation}`)
  lines.push('')

  return lines.join('\n')
}

/** Renders several cases into one document. */
export function renderCasesMarkdown(cases: TestCase[]): string {
  return cases.map((testCase) => renderCaseMarkdown(testCase)).join('\n---\n\n')
}

/**
 * Formats a case as the instruction block handed to the model.
 *
 * Deliberately not the same as {@link renderCaseMarkdown}: the model needs the
 * expectations called out as the pass criteria, and an explicit statement that
 * anything else is a failure. Sharing one renderer would force one of the two
 * audiences to read something written for the other.
 */
export function renderCaseForModel(testCase: TestCase): string {
  const lines: string[] = [`Test case: ${testCase.name}`]
  if (testCase.description) lines.push('', testCase.description)
  if (testCase.startUrl) {
    lines.push('', `Start URL: ${testCase.startUrl} — already opened for you.`)
  } else {
    // Without this the model does not know where it is, and tends to guess a URL
    // and call open_url — navigating away from the very page it was asked about.
    lines.push(
      '',
      'No start URL: the browser is already on the page this task is about. Call snapshot to see it, and do NOT call open_url — navigating away would abandon the page the user meant.',
    )
  }

  lines.push('', 'Steps to perform, in order:')
  testCase.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step}`)
  })

  if (testCase.expectations.length > 0) {
    lines.push('', 'The test PASSES only if all of these hold at the end:')
    for (const expectation of testCase.expectations) lines.push(`- ${expectation}`)
    lines.push(
      '',
      'Verify each expectation with an assert tool call. Do not declare a pass based on what the page text looks like.',
    )
  } else {
    lines.push(
      '',
      'No explicit expectations were given: the test passes if every step can be completed without error.',
    )
  }
  return lines.join('\n')
}
