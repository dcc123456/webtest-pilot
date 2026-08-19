/**
 * Chat: the primary surface.
 *
 * The workflow this tab exists to serve is "I have a test in my head or in a
 * Markdown file; get it running". So it is deliberately *not* a chat with a
 * model — the model is driven by the worker's agent loop, and this panel has no
 * conversational endpoint of its own. What looks like a conversation is:
 *
 * 1. the user's case text, sent as `importMarkdown`,
 * 2. the worker's parse result, offered as a runnable case,
 * 3. and, once running, the agent's own `assistantText` deltas and `toolCall`
 *    events replayed as transcript entries.
 *
 * Tool calls are collapsed to one line each because an agent run emits dozens of
 * them; expanded on demand, hidden by default. Watching the agent work is the
 * point, drowning in `snapshot` payloads is not.
 *
 * @module panel/ChatTab
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { is } from '../lib/messages'
import type { TestCase } from '../lib/types'
import {
  Badge,
  Button,
  Collapsible,
  Empty,
  Notice,
  StatusBadge,
  Truncated,
  usePending,
  useToast,
} from './components'
import type { WorkerApi } from './useWorker'

/** One transcript entry. A discriminated union so rendering cannot mix them up. */
type Entry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; runId: string; text: string }
  | { kind: 'tool'; id: string; runId: string; name: string; summary: string }
  | { kind: 'system'; id: string; text: string; tone: 'info' | 'error' }
  | { kind: 'cases'; id: string; caseIds: string[] }
  | { kind: 'run'; id: string; runId: string }

let entrySeq = 0

function nextEntryId(): string {
  entrySeq += 1
  return `e${entrySeq}`
}

