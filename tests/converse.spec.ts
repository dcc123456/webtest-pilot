/**
 * Tests for the open-ended conversation loop in {@link converse}.
 *
 * These use a scripted model (a queue of streamed completions) plus the
 * {@link FakeDriver}, so confirmation gating, stop condition, secret
 * substitution, and recording can be exercised deterministically without a real
 * browser or LLM.
 *
 * @module tests/converse.spec
 */

import { describe, expect, it } from 'vitest'
import { converse } from '../src/background/converse'
import { NotAllowedError, type RunContext } from '../src/background/driver'
import type { StreamRequest, WireToolCall } from '../src/lib/llm'
import { FakeDriver } from './fake-driver'

const CONTEXT: RunContext = { tabId: 1 } as RunContext

/** Polls an assertion until it passes or a short deadline, for async gating. */
async function waitFor(assert: () => void, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      assert()
      return
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

interface ScriptedTurn {
  content?: string
  toolCalls?: WireToolCall[]
}

/** Builds a `stream` impl that yields one turn per call in order. */
function scriptedModel(turns: ScriptedTurn[]) {
  const queue = [...turns]
  return async (
    _request: StreamRequest,
    handlers: { onText?: (delta: string) => void },
  ): Promise<{ content: string; toolCalls: WireToolCall[] }> => {
    const turn = queue.shift() ?? { content: '' }
    const content = turn.content ?? ''
    if (content && handlers.onText) handlers.onText(content)
    return { content, toolCalls: turn.toolCalls ?? [] }
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown>): WireToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/** A snapshot with a single element at `ref`. */
function snapshotWith(
  ref: string,
  role: string,
  name: string,
  tag: string,
  selector: { how: 'css' | 'text'; value: string },
  url = 'https://app.test/',
) {
  return {
    url,
    title: 'App',
    text: name,
    truncated: false,
    selection: '',
    elements: [
      {
        ref,
        role,
        name,
        tag,
        inViewport: true,
        target: { primary: selector, fallbacks: [] },
      },
    ],
    elementsTruncated: false,
    frameUrl: url,
    isTopFrame: true,
    forms: [],
  }
}

function baseOptions(overrides: Partial<Parameters<typeof converse>[2]> = {}): Parameters<
  typeof converse
>[2] {
  return {
    driver: new FakeDriver(),
    context: CONTEXT,
    provider: { apiKey: 'k', baseUrl: 'https://api.test', model: 'm' },
    catalogue: [],
    confirmMode: 'auto',
    secretNames: [],
    secretValues: new Map(),
    selfHeal: false,
    maxRounds: 8,
    allowedSites: ['*'],
    pageUrl: 'https://app.test/',
    pageTitle: 'App',
    ...overrides,
  }
}

describe('converse stop condition', () => {
  it('stops as soon as the model replies with no tool call', async () => {
    const options = baseOptions({
      stream: scriptedModel([{ content: 'The page title is App.' }]),
    })
    const result = await converse([], 'analyse this page', options)
    expect(result.steps).toHaveLength(0)
    expect(result.messages.some((m) => m.role === 'assistant')).toBe(true)
    expect(result.messages[0]?.role).toBe('system')
    expect(result.messages.some((m) => m.role === 'user')).toBe(true)
  })

  it('records an approved, effectful action as a step', async () => {
    const driver = new FakeDriver()
    driver.snapshotToReturn = snapshotWith('e1', 'button', 'Submit', 'button', {
      how: 'text',
      value: 'Submit',
    })
    const options = baseOptions({
      driver,
      stream: scriptedModel([
        { toolCalls: [toolCall('s1', 'snapshot', { maxElements: 50 })] },
        { toolCalls: [toolCall('c1', 'click', { ref: 'e1' })] },
        { content: 'Clicked submit.' },
      ]),
    })
    const result = await converse([], 'click submit', options)
    expect(driver.countOf('click')).toBe(1)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]?.action).toBe('click')
  })
})

