/**
 * @vitest-environment jsdom
 *
 * Unit tests for the JUnit XML generator.
 *
 * The escaping cases carry the weight here. An unescaped `&` produces a document
 * that no CI parser will read, and the symptom — "could not parse JUnit report" —
 * appears only after a full test run, pointing at the reporter rather than at the
 * case name that caused it. So the escaping is asserted directly, and every
 * document produced is round-tripped through a real XML parser to prove it is
 * well-formed rather than merely plausible. That round trip needs `DOMParser`,
 * which is why this suite opts into jsdom while the bridge suite stays on node.
 *
 * @module tests/junit.spec
 */

import { describe, expect, it } from 'vitest'

import { escapeXml, outcomeElement, runSeconds, stripInvalidXmlChars, toJUnitXml } from '../bridge/junit'
import type { RunStatus, StepRecord, TestRun } from '../src/lib/types'

const START = 1_700_000_000_000

function makeRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: 'run-1',
    caseName: 'Login works',
    mode: 'script',
    trigger: 'bridge',
    status: 'passed',
    startedAt: START,
    finishedAt: START + 1_500,
    heartbeatAt: START + 1_500,
    steps: [],
    ...overrides,
  }
}

function makeStep(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    index: 0,
    action: 'click',
    description: 'click "Sign in"',
    ok: true,
    startedAt: START,
    durationMs: 200,
    ...overrides,
  }
}

/**
 * Parses the document and fails the test when it is not well-formed.
 *
 * `DOMParser` reports XML errors as a `<parsererror>` element rather than by
 * throwing, which is easy to miss; checking for it explicitly is what makes this
 * a real assertion.
 */
function parseXml(xml: string): Document {
  const document = new DOMParser().parseFromString(xml, 'text/xml')
  const failure = document.querySelector('parsererror')
  if (failure) throw new Error(`the generated XML is not well-formed: ${failure.textContent ?? ''}`)
  return document
}

describe('escapeXml', () => {
  it('escapes all five predefined entities', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;')
  })

  it('escapes the ampersand first, so nothing is double-escaped', () => {
    expect(escapeXml('a & b < c')).toBe('a &amp; b &lt; c')
    expect(escapeXml('&lt;')).toBe('&amp;lt;')
  })

  it('leaves ordinary text alone, including non-ASCII', () => {
    expect(escapeXml('登录成功 — ok')).toBe('登录成功 — ok')
  })

  it('handles an empty string', () => {
    expect(escapeXml('')).toBe('')
  })
})