export function ChatTab({
  worker,
  onOpenCase,
  onOpenRun,
}: {
  worker: WorkerApi
  /** Jumps to the Cases tab focused on one case, for editing before a run. */
  onOpenCase: (caseId: string) => void
  /** Jumps to the Runs tab focused on one run, for the step list and screenshots. */
  onOpenRun: (runId: string) => void
}) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [draft, setDraft] = useState('')
  const [showTools, setShowTools] = useState(true)
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({})
  const logRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const toast = useToast()
  const importing = usePending()

  const { call, subscribe, state } = worker

  const append = useCallback((entry: Entry) => {
    setEntries((current) => [...current, entry])
  }, [])

  /**
   * Streaming assistant text is merged into the trailing entry for its run.
   *
   * Appending one entry per delta would produce hundreds of bubbles per run; the
   * check for "trailing" matters because a tool call in between must break the
   * text into a new bubble, or the transcript would show the agent's reasoning
   * out of order relative to its actions.
   */
  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      switch (event.type) {
        case 'assistantText': {
          setEntries((current) => {
            const last = current[current.length - 1]
            if (last && last.kind === 'assistant' && last.runId === event.runId) {
              return current.with(current.length - 1, { ...last, text: last.text + event.delta })
            }
            return [
              ...current,
              { kind: 'assistant', id: nextEntryId(), runId: event.runId, text: event.delta },
            ]
          })
          break
        }
        case 'toolCall':
          append({
            kind: 'tool',
            id: nextEntryId(),
            runId: event.runId,
            name: event.name,
            summary: event.summary,
          })
          break
        case 'runStatus':
          // Only terminal transitions are narrated: "running" is already visible
          // from the run entry's own badge, and echoing it would add noise.
          if (event.status === 'running' || event.status === 'queued') break
          append({
            kind: 'system',
            id: nextEntryId(),
            tone: event.status === 'passed' ? 'info' : 'error',
            text: event.message
              ? `运行结束：${event.status} — ${event.message}`
              : `运行结束：${event.status}`,
          })
          break
        default:
          break
      }
    })
    return unsubscribe
  }, [append, subscribe])

  /** Follows the tail while new content arrives, which is what a watcher wants. */
  useEffect(() => {
    const element = logRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [entries])

  const caseById = useMemo(() => {
    const map = new Map<string, TestCase>()
    for (const entry of state.cases) map.set(entry.id, entry)
    return map
  }, [state.cases])

  const runById = useMemo(() => {
    const map = new Map<string, (typeof state.runs)[number]>()
    for (const run of state.runs) map.set(run.id, run)
    return map
  }, [state.runs])

  const providerReady = state.settings.activeProviderId.length > 0
  const sitesConfigured = state.settings.policy.allowedSites.length > 0

  const submitMarkdown = useCallback(
    async (markdown: string, source: 'chat' | 'markdown') => {
      const text = markdown.trim()
      if (!text) return
      append({ kind: 'user', id: nextEntryId(), text })
      await importing.run(async () => {
        const response = await call({ type: 'importMarkdown', markdown: text, source })
        if (!is.cases(response)) {
          throw new Error('后台没有返回解析出的用例。')
        }
        append({
          kind: 'cases',
          id: nextEntryId(),
          caseIds: response.cases.map((entry) => entry.id),
        })
        setDraft('')
      })
    },
    [append, call, importing],
  )

  const startRun = useCallback(
    async (caseId: string, useAgent: boolean) => {
      const response = await call({ type: 'runCase', caseId, useAgent })
      if (is.run(response)) {
        append({ kind: 'run', id: nextEntryId(), runId: response.run.id })
        return
      }
      // The worker replies with a message when the run started but had not
      // registered yet; that is a success, just without an id to follow.
      append({
        kind: 'system',
        id: nextEntryId(),
        tone: 'info',
        text: is.message(response) ? response.message : '运行已启动。',
      })
    },
    [append, call],
  )

  const pickFile = useCallback(() => {
    fileRef.current?.click()
  }, [])

  const onFile = useCallback(
    (file: File) => {
      const reader = new FileReader()
      reader.onerror = () => {
        toast.error(`读取文件「${file.name}」失败。`)
      }
      reader.onload = () => {
        const result = reader.result
        if (typeof result !== 'string') {
          toast.error(`文件「${file.name}」不是文本文件。`)
          return
        }
        void submitMarkdown(result, 'markdown')
      }
      reader.readAsText(file)
    },
    [submitMarkdown, toast],
  )

  return (
    <div className='chat'>
      <div className='chat__log' ref={logRef}>
        {!providerReady ? (
          <Notice kind='warn' title='还没有配置模型（provider）'>
            智能体运行（agent）需要一个 OpenAI 兼容接口。请到「设置」标签页填写 base URL、API key
            与模型；已录制的脚本（script）可以在没有模型的情况下回放。
          </Notice>
        ) : null}
        {!sitesConfigured ? (
          <Notice kind='warn' title='还没有配置站点白名单（allowed sites）'>
            这是本插件唯一的安全边界：白名单为空时，任何运行都会被拒绝。请到「设置 →
            站点白名单」添加被测站点，例如 <code className='mono'>https://staging.example.com/*</code>。
          </Notice>
        ) : null}

        {entries.length === 0 ? (
          <Empty
            title='把测试用例贴进来'
            hint='可以是自然语言，也可以是 Markdown（# 标题 / ## 步骤 / ## 预期）。发送后会解析成测试用例（test case），再决定是否让智能体（agent）立即执行。'
            action={
              <Button small onClick={pickFile}>
                从 .md 文件导入
              </Button>
            }
          />
        ) : null}

        {entries.map((entry) => {
          switch (entry.kind) {
            case 'user':
              return (
                <div className='msg msg--user' key={entry.id}>
                  <span className='msg__role'>我</span>
                  <span className='msg__text'>{entry.text}</span>
                </div>
              )
            case 'assistant':
              return (
                <div className='msg msg--assistant' key={entry.id}>
                  <span className='msg__role'>智能体（agent）</span>
                  <span className='msg__text'>
                    {entry.text}
                    {state.activeRunIds.includes(entry.runId) ? (
                      <span className='msg__caret' aria-hidden='true'>
                        &nbsp;
                      </span>
                    ) : null}
                  </span>
                </div>
              )
            case 'tool': {
              if (!showTools) return null
              const open = openTools[entry.id] === true
              return (
                <div className='tool-row' key={entry.id}>
                  <Collapsible
                    open={open}
                    onToggle={(next) =>
                      setOpenTools((current) => ({ ...current, [entry.id]: next }))
                    }
                    summary={
                      <span className='row'>
                        <span className='tool-row__name'>{entry.name}</span>
                        <span className='tool-row__summary'>{entry.summary}</span>
                      </span>
                    }
                  >
                    <span className='tool-row__detail'>{entry.summary}</span>
                  </Collapsible>
                </div>
              )
            }
            case 'system':
              return (
                <div
                  className={entry.tone === 'error' ? 'msg msg--error' : 'msg msg--system'}
                  key={entry.id}
                >
                  <span className='msg__text'>{entry.text}</span>
                </div>
              )
            case 'cases':
              return (
                <div className='msg msg--assistant' key={entry.id}>
                  <span className='msg__role'>解析结果</span>
                  <span className='dim small'>
                    解析出 {entry.caseIds.length} 个测试用例，已保存。可以直接运行，也可以先编辑。
                  </span>
                  {entry.caseIds.map((caseId) => {
                    const testCase = caseById.get(caseId)
                    if (!testCase) {
                      return (
                        <span className='faint small' key={caseId}>
                          该用例已被删除。
                        </span>
                      )
                    }
                    return <ParsedCaseCard key={caseId} testCase={testCase} onRun={startRun} onEdit={onOpenCase} />
                  })}
                </div>
              )
            case 'run': {
              const run = runById.get(entry.runId)
              if (!run) {
                return (
                  <div className='msg msg--system' key={entry.id}>
                    <span className='msg__text'>运行 {entry.runId} 的记录已被清除。</span>
                  </div>
                )
              }
              const active = state.activeRunIds.includes(run.id)
              const okSteps = run.steps.filter((step) => step.ok).length
              return (
                <div className='msg msg--assistant' key={entry.id}>
                  <span className='row row--wrap'>
                    <StatusBadge status={run.status} />
                    <Truncated text={run.caseName} />
                  </span>
                  <span className='faint small'>
                    步骤 {okSteps}/{run.steps.length} · {run.mode === 'agent' ? '智能体' : '脚本回放'}
                  </span>
                  {run.failure ? (
                    <span className='step__error'>
                      第 {run.failure.stepIndex + 1} 步：{run.failure.message}
                    </span>
                  ) : null}
                  <span className='row'>
                    <Button small onClick={() => onOpenRun(run.id)}>
                      查看详情
                    </Button>
                    {active ? (
                      <CancelButton runId={run.id} worker={worker} />
                    ) : null}
                  </span>
                </div>
              )
            }
          }
        })}
      </div>

      <div className='chat__compose'>
        <textarea
          value={draft}
          rows={4}
          placeholder={
            '例如：\n打开 https://staging.example.com/login\n1. 输入用户名 demo\n2. 输入密码「password」\n3. 点击登录\n## 预期\n- 页面出现「欢迎回来」'
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Ctrl/Cmd+Enter sends. Plain Enter must insert a newline: a test case
            // is inherently multi-line, and sending on Enter would truncate most
            // of what the user is typing.
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              void submitMarkdown(draft, 'chat')
            }
          }}
        />
        <div className='row row--wrap'>
          <Button
            variant='primary'
            pending={importing.pending}
            disabled={draft.trim().length === 0}
            onClick={() => void submitMarkdown(draft, 'chat')}
          >
            发送并解析
          </Button>
          <Button small onClick={pickFile}>
            从 .md 文件导入
          </Button>
          <span className='spacer' />
          <Button
            variant='ghost'
            small
            onClick={() => setShowTools((current) => !current)}
            title='工具调用（function calling）是智能体对页面执行的每一个动作'
          >
            {showTools ? '隐藏工具调用' : '显示工具调用'}
          </Button>
          {entries.length > 0 ? (
            <Button variant='ghost' small onClick={() => setEntries([])}>
              清屏
            </Button>
          ) : null}
        </div>
        <span className='faint small'>Ctrl/⌘ + Enter 发送。解析出的用例会保存到「用例」标签页。</span>
        <input
          ref={fileRef}
          type='file'
          accept='.md,.markdown,.txt,text/markdown,text/plain'
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            // The value is cleared so picking the same file twice still fires.
            event.target.value = ''
            if (file) onFile(file)
          }}
        />
      </div>
    </div>
  )
}

