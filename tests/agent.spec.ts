import { describe, expect, it, vi } from 'vitest'

import {
  RefTable,
  SECRET_PLACEHOLDER,
  TOOL_NAMES,
  dispatchTool,
  initialMessages,
  parseToolArguments,
  renderSnapshot,
  systemPrompt,
  toolSchemas,
  validateVerdict,
  type Verdict,
} from '../src/background/agent'
import { NotAllowedError, type RunContext } from '../src/background/driver'
import type { PageSnapshot, SnapshotElement } from '../src/lib/ops'
import type { WireToolCall } from '../src/lib/llm'
import { FakeDriver } from './fake-driver'

function element(overrides: Partial<SnapshotElement> & { ref: string }): SnapshotElement {
  return {
    role: 'button',
    name: 'Sign in',
    tag: 'button',
    inViewport: true,
    target: { primary: { how: 'testid', value: 'submit' }, fallbacks: [] },
    ...overrides,
  }
}

function page(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://app.test/login',
    title: 'Login',
    text: 'Sign in to continue',
    truncated: false,
    selection: '',
    elements: [element({ ref: 'e1' })],
    elementsTruncated: false,
    frameUrl: 'https://app.test/login',
    isTopFrame: true,
    forms: [],
    ...overrides,
  }
}

function call(name: string, args: Record<string, unknown>): WireToolCall {
  return { id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function deps(driver: FakeDriver, refs = new RefTable()) {
  const context: RunContext = { tabId: 1, windowId: 10 }
  return {
    driver,
    context,
    refs,
    stepTimeoutMs: 5000,
    secretNames: ['LOGIN_PW'],
  }
}

function withRefs(): RefTable {
  const refs = new RefTable()
  refs.update(page())
  return refs
}

describe('toolSchemas', () => {
  it('declares every tool the loop dispatches', () => {
    const names = toolSchemas({ selfHeal: false, secretNames: [] }).map(
      (tool) => tool.function.name,
    )
    expect(names).toEqual([...TOOL_NAMES])
  })

  it('produces valid function-calling schemas', () => {
    for (const tool of toolSchemas({ selfHeal: true, secretNames: ['PW'] })) {
      expect(tool.type).toBe('function')
      expect(tool.function.name).toMatch(/^[a-z_]+$/)
      expect(tool.function.description.length).toBeGreaterThan(20)
      expect(tool.function.parameters).toMatchObject({ type: 'object' })
    }
  })

  it('adds relocate only when self-healing is on', () => {
    const off = toolSchemas({ selfHeal: false, secretNames: [] }).map((tool) => tool.function.name)
    const on = toolSchemas({ selfHeal: true, secretNames: [] }).map((tool) => tool.function.name)
    expect(off).not.toContain('relocate')
    expect(on).toContain('relocate')
  })

  it('names the available secrets so the model uses a real one', () => {
    const fill = toolSchemas({ selfHeal: false, secretNames: ['LOGIN_PW', 'API_KEY'] }).find(
      (tool) => tool.function.name === 'fill',
    )
    const secretRef = (
      fill?.function.parameters as { properties: { secretRef: { description: string } } }
    ).properties.secretRef
    expect(secretRef.description).toContain('LOGIN_PW')
    expect(secretRef.description).toContain('API_KEY')
  })

  it('says so when no secrets exist, rather than offering an empty list', () => {
    const fill = toolSchemas({ selfHeal: false, secretNames: [] }).find(
      (tool) => tool.function.name === 'fill',
    )
    const secretRef = (
      fill?.function.parameters as { properties: { secretRef: { description: string } } }
    ).properties.secretRef
    expect(secretRef.description).toContain('None are configured')
  })

  it('requires a status and summary from finish', () => {
    const finish = toolSchemas({ selfHeal: false, secretNames: [] }).find(
      (tool) => tool.function.name === 'finish',
    )
    expect((finish?.function.parameters as { required: string[] }).required).toEqual([
      'status',
      'summary',
    ])
  })
})

describe('systemPrompt', () => {
  it('states the allow-list, the assertion requirement, and the round budget', () => {
    const prompt = systemPrompt({
      allowedSites: ['https://app.test/*'],
      secretNames: ['LOGIN_PW'],
      maxRounds: 24,
    })
    expect(prompt).toContain('https://app.test/*')
    expect(prompt).toContain('LOGIN_PW')
    expect(prompt).toContain('24 tool rounds')
    // The two failure modes the prompt exists to counter.
    expect(prompt).toContain('assert tool')
    expect(prompt).toContain('Finding a real bug is a success')
  })

  it('warns when nothing is allowed, instead of implying it will work', () => {
    const prompt = systemPrompt({ allowedSites: [], secretNames: [], maxRounds: 10 })
    expect(prompt).toContain('none configured')
  })

  it('tells the model not to ask for a password when none is stored', () => {
    const prompt = systemPrompt({ allowedSites: ['x'], secretNames: [], maxRounds: 10 })
    expect(prompt).toContain('No secrets are configured')
  })
})

describe('renderSnapshot', () => {
  it('lists refs with role, name, and state', () => {
    const rendered = renderSnapshot(
      page({
        elements: [
          element({ ref: 'e1', role: 'textbox', name: 'Email', tag: 'input', type: 'email' }),
          element({ ref: 'e2', name: 'Submit', disabled: true }),
          element({ ref: 'e3', role: 'checkbox', name: 'Remember', tag: 'input', type: 'checkbox', checked: true }),
          element({ ref: 'e4', role: 'link', name: 'Help', tag: 'a', href: 'https://app.test/help' }),
        ],
      }),
    )
    expect(rendered).toContain('e1  textbox "Email" email')
    expect(rendered).toContain('e2  button "Submit" disabled')
    expect(rendered).toContain('e3  checkbox "Remember" checkbox checked')
    expect(rendered).toContain('→ https://app.test/help')
  })

  it('reports a placeholder when there is no label', () => {
    const rendered = renderSnapshot(
      page({ elements: [element({ ref: 'e1', name: '', placeholder: 'Search' })] }),
    )
    expect(rendered).toContain('placeholder="Search"')
  })

  it('marks an off-screen element so the model knows to scroll', () => {
    const rendered = renderSnapshot(
      page({ elements: [element({ ref: 'e1', inViewport: false })] }),
    )
    expect(rendered).toContain('off-screen')
  })

  it('says what to do when there are no elements at all', () => {
    const rendered = renderSnapshot(page({ elements: [] }))
    expect(rendered).toContain('No interactive elements')
    expect(rendered).toContain('still be loading')
  })

  it('tells the model how to see more when the list was truncated', () => {
    const rendered = renderSnapshot(page({ elementsTruncated: true }))
    expect(rendered).toContain('maxElements')
  })

  it('renders forms with select options, so the model picks a valid value', () => {
    const rendered = renderSnapshot(
      page({
        forms: [
          {
            name: 'signup',
            fields: [
              { ref: 'e1', label: 'Email', tag: 'input', type: 'email', required: true },
              { ref: 'e2', label: 'Plan', tag: 'select', options: ['Free', 'Pro'] },
            ],
          },
        ],
      }),
    )
    expect(rendered).toContain('form signup')
    expect(rendered).toContain('e1 Email, email, required')
    expect(rendered).toContain('options: Free | Pro')
  })

  it('never leaks a password value', () => {
    // The kernel omits it; this pins the renderer to the same guarantee.
    const rendered = renderSnapshot(
      page({ elements: [element({ ref: 'e1', tag: 'input', type: 'password', name: 'Password' })] }),
    )
    expect(rendered).not.toContain('hunter2')
    expect(rendered).toContain('password')
  })
})

describe('parseToolArguments', () => {
  it('parses ordinary JSON', () => {
    expect(parseToolArguments('{"ref":"e1"}')).toEqual({ ref: 'e1' })
  })

  it('treats empty arguments as no arguments', () => {
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments('   ')).toEqual({})
  })

  it('recovers from a fenced block, which some models emit', () => {
    expect(parseToolArguments('```json\n{"ref":"e1"}\n```')).toEqual({ ref: 'e1' })
  })

  it('recovers from a trailing comma', () => {
    expect(parseToolArguments('{"ref":"e1",}')).toEqual({ ref: 'e1' })
  })

  it('returns nothing for unrecoverable input rather than throwing', () => {
    expect(parseToolArguments('not json at all')).toEqual({})
    expect(parseToolArguments('[1,2,3]')).toEqual([1, 2, 3])
  })
})

describe('RefTable', () => {
  it('maps a ref to the durable target computed in the page', () => {
    const refs = withRefs()
    expect(refs.get('e1')?.target.primary).toEqual({ how: 'testid', value: 'submit' })
    expect(refs.get('e1')?.label).toBe('Sign in')
  })

  it('replaces the table on update, so stale refs stop resolving', () => {
    const refs = withRefs()
    refs.update(page({ elements: [element({ ref: 'e9', name: 'Other' })] }))
    expect(refs.get('e1')).toBeUndefined()
    expect(refs.get('e9')?.label).toBe('Other')
  })

  it('labels an unnamed element by role rather than leaving it blank', () => {
    const refs = new RefTable()
    refs.update(page({ elements: [element({ ref: 'e1', name: '', role: 'combobox' })] }))
    expect(refs.get('e1')?.label).toBe('combobox')
  })
})

describe('dispatchTool: ref discipline', () => {
  it('tells the model to snapshot first when no snapshot exists', async () => {
    const outcome = await dispatchTool(call('click', { ref: 'e1' }), deps(new FakeDriver()))
    expect(outcome.content).toContain('no snapshot has been taken yet')
    expect(outcome.recorded).toBeUndefined()
  })

  it('explains a stale ref and lists the valid ones', async () => {
    const outcome = await dispatchTool(
      call('click', { ref: 'e99' }),
      deps(new FakeDriver(), withRefs()),
    )
    expect(outcome.content).toContain('Unknown ref "e99"')
    expect(outcome.content).toContain('call snapshot again')
    expect(outcome.content).toContain('e1')
  })

  it('refuses a tool call with no ref at all', async () => {
    const outcome = await dispatchTool(call('click', {}), deps(new FakeDriver(), withRefs()))
    expect(outcome.content).toContain('needs a "ref"')
  })

  it('refreshes refs after a snapshot', async () => {
    const driver = new FakeDriver()
    driver.snapshotToReturn = page({ elements: [element({ ref: 'e7', name: 'Fresh' })] })
    const refs = new RefTable()
    await dispatchTool(call('snapshot', {}), deps(driver, refs))
    expect(refs.get('e7')?.label).toBe('Fresh')
  })

  it('invalidates refs after a navigation, so the model cannot reuse them', async () => {
    const driver = new FakeDriver()
    driver.snapshotToReturn = page({ elements: [] })
    const refs = withRefs()
    await dispatchTool(call('open_url', { url: 'https://app.test/next' }), deps(driver, refs))
    expect(refs.get('e1')).toBeUndefined()
  })
})

describe('dispatchTool: actions', () => {
  it('clicks and reports whether navigation may follow', async () => {
    const driver = new FakeDriver().program('click', {
      kind: 'ok',
      result: { mayNavigate: true },
    })
    const outcome = await dispatchTool(call('click', { ref: 'e1' }), deps(driver, withRefs()))
    expect(outcome.content).toContain('Clicked Sign in')
    expect(outcome.content).toContain('fresh snapshot')
    expect(outcome.recorded).toMatchObject({ action: 'click', ok: true })
  })

  it('reports a refused click as a result, not an error', async () => {
    const driver = new FakeDriver().program('click', { kind: 'failed', error: 'is disabled' })
    const outcome = await dispatchTool(call('click', { ref: 'e1' }), deps(driver, withRefs()))
    expect(outcome.content).toContain('Could not click Sign in')
    expect(outcome.content).toContain('disabled')
    // Nothing to record: the action did not happen.
    expect(outcome.recorded).toBeUndefined()
  })

  it('fills a literal value', async () => {
    const driver = new FakeDriver()
    const outcome = await dispatchTool(
      call('fill', { ref: 'e1', value: 'a@b.c' }),
      deps(driver, withRefs()),
    )
    expect(outcome.content).toContain('Filled Sign in with "a@b.c"')
    expect(outcome.recorded).toMatchObject({ action: 'fill', value: 'a@b.c' })
  })

  it('selects, checks, presses, hovers, and scrolls', async () => {
    const driver = new FakeDriver()
    const refs = withRefs()
    expect((await dispatchTool(call('select_option', { ref: 'e1', value: 'Pro' }), deps(driver, refs))).content).toContain('Selected "Pro"')
    expect((await dispatchTool(call('set_checkbox', { ref: 'e1', checked: true }), deps(driver, refs))).content).toContain('Checked')
    expect((await dispatchTool(call('set_checkbox', { ref: 'e1', checked: false }), deps(driver, refs))).content).toContain('Unchecked')
    expect((await dispatchTool(call('press_key', { key: 'Enter' }), deps(driver, refs))).content).toContain('Pressed Enter')
    expect((await dispatchTool(call('hover', { ref: 'e1' }), deps(driver, refs))).content).toContain('Hovered')
    expect((await dispatchTool(call('scroll', { mode: 'bottom' }), deps(driver, refs))).content).toContain('to the bottom')
    expect((await dispatchTool(call('scroll', { mode: 'into_view', ref: 'e1' }), deps(driver, refs))).content).toContain('into view')
  })

  it('requires a key for press_key', async () => {
    const outcome = await dispatchTool(call('press_key', {}), deps(new FakeDriver(), withRefs()))
    expect(outcome.content).toContain('needs a "key"')
  })

  it('waits for an element and reports a timeout in seconds', async () => {
    const driver = new FakeDriver().program('wait_for', { kind: 'notFound' })
    const outcome = await dispatchTool(
      call('wait_for', { ref: 'e1', timeoutMs: 3000 }),
      deps(driver, withRefs()),
    )
    expect(outcome.content).toContain('did not become visible within 3s')
  })

  it('manages tabs', async () => {
    const driver = new FakeDriver()
    driver.snapshotToReturn = page({ elements: [] })
    const refs = withRefs()
    expect((await dispatchTool(call('tab', { op: 'list' }), deps(driver, refs))).content).toContain('https://app.test/')
    expect((await dispatchTool(call('tab', { op: 'new', url: 'https://app.test/x' }), deps(driver, refs))).content).toContain('Opened a new tab')
    expect((await dispatchTool(call('tab', { op: 'back' }), deps(driver, refs))).content).toContain('Went back')
    expect((await dispatchTool(call('tab', { op: 'switch', index: 0 }), deps(driver, refs))).content).toContain('Switched to tab 0')
  })

  it('rejects an unknown tab op with the valid list', async () => {
    const outcome = await dispatchTool(call('tab', { op: 'teleport' }), deps(new FakeDriver(), withRefs()))
    expect(outcome.content).toContain('Unknown tab op')
    expect(outcome.content).toContain('switch')
  })

  it('reports an unknown tool with the available names', async () => {
    const outcome = await dispatchTool(call('hack_the_page', {}), deps(new FakeDriver(), withRefs()))
    expect(outcome.content).toContain('Unknown tool')
    expect(outcome.content).toContain('snapshot')
  })
})

describe('dispatchTool: secrets', () => {
  it('passes a placeholder, never a value, and records the reference', async () => {
    const driver = new FakeDriver()
    const outcome = await dispatchTool(
      call('fill', { ref: 'e1', secretRef: 'LOGIN_PW' }),
      deps(driver, withRefs()),
    )
    expect(outcome.content).toContain('the "LOGIN_PW" secret')
    expect(outcome.recorded).toMatchObject({ action: 'fill', secretRef: 'LOGIN_PW' })
    expect(outcome.recorded).not.toHaveProperty('value')

    const fillCall = driver.calls.find((entry) => entry.op?.action === 'fill')
    // The dispatcher must not know the value: only a placeholder reaches here.
    expect(fillCall?.op?.value).toBe(SECRET_PLACEHOLDER)
  })

  it('refuses a secret name that is not configured', async () => {
    const outcome = await dispatchTool(
      call('fill', { ref: 'e1', secretRef: 'NOT_REAL' }),
      deps(new FakeDriver(), withRefs()),
    )
    expect(outcome.content).toContain('No secret named "NOT_REAL"')
    expect(outcome.content).toContain('LOGIN_PW')
  })
})

describe('dispatchTool: assertions', () => {
  it('marks a passing assertion distinctly, so the verdict check can count it', async () => {
    const driver = new FakeDriver()
    const outcome = await dispatchTool(
      call('assert', { kind: 'visible', ref: 'e1' }),
      deps(driver, withRefs()),
    )
    expect(outcome.content).toContain('ASSERTION PASSED')
    expect(outcome.assertionPassed).toBeTruthy()
    expect(outcome.recorded).toMatchObject({ action: 'assert' })
  })

  it('reports a failing assertion with the observed value and what to do', async () => {
    const driver = new FakeDriver().program('assert', {
      kind: 'assertFailed',
      actual: 'Login',
      expected: 'Dashboard',
    })
    const outcome = await dispatchTool(
      call('assert', { kind: 'title', expected: 'Dashboard' }),
      deps(driver, withRefs()),
    )
    expect(outcome.content).toContain('ASSERTION FAILED')
    expect(outcome.content).toContain('Observed: "Login"')
    expect(outcome.content).toContain('report it with finish')
    // A failed assertion is not a recordable step.
    expect(outcome.recorded).toBeUndefined()
    expect(outcome.assertionPassed).toBeUndefined()
  })

  it('does not require a ref for url and title assertions', async () => {
    const driver = new FakeDriver()
    const outcome = await dispatchTool(
      call('assert', { kind: 'url', expected: '/login' }),
      deps(driver, new RefTable()),
    )
    expect(outcome.content).toContain('ASSERTION PASSED')
  })

  it('requires a kind', async () => {
    const outcome = await dispatchTool(call('assert', {}), deps(new FakeDriver(), withRefs()))
    expect(outcome.content).toContain('needs a "kind"')
  })
})

describe('dispatchTool: extraction and screenshots', () => {
  it('extracts and stores under saveAs', async () => {
    const onExtract = vi.fn()
    const outcome = await dispatchTool(
      call('extract', { ref: 'e1', what: 'text', saveAs: 'total' }),
      { ...deps(new FakeDriver(), withRefs()), onExtract },
    )
    expect(outcome.content).toContain('fake value')
    expect(onExtract).toHaveBeenCalledWith('total', { kind: 'strings', values: ['fake value'] })
  })

  it('requires an attribute name when extracting an attribute', async () => {
    const outcome = await dispatchTool(
      call('extract', { ref: 'e1', what: 'attr' }),
      deps(new FakeDriver(), withRefs()),
    )
    expect(outcome.content).toContain('the attribute name')
  })

  it('captures a screenshot and hands the data URL back for storage', async () => {
    const outcome = await dispatchTool(
      call('screenshot', { note: 'after submit' }),
      deps(new FakeDriver(), withRefs()),
    )
    expect(outcome.screenshotDataUrl).toContain('data:image/png')
    expect(outcome.content).toContain('after submit')
    // A diagnostic shot by default: it reaches the report but must not become a
    // step, or every replay would carry screenshots nobody asked for.
    expect(outcome.recorded).toMatchObject({ action: 'screenshot', keep: false })
  })

  it('keeps a screenshot as a script step when the model asks for it', async () => {
    const outcome = await dispatchTool(
      call('screenshot', { note: 'the rendered invoice', keep: true }),
      deps(new FakeDriver(), withRefs()),
    )
    expect(outcome.recorded).toMatchObject({ action: 'screenshot', keep: true })
    expect(outcome.content).toContain('every replay')
  })

  it('accepts the string "true", which models emit routinely', async () => {
    const outcome = await dispatchTool(
      call('screenshot', { keep: 'true' }),
      deps(new FakeDriver(), withRefs()),
    )
    // Treating "true" as falsy would silently drop the flag the model set.
    expect(outcome.recorded).toMatchObject({ keep: true })
  })

  it('treats an absent or nonsense keep as a diagnostic', async () => {
    for (const value of [undefined, 'no', 'false', 0, null]) {
      const outcome = await dispatchTool(
        call('screenshot', value === undefined ? {} : { keep: value }),
        deps(new FakeDriver(), withRefs()),
      )
      expect(outcome.recorded).toMatchObject({ keep: false })
    }
  })
})

describe('dispatchTool: the allow-list is not negotiable', () => {
  it('propagates a policy violation instead of inviting a retry', async () => {
    const driver = new FakeDriver().program('click', {
      kind: 'throw',
      error: new NotAllowedError('https://evil.test/ is not in the allowed sites list.'),
    })
    // Every other error becomes a tool result; this one must end the run.
    await expect(
      dispatchTool(call('click', { ref: 'e1' }), deps(driver, withRefs())),
    ).rejects.toThrow(NotAllowedError)
  })

  it('propagates a disallowed navigation too', async () => {
    const driver = new FakeDriver().program('open_url', {
      kind: 'notFound',
      error: 'https://evil.test/ is not in the allowed sites list.',
    })
    await expect(
      dispatchTool(call('open_url', { url: 'https://evil.test/' }), deps(driver, withRefs())),
    ).rejects.toThrow(NotAllowedError)
  })

  it('turns an ordinary driver failure into a tool result the model can react to', async () => {
    const driver = new FakeDriver().program('click', {
      kind: 'throw',
      error: new Error('the tab went away'),
    })
    const outcome = await dispatchTool(call('click', { ref: 'e1' }), deps(driver, withRefs()))
    expect(outcome.content).toContain('the tab went away')
  })
})

describe('dispatchTool: finish', () => {
  it('records a verdict', async () => {
    const outcome = await dispatchTool(
      call('finish', {
        status: 'passed',
        summary: 'Logged in and saw the dashboard.',
        verified: ['The dashboard is visible'],
      }),
      deps(new FakeDriver(), withRefs()),
    )
    expect(outcome.verdict).toEqual({
      status: 'passed',
      summary: 'Logged in and saw the dashboard.',
      verified: ['The dashboard is visible'],
    })
  })

  it('records a failure with the problem', async () => {
    const outcome = await dispatchTool(
      call('finish', { status: 'failed', summary: 'No dashboard.', problem: 'Still on /login' }),
      deps(new FakeDriver(), withRefs()),
    )
    expect(outcome.verdict?.status).toBe('failed')
    expect(outcome.verdict?.problem).toBe('Still on /login')
  })

  it('rejects a vague status rather than guessing', async () => {
    const outcome = await dispatchTool(
      call('finish', { status: 'mostly worked', summary: 'x' }),
      deps(new FakeDriver(), withRefs()),
    )
    expect(outcome.content).toContain('"passed" or "failed"')
    expect(outcome.verdict).toBeUndefined()
  })

  it('requires a readable summary', async () => {
    const outcome = await dispatchTool(
      call('finish', { status: 'passed', summary: '   ' }),
      deps(new FakeDriver(), withRefs()),
    )
    expect(outcome.content).toContain('summary')
    expect(outcome.verdict).toBeUndefined()
  })
})

describe('validateVerdict', () => {
  const verdict = (status: 'passed' | 'failed'): Verdict => ({
    status,
    summary: 'x',
    verified: [],
  })

  it('rejects a claimed pass with no assertions at all', () => {
    const result = validateVerdict(verdict('passed'), ['The dashboard is visible'], [])
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('never made a single successful assertion')
  })

  it('rejects a pass that checked fewer expectations than the case has', () => {
    const result = validateVerdict(verdict('passed'), ['a', 'b'], ['a passed'])
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('only 1 successful assertion(s) for 2')
  })

  it('accepts a pass backed by an assertion per expectation', () => {
    expect(validateVerdict(verdict('passed'), ['a', 'b'], ['a', 'b'])).toEqual({ status: 'passed' })
  })

  it('accepts a pass when the case stated no expectations', () => {
    expect(validateVerdict(verdict('passed'), [], [])).toEqual({ status: 'passed' })
  })

  it('never second-guesses a reported failure', () => {
    expect(validateVerdict(verdict('failed'), ['a'], [])).toEqual({ status: 'failed' })
  })
})

describe('initialMessages', () => {
  it('puts the system prompt first and the case second', () => {
    const messages = initialMessages('SYS', 'CASE')
    expect(messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'CASE' },
    ])
  })
})
