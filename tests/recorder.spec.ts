import { describe, expect, it } from 'vitest'

import { Recorder, suggestScriptName } from '../src/background/recorder'
import { SCRIPT_VERSION } from '../src/lib/types'

const submit = {
  primary: { how: 'testid' as const, value: 'submit' },
  fallbacks: [],
  label: 'Sign in',
}
const email = { primary: { how: 'id' as const, value: 'email' }, fallbacks: [], label: 'Email' }
const password = { primary: { how: 'id' as const, value: 'pw' }, fallbacks: [], label: 'Password' }

describe('Recorder: what gets recorded', () => {
  it('records successful effectful actions in order', () => {
    const recorder = new Recorder()
    recorder.add({ action: 'fill', target: email, value: 'a@b.c', ok: true })
    recorder.add({ action: 'click', target: submit, ok: true })
    recorder.add({ action: 'assert', assert: { kind: 'url', expected: '/home' }, ok: true })

    const steps = recorder.steps()
    expect(steps.map((step) => step.action)).toEqual(['fill', 'click', 'assert'])
    expect(steps[0]?.value).toBe('a@b.c')
  })

  it('drops failed attempts, so a script only contains what worked', () => {
    const recorder = new Recorder()
    recorder.add({ action: 'click', target: submit, ok: false })
    recorder.add({ action: 'click', target: submit, ok: true })
    expect(recorder.length).toBe(1)
  })

  it('drops the model orienting itself', () => {
    const recorder = new Recorder()
    recorder.add({ action: 'snapshot', ok: true })
    recorder.add({ action: 'read_page', ok: true })
    recorder.add({ action: 'click', target: submit, ok: true })
    expect(recorder.steps().map((step) => step.action)).toEqual(['click'])
  })

  it('drops a diagnostic screenshot but keeps a deliberate one', () => {
    const recorder = new Recorder()
    recorder.add({ action: 'screenshot', ok: true })
    expect(recorder.length).toBe(0)
    recorder.add({ action: 'screenshot', ok: true, keep: true })
    expect(recorder.length).toBe(1)
  })

  it('records browser-level actions', () => {
    const recorder = new Recorder()
    recorder.add({ action: 'open_url', value: 'https://a.test', ok: true })
    recorder.add({ action: 'tab_new', value: 'https://b.test', ok: true })
    recorder.add({ action: 'tab_switch', value: '0', ok: true })
    recorder.add({ action: 'tab_close', value: '1', ok: true })
    recorder.add({ action: 'go_back', ok: true })
    expect(recorder.length).toBe(5)
  })
})

describe('Recorder: secrets', () => {
  it('records a secret reference, never the value', () => {
    const recorder = new Recorder()
    recorder.add({ action: 'fill', target: password, secretRef: 'LOGIN_PW', value: 'hunter2', ok: true })

    const step = recorder.steps()[0]
    expect(step?.secretRef).toBe('LOGIN_PW')
    // The literal must not survive: an exported script tends to reach a repo.
    expect(step).not.toHaveProperty('value')
    expect(JSON.stringify(recorder.steps())).not.toContain('hunter2')
  })
})

describe('Recorder: collapsing', () => {
  it('collapses consecutive fills of the same field to the final value', () => {
    const recorder = new Recorder()
    recorder.add({ action: 'fill', target: email, value: '', ok: true })
    recorder.add({ action: 'fill', target: email, value: 'a@b.c', ok: true })

    const steps = recorder.steps()
    expect(steps).toHaveLength(1)
    expect(steps[0]?.value).toBe('a@b.c')
  })

  it('does not collapse fills of different fields', () => {
    const recorder = new Recorder()
    recorder.add({ action: 'fill', target: email, value: 'a@b.c', ok: true })
    recorder.add({ action: 'fill', target: password, secretRef: 'PW', ok: true })
    expect(recorder.steps()).toHaveLength(2)
  })

  it('does not collapse fills separated by another action', () => {
    const recorder = new Recorder()
    recorder.add({ action: 'fill', target: email, value: 'first', ok: true })
    recorder.add({ action: 'click', target: submit, ok: true })
    recorder.add({ action: 'fill', target: email, value: 'second', ok: true })
    expect(recorder.steps()).toHaveLength(3)
  })

  it('treats indexed targets as distinct fields', () => {
    const first = { primary: { how: 'css' as const, value: 'input.row', nth: 0 }, fallbacks: [] }
    const second = { primary: { how: 'css' as const, value: 'input.row', nth: 1 }, fallbacks: [] }
    const recorder = new Recorder()
    recorder.add({ action: 'fill', target: first, value: 'a', ok: true })
    recorder.add({ action: 'fill', target: second, value: 'b', ok: true })
    expect(recorder.steps()).toHaveLength(2)
  })
})

describe('Recorder: toScript', () => {
  it('produces a complete script with metadata', () => {
    const recorder = new Recorder()
    recorder.add({ action: 'click', target: submit, ok: true })

    const script = recorder.toScript({
      id: 'script-1',
      name: 'Login smoke',
      startUrl: 'https://app.test/login',
      caseId: 'case-1',
      runId: 'run-1',
      now: 1234,
    })

    expect(script).toMatchObject({
      id: 'script-1',
      name: 'Login smoke',
      startUrl: 'https://app.test/login',
      caseId: 'case-1',
      recordedFromRunId: 'run-1',
      version: SCRIPT_VERSION,
      createdAt: 1234,
      updatedAt: 1234,
    })
    expect(script.steps).toHaveLength(1)
  })

  it('omits optional metadata rather than storing empty strings', () => {
    const recorder = new Recorder()
    recorder.add({ action: 'click', target: submit, ok: true })
    const script = recorder.toScript({ id: 'a', name: 'n', startUrl: '' })
    expect(script).not.toHaveProperty('caseId')
    expect(script).not.toHaveProperty('recordedFromRunId')
  })

  it('refuses to save a script that would test nothing', () => {
    const recorder = new Recorder()
    recorder.add({ action: 'snapshot', ok: true })
    recorder.add({ action: 'click', target: submit, ok: false })
    expect(() => recorder.toScript({ id: 'a', name: 'n', startUrl: '' })).toThrow(
      /no recordable action/,
    )
  })

  it('carries per-step extras through to the script', () => {
    const recorder = new Recorder()
    recorder.add({
      action: 'extract',
      target: submit,
      extract: { kind: 'attr', attr: 'href' },
      saveAs: 'link',
      note: 'capture the link',
      ok: true,
    })
    recorder.add({ action: 'scroll', scroll: { mode: 'bottom' }, ok: true })

    const [extract, scroll] = recorder.toScript({ id: 'a', name: 'n', startUrl: '' }).steps
    expect(extract).toMatchObject({
      extract: { kind: 'attr', attr: 'href' },
      saveAs: 'link',
      note: 'capture the link',
    })
    expect(scroll?.scroll).toEqual({ mode: 'bottom' })
  })
})

describe('suggestScriptName', () => {
  it('reuses the case name so recordings of one case stay grouped', () => {
    expect(suggestScriptName('  Login smoke  ')).toBe('Login smoke')
  })

  it('falls back to a generic name', () => {
    expect(suggestScriptName('   ')).toBe('Recorded script')
  })
})