/** A freshly parsed case, with the two ways to run it. */
function ParsedCaseCard({
  testCase,
  onRun,
  onEdit,
}: {
  testCase: TestCase
  onRun: (caseId: string, useAgent: boolean) => Promise<void>
  onEdit: (caseId: string) => void
}) {
  const agent = usePending()
  const replay = usePending()

  return (
    <div className='card card--tight'>
      <span className='card__title' title={testCase.name}>
        {testCase.name}
      </span>
      {testCase.startUrl ? (
        <Truncated text={testCase.startUrl} className='faint small' mono />
      ) : (
        <span className='faint small'>没有起始 URL，智能体会从用例正文里推断。</span>
      )}
      <span className='faint small'>
        {testCase.steps.length} 个步骤 · {testCase.expectations.length} 条预期
      </span>
      <div className='row row--wrap' style={{ marginTop: 5 }}>
        <Button
          variant='primary'
          small
          pending={agent.pending}
          onClick={() => void agent.run(() => onRun(testCase.id, true))}
        >
          用智能体运行
        </Button>
        {testCase.scriptId ? (
          <Button
            small
            pending={replay.pending}
            onClick={() => void replay.run(() => onRun(testCase.id, false))}
            title='回放已录制的脚本（script）：不消耗模型 token，结果确定'
          >
            回放脚本
          </Button>
        ) : null}
        <Button variant='ghost' small onClick={() => onEdit(testCase.id)}>
          编辑
        </Button>
        {testCase.expectations.length === 0 ? (
          <Badge tone='warn' title='没有预期时，只要每一步都执行成功就算通过'>
            无预期
          </Badge>
        ) : null}
      </div>
    </div>
  )
}

function CancelButton({ runId, worker }: { runId: string; worker: WorkerApi }) {
  const { pending, run } = usePending()
  const toast = useToast()
  return (
    <Button
      small
      variant='danger'
      pending={pending}
      onClick={() =>
        void run(async () => {
          const response = await worker.call({ type: 'cancelRun', runId })
          toast.info(is.message(response) ? response.message : '已请求取消。')
        })
      }
    >
      取消
    </Button>
  )
}