describe('stripInvalidXmlChars', () => {
  it('drops a NUL, which XML 1.0 cannot represent even as a reference', () => {
    expect(stripInvalidXmlChars('before\u0000after')).toBe('beforeafter')
  })

  it('drops other C0 control characters', () => {
    expect(stripInvalidXmlChars('a\u0001b\u0008c\u001Fd')).toBe('abcd')
  })

  it('keeps tab, newline, and carriage return, which are legal', () => {
    expect(stripInvalidXmlChars('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })

  it('drops a lone surrogate that would make the document unparseable', () => {
    expect(stripInvalidXmlChars('a\uD800b')).toBe('ab')
  })
})

describe('toJUnitXml escaping', () => {
  it('produces well-formed XML for a case name containing an ampersand', () => {
    const xml = toJUnitXml([makeRun({ caseName: 'A & B' })])
    expect(xml).toContain('name="A &amp; B"')
    const document = parseXml(xml)
    expect(document.querySelector('testcase')?.getAttribute('name')).toBe('A & B')
  })

  it('produces well-formed XML for a name containing every dangerous character', () => {
    const caseName = `<script>alert("x") & 'y'</script>`
    const xml = toJUnitXml([makeRun({ caseName })])
    const document = parseXml(xml)
    // The parser giving the original string back is the real proof of correctness.
    expect(document.querySelector('testcase')?.getAttribute('name')).toBe(caseName)
  })

  it('escapes a failure message rather than emitting raw markup', () => {
    const xml = toJUnitXml([
      makeRun({ status: 'failed', failure: { stepIndex: 1, message: 'expected <b>Hi</b> & got "Bye"' } }),
    ])
    expect(xml).not.toContain('<b>Hi</b>')
    const document = parseXml(xml)
    expect(document.querySelector('failure')?.getAttribute('message')).toBe('expected <b>Hi</b> & got "Bye"')
  })

  it('escapes step descriptions inside the failure body', () => {
    const xml = toJUnitXml([
      makeRun({
        status: 'failed',
        steps: [makeStep({ ok: false, description: `click "Save & Close"`, error: 'not found <input>' })],
      }),
    ])
    const document = parseXml(xml)
    const body = document.querySelector('failure')?.textContent ?? ''
    expect(body).toContain('click "Save & Close"')
    expect(body).toContain('not found <input>')
  })

  it('survives a control character in a step error, which is otherwise unparseable', () => {
    const xml = toJUnitXml([
      makeRun({
        status: 'error',
        steps: [makeStep({ ok: false, error: 'timeout\u0000after\u001B[31m 10s' })],
      }),
    ])
    // Would throw if the NUL had been emitted; the escape helper cannot save it.
    const document = parseXml(xml)
    expect(document.querySelector('error')?.textContent).toContain('timeoutafter')
  })

  it('escapes the suite name too', () => {
    const xml = toJUnitXml([makeRun()], { suiteName: 'CI <staging> & prod' })
    const document = parseXml(xml)
    expect(document.querySelector('testsuite')?.getAttribute('name')).toBe('CI <staging> & prod')
  })

  it('escapes the classname', () => {
    const xml = toJUnitXml([makeRun()], { className: 'team "A" & co' })
    const document = parseXml(xml)
    expect(document.querySelector('testcase')?.getAttribute('classname')).toBe('team "A" & co')
  })
})

describe('toJUnitXml status mapping', () => {
  it('emits no outcome child for a passed run', () => {
    const document = parseXml(toJUnitXml([makeRun({ status: 'passed' })]))
    expect(document.querySelector('failure')).toBeNull()
    expect(document.querySelector('error')).toBeNull()
    expect(document.querySelector('skipped')).toBeNull()
  })

  it('emits <failure> for a failed run, because the application is broken', () => {
    const document = parseXml(toJUnitXml([makeRun({ status: 'failed' })]))
    expect(document.querySelector('failure')).not.toBeNull()
    expect(document.querySelector('error')).toBeNull()
  })

  it('emits <error> for an error run, because the harness could not tell', () => {
    const document = parseXml(toJUnitXml([makeRun({ status: 'error' })]))
    expect(document.querySelector('error')).not.toBeNull()
    expect(document.querySelector('failure')).toBeNull()
  })

  it('emits <error> for an interrupted run', () => {
    const document = parseXml(toJUnitXml([makeRun({ status: 'interrupted' })]))
    expect(document.querySelector('error')?.getAttribute('type')).toBe('interrupted')
  })

  it('emits <skipped> for a cancelled run', () => {
    const document = parseXml(toJUnitXml([makeRun({ status: 'cancelled' })]))
    expect(document.querySelector('skipped')).not.toBeNull()
  })

  it('reports a non-terminal run as an error rather than claiming it passed', () => {
    const document = parseXml(toJUnitXml([makeRun({ status: 'running', finishedAt: undefined })]))
    expect(document.querySelector('error')).not.toBeNull()
    expect(document.querySelector('error')?.textContent).toMatch(/had not finished/)
  })

  it('maps every status through outcomeElement consistently', () => {
    const expected: Record<RunStatus, 'failure' | 'error' | 'skipped' | null> = {
      queued: 'error',
      running: 'error',
      passed: null,
      failed: 'failure',
      error: 'error',
      cancelled: 'skipped',
      interrupted: 'error',
    }
    for (const [status, element] of Object.entries(expected)) {
      expect(outcomeElement(status as RunStatus)).toBe(element)
    }
  })
})

describe('toJUnitXml document shape', () => {
  it('counts tests, failures, errors, and skips in the suite attributes', () => {
    const xml = toJUnitXml([
      makeRun({ id: 'a', status: 'passed' }),
      makeRun({ id: 'b', status: 'failed' }),
      makeRun({ id: 'c', status: 'error' }),
      makeRun({ id: 'd', status: 'cancelled' }),
      makeRun({ id: 'e', status: 'interrupted' }),
    ])
    const suite = parseXml(xml).querySelector('testsuite')
    expect(suite?.getAttribute('tests')).toBe('5')
    expect(suite?.getAttribute('failures')).toBe('1')
    expect(suite?.getAttribute('errors')).toBe('2')
    expect(suite?.getAttribute('skipped')).toBe('1')
  })

  it('reports time in seconds with millisecond precision', () => {
    const xml = toJUnitXml([makeRun({ startedAt: START, finishedAt: START + 4_250 })])
    expect(parseXml(xml).querySelector('testcase')?.getAttribute('time')).toBe('4.250')
  })

  it('sums the case times into the suite time', () => {
    const xml = toJUnitXml([
      makeRun({ id: 'a', startedAt: START, finishedAt: START + 1_000 }),
      makeRun({ id: 'b', startedAt: START, finishedAt: START + 2_500 }),
    ])
    expect(parseXml(xml).querySelector('testsuite')?.getAttribute('time')).toBe('3.500')
  })

  it('falls back to the heartbeat when a run never recorded a finish time', () => {
    expect(runSeconds(makeRun({ finishedAt: undefined, heartbeatAt: START + 3_000 }))).toBe(3)
  })

  it('never reports a negative duration from a clock that moved backwards', () => {
    expect(runSeconds(makeRun({ finishedAt: START - 5_000 }))).toBe(0)
  })

  it('emits a valid, empty document when there are no runs', () => {
    const xml = toJUnitXml([])
    const document = parseXml(xml)
    expect(document.querySelector('testsuite')?.getAttribute('tests')).toBe('0')
    expect(document.querySelectorAll('testcase')).toHaveLength(0)
  })

  it('starts with an XML declaration, which some readers require', () => {
    expect(toJUnitXml([makeRun()]).startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
  })

  it('includes the run id on a passing case, so a green report is still traceable', () => {
    const document = parseXml(toJUnitXml([makeRun({ id: 'run-abc', status: 'passed' })]))
    expect(document.querySelector('system-out')?.textContent).toContain('run-abc')
  })

  it('lists every step in the failure body, with ok and FAIL markers', () => {
    const xml = toJUnitXml([
      makeRun({
        status: 'failed',
        steps: [
          makeStep({ index: 0, ok: true, description: 'open the app' }),
          makeStep({ index: 1, ok: false, description: 'click Submit', error: 'element not found' }),
        ],
      }),
    ])
    const body = parseXml(xml).querySelector('failure')?.textContent ?? ''
    expect(body).toContain('[ok] #0 open the app')
    expect(body).toContain('[FAIL] #1 click Submit')
    expect(body).toContain('element not found')
  })

  it('includes assertion expectations in the failure body', () => {
    const xml = toJUnitXml([
      makeRun({
        status: 'failed',
        steps: [
          makeStep({
            ok: false,
            assertion: { passed: false, expected: 'Dashboard', actual: 'Login' },
          }),
        ],
      }),
    ])
    const body = parseXml(xml).querySelector('failure')?.textContent ?? ''
    expect(body).toContain('expected=Dashboard')
    expect(body).toContain('actual=Login')
  })

  it('uses the first failing step as the message when there is no promoted failure', () => {
    const xml = toJUnitXml([
      makeRun({ status: 'failed', steps: [makeStep({ ok: false, description: 'click Submit', error: 'gone' })] }),
    ])
    expect(parseXml(xml).querySelector('failure')?.getAttribute('message')).toBe('click Submit: gone')
  })

  it('uses the earliest run start as the suite timestamp', () => {
    const xml = toJUnitXml([
      makeRun({ id: 'a', startedAt: START + 10_000 }),
      makeRun({ id: 'b', startedAt: START }),
    ])
    expect(parseXml(xml).querySelector('testsuite')?.getAttribute('timestamp')).toBe(new Date(START).toISOString())
  })

  it('honours an explicit timestamp override for a reproducible document', () => {
    const xml = toJUnitXml([makeRun()], { timestamp: START })
    expect(xml).toContain(`timestamp="${new Date(START).toISOString()}"`)
  })
})