describe('converse confirmation gating', () => {
  it('pauses on a mutating tool in write mode and runs it when approved', async () => {
    const driver = new FakeDriver()
    driver.snapshotToReturn = snapshotWith('e1', 'textbox', 'Search', 'input', {
      how: 'css',
      value: '#q',
    })
    let pendingResolve: ((approved: boolean) => void) | undefined
    const options = baseOptions({
      driver,
      confirmMode: 'write',
      stream: scriptedModel([
        { toolCalls: [toolCall('s1', 'snapshot', {})] },
        { toolCalls: [toolCall('f1', 'fill', { ref: 'e1', value: 'hello' })] },
        { content: 'Filled.' },
      ]),
      onPending: (action) => {
        pendingResolve = action.decide
        expect(action.mutating).toBe(true)
        expect(action.name).toBe('fill')
      },
    })
    const promise = converse([], 'fill hello', options)
    await waitFor(() => expect(pendingResolve).toBeDefined())
    pendingResolve?.(true)
    const result = await promise
    expect(driver.countOf('fill')).toBe(1)
    expect(result.steps).toHaveLength(1)
  })

  it('does not run a declined action and tells the model', async () => {
    const driver = new FakeDriver()
    let pendingResolve: ((approved: boolean) => void) | undefined
    const options = baseOptions({
      driver,
      confirmMode: 'always',
      stream: scriptedModel([
        { toolCalls: [toolCall('c1', 'click', { ref: 'e1' })] },
        { content: "OK, I won't click." },
      ]),
      onPending: (action) => {
        pendingResolve = action.decide
      },
    })
    const promise = converse([], 'click it', options)
    await waitFor(() => expect(pendingResolve).toBeDefined())
    pendingResolve?.(false)
    const result = await promise
    expect(driver.countOf('click')).toBe(0)
    expect(result.steps).toHaveLength(0)
    const declineMessage = result.messages.find(
      (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('declined'),
    )
    expect(declineMessage).toBeDefined()
  })

  it('skips the gate entirely in auto mode', async () => {
    const driver = new FakeDriver()
    let pendingSeen = false
    const options = baseOptions({
      driver,
      confirmMode: 'auto',
      stream: scriptedModel([{ content: 'Nothing to do.' }]),
      onPending: () => {
        pendingSeen = true
      },
    })
    await converse([], 'hi', options)
    expect(pendingSeen).toBe(false)
  })
})

describe('converse skills and secrets', () => {
  it('substitutes a secret value at fill time while recording only the ref', async () => {
    const driver = new FakeDriver()
    driver.program('fill', { kind: 'ok' })
    const fillOps: Array<{ value?: unknown; secretRef?: unknown }> = []
    const originalExec = driver.exec.bind(driver)
    driver.exec = async (context, op) => {
      if (op.action === 'fill') {
        const fillOp = op as unknown as { value?: unknown; secretRef?: unknown }
        fillOps.push({ value: fillOp.value, secretRef: fillOp.secretRef })
      }
      return originalExec(context, op)
    }
    driver.snapshotToReturn = snapshotWith('p1', 'textbox', 'Password', 'input', {
      how: 'css',
      value: '#pw',
    })
    const options = baseOptions({
      driver,
      secretNames: ['PASSWORD'],
      secretValues: new Map([['PASSWORD', 's3cr3t']]),
      stream: scriptedModel([
        { toolCalls: [toolCall('s1', 'snapshot', {})] },
        { toolCalls: [toolCall('p1', 'fill', { ref: 'p1', secretRef: 'PASSWORD' })] },
        { content: 'Filled the password.' },
      ]),
    })
    const result = await converse([], 'fill password', options)
    expect(result.steps[0]?.secretRef).toBe('PASSWORD')
    expect(result.steps[0]?.value).toBeUndefined()
    const withValue = fillOps.find((op) => op.value === 's3cr3t')
    expect(withValue).toBeDefined()
  })

  it('surfaces the active skill in the system prompt', async () => {
    let capturedRequest: StreamRequest | undefined
    const options = baseOptions({
      stream: async (request) => {
        capturedRequest = request
        return { content: 'OK', toolCalls: [] }
      },
      activeSkill: {
        id: 'skill_x',
        name: 'Login details',
        description: 'fills the login form',
        instructions: 'fill account then password',
        autoMatch: true,
        fields: [{ label: 'account', value: 'alice' }],
        createdAt: 1,
        updatedAt: 1,
      },
    })
    await converse([], 'log in with my details', options)
    const system = capturedRequest?.messages.find((m) => m.role === 'system')
    expect(system && typeof system.content === 'string' && system.content).toContain('Login details')
  })
})

describe('converse error handling', () => {
  it('surfaces an allow-list violation as a tool error and keeps going', async () => {
    const driver = new FakeDriver()
    driver.program('open_url', { kind: 'throw', error: new NotAllowedError('not allowed') })
    const options = baseOptions({
      driver,
      allowedSites: ['https://allowed.test/*'],
      stream: scriptedModel([
        { toolCalls: [toolCall('o1', 'open_url', { url: 'https://evil.test/' })] },
        { content: 'That URL was refused.' },
      ]),
    })
    const result = await converse([], 'open evil.test', options)
    const toolMessage = result.messages.find(
      (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('allowed'),
    )
    expect(toolMessage).toBeDefined()
    expect(result.steps).toHaveLength(0)
  })
})
