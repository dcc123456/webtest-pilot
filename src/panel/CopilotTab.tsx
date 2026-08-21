/**
 * The conversational assistant tab ("对话").
 *
 * Distinct from {@link ChatTab}, which turns natural language into a *test case*
 * and then runs the test agent to a verdict. This tab is an open-ended assistant:
 * "analyse this page", "fill this form using my details", "scroll down and tell me
 * what changed". It drives the same page tools, but it has no pass/fail, can run
 * as many rounds as the budget allows, and pauses for approval when its chosen
 * confirmation mode requires it.
 *
 * The transcript is rebuilt from worker events (`conv*`) rather than fetched, for
 * the same reason the run transcript is: streaming text and tool calls must appear
 * as they happen. State lives in the worker (see `conversation.ts`); this component
 * is a renderer plus the approval/save controls.
 *
 * @module panel/CopilotTab
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConfirmMode, ScriptStep, Skill } from '../lib/types'
import type { ConversationEntry, WorkerEvent } from '../lib/messages'
import { is } from '../lib/messages'
import {
  Badge,
  Button,
  Collapsible,
  Empty,
  Notice,
  usePending,
  useToast,
} from './components'
import type { WorkerApi } from './useWorker'
import { describeStep } from '../lib/script'

/** One rendered transcript line, matching the worker's persisted shape. */
type Entry = ConversationEntry

const CONFIRM_MODES: { value: ConfirmMode; label: string; hint: string }[] = [
  {
    value: 'auto',
    label: '全自动',
    hint: '模型直接读取并操作页面，不弹确认。适合只读分析或你完全信任的重复操作。',
  },
  {
    value: 'write',
    label: '改页面时确认',
    hint: '点击、填写、选择、勾选、按键等会改动页面的动作，执行前先问你；读取和滚动不打扰。',
  },
  {
    value: 'always',
    label: '每一步都确认',
    hint: '包括读取、滚动在内的每次工具调用都先征得你同意，最稳妥。',
  },
]

export function CopilotTab({ worker }: { worker: WorkerApi }) {
  const { state, call, subscribe } = worker
  const [entries, setEntries] = useState<Entry[]>([])
  const [draft, setDraft] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null)
  const [confirmMode, setConfirmMode] = useState<ConfirmMode>(
    state.settings.policy.confirmMode,
  )
  /** Steps from the last turn, offered for save-as-script. */
  const [lastSteps, setLastSteps] = useState<ScriptStep[]>([])
  const [selectedSteps, setSelectedSteps] = useState<Set<number>>(new Set())
  const [scriptName, setScriptName] = useState('')
  const [showSave, setShowSave] = useState(false)
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({})

  const sending = usePending()
  const approving = usePending()
  const toast = useToast()
  const logRef = useRef<HTMLDivElement | null>(null)

  const activeSkill = useMemo(
    () => state.skills.find((skill) => skill.id === activeSkillId) ?? null,
    [state.skills, activeSkillId],
  )

  // Restore the persisted transcript on mount so switching tabs (which unmounts
  // this component) no longer wipes the conversation. The worker is the source of
  // truth; events streamed afterward merge in by id.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await call({ type: 'getConversation' })
        if (cancelled || !is.conversation(response)) return
        setEntries(response.conversation.entries)
        if (response.conversation.lastSteps.length > 0) {
          setLastSteps(response.conversation.lastSteps)
          setSelectedSteps(
            new Set(response.conversation.lastSteps.map((_, index) => index)),
          )
        }
      } catch {
        /* a restore failure leaves the tab empty; the next send still works */
      }
    })()
    return () => {
      cancelled = true
    }
    // Only run on mount: `call` is stable, and subsequent updates arrive via the
    // subscription below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply incoming worker events to the local transcript.
  useEffect(() => {
    return subscribe((event: WorkerEvent) => {
      switch (event.type) {
        case 'convUser':
          setEntries((current) => [
            ...current,
            { id: `u${event.at}`, kind: 'user', text: event.text, at: event.at },
          ])
          break
        case 'convAssistant': {
          setEntries((current) => {
            const last = current[current.length - 1]
            if (last?.kind === 'assistant' && last.streaming) {
              return [
                ...current.slice(0, -1),
                { ...last, text: event.text, at: event.at },
              ]
            }
            return [
              ...current,
              {
                id: `a${event.at}`,
                kind: 'assistant',
                text: event.text,
                streaming: true,
                at: event.at,
              },
            ]
          })
          break
        }
        case 'convStatus':
          // Empty status just marks the assistant turn as final; non-empty shows a
          // quiet line (e.g. "正在思考…").
          if (event.text) {
            setEntries((current) => [
              ...current,
              { id: `s${event.at}`, kind: 'status', text: event.text, at: event.at },
            ])
          } else {
            setEntries((current) =>
              current.map((entry) =>
                entry.kind === 'assistant' && entry.streaming
                  ? { ...entry, streaming: false }
                  : entry,
              ),
            )
          }
          break
        case 'convTool':
          // A resolved tool call replaces the matching pending card, if any.
          setEntries((current) => {
            const withoutPending = current.filter(
              (entry) =>
                !(
                  entry.kind === 'pending' &&
                  (entry.name === event.name || entry.args === event.args)
                ),
            )
            return [
              ...withoutPending,
              {
                id: event.id,
                kind: 'tool',
                name: event.name,
                args: event.args,
                result: event.result,
                ok: event.ok,
                declined: event.declined,
                durationMs: event.durationMs,
                at: event.at,
              },
            ]
          })
          break
        case 'convPending':
          setPendingId(event.pendingId)
          setEntries((current) => [
            ...current,
            {
              id: event.pendingId,
              kind: 'pending',
              pendingId: event.pendingId,
              name: event.name,
              args: event.args,
              mutating: event.mutating,
              at: event.at,
            },
          ])
          break
        case 'convDone':
          setPendingId(null)
          if (event.steps.length > 0) {
            setLastSteps(event.steps)
            setSelectedSteps(new Set(event.steps.map((_, index) => index)))
          }
          setEntries((current) =>
            current.map((entry) =>
              entry.kind === 'assistant' && entry.streaming
                ? { ...entry, streaming: false }
                : entry,
            ),
          )
          break
        case 'convCleared':
          setEntries([])
          setLastSteps([])
          setPendingId(null)
          break
        default:
          break
      }
    })
  }, [subscribe])

  // Auto-scroll to the newest entry while streaming.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [entries])

  const send = useCallback(() => {
    const text = draft.trim()
    if (!text || state.conversationActive) return
    void sending.run(async () => {
      try {
        await call({
          type: 'converse',
          message: text,
          skillId: activeSkillId,
          confirmMode,
        })
        setDraft('')
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      }
    })
  }, [draft, state.conversationActive, activeSkillId, confirmMode, call, sending, toast])

  const answer = useCallback(
    (approved: boolean) => {
      if (!pendingId) return
      void approving.run(async () => {
        await call({ type: 'approveAction', pendingId, approved })
        setPendingId(null)
        // Remove the pending card; the resolved tool card arrives via convTool.
        setEntries((current) =>
          current.filter((entry) => entry.kind !== 'pending' || entry.pendingId !== pendingId),
        )
      })
    },
    [pendingId, approving, call],
  )

  const cancel = useCallback(() => {
    void call({ type: 'cancelConversation' })
  }, [call])

  const saveScript = useCallback(() => {
    const indices = [...selectedSteps].sort((a, b) => a - b)
    if (indices.length === 0) {
      toast.error('请至少选择一个步骤。')
      return
    }
    void sending.run(async () => {
      try {
        const response = await call({
          type: 'saveConversationScript',
          name: scriptName || '对话录制脚本',
          startUrl: '',
          indices,
        })
        if (is.message(response)) toast.success(response.message)
        setShowSave(false)
        setScriptName('')
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      }
    })
  }, [selectedSteps, scriptName, call, sending, toast])

  const hasProvider = state.settings.providers.some((profile) => profile.apiKey.trim())

  if (!hasProvider) {
    return (
      <div className='stack'>
        <Notice kind='warn' title='还没有配置模型'>
          对话助手需要一个 OpenAI 兼容接口。请到「设置 → 模型」填写 base URL、API Key 与模型名称。
        </Notice>
      </div>
    )
  }

  return (
    <div className='chat'>
      <div className='chat__log' ref={logRef}>
        {entries.length === 0 ? (
          <Empty
            title='和当前页面对话'
            hint='试着说「分析一下这个页面」「用我的资料填写这个表单」「往下滚动看看还有什么」。助手会读取并操作你正在看的页面；需要确认时会先问你。'
          />
        ) : (
          entries.map((entry) => {
            switch (entry.kind) {
              case 'user':
                return (
                  <div className='msg msg--user' key={entry.id}>
                    <span className='msg__text'>{entry.text}</span>
                  </div>
                )
              case 'assistant':
                return (
                  <div className='msg msg--assistant' key={entry.id}>
                    <span className='msg__text'>
                      {entry.text}
                      {entry.streaming ? <span className='msg__caret' aria-hidden='true'>&nbsp;</span> : null}
                    </span>
                  </div>
                )
              case 'status':
                return (
                  <div className='msg msg--system' key={entry.id}>
                    <span className='msg__text'>{entry.text}</span>
                  </div>
                )
              case 'tool':
                return (
                  <div className='tool-row' key={entry.id}>
                    <Collapsible
                      open={openTools[entry.id] === true}
                      onToggle={(next) => setOpenTools((current) => ({ ...current, [entry.id]: next }))}
                      summary={
                        <span className='row row--wrap'>
                          <span
                            className={entry.ok ? 'tool-row__ok' : 'tool-row__bad'}
                            aria-hidden='true'
                          >
                            {entry.declined ? '⊘' : entry.ok ? '✓' : '✗'}
                          </span>
                          <span className='tool-row__name'>{entry.name}</span>
                          <span className='tool-row__summary'>{entry.args}</span>
                          <span className='faint small'>{entry.durationMs}ms</span>
                        </span>
                      }
                    >
                      <span className='tool-row__detail'>{entry.result}</span>
                    </Collapsible>
                  </div>
                )
              case 'pending':
                return (
                  <div className='confirm-card' key={entry.id}>
                    <span className='confirm-card__title'>
                      {entry.mutating ? '允许助手改动页面？' : '允许助手读取页面？'}
                    </span>
                    <span className='confirm-card__action'>
                      <code>{entry.name}</code> {entry.args}
                    </span>
                    <span className='row'>
                      <Button small variant='primary' pending={approving.pending} onClick={() => answer(true)}>
                        允许
                      </Button>
                      <Button small pending={approving.pending} onClick={() => answer(false)}>
                        拒绝
                      </Button>
                    </span>
                  </div>
                )
              default:
                return null
            }
          })
        )}
      </div>

      {lastSteps.length > 0 && !showSave ? (
        <div className='chat__savebar'>
          <Button small onClick={() => setShowSave(true)}>
            把这轮操作存为脚本（{lastSteps.length} 步）
          </Button>
        </div>
      ) : null}

      {showSave ? (
        <div className='chat__savepanel'>
          <span className='dim small'>勾选要保存的步骤，命名后保存为可回放脚本。</span>
          <div className='chat__steps'>
            {lastSteps.map((step, index) => (
              <label className='chat__step' key={index}>
                <input
                  type='checkbox'
                  checked={selectedSteps.has(index)}
                  onChange={(event) =>
                    setSelectedSteps((current) => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(index)
                      else next.delete(index)
                      return next
                    })
                  }
                />
                <span className='small'>{describeStep(step)}</span>
              </label>
            ))}
          </div>
          <div className='row'>
            <input
              type='text'
              placeholder='脚本名称'
              value={scriptName}
              onChange={(event) => setScriptName(event.target.value)}
            />
            <Button small variant='primary' onClick={saveScript}>
              保存
            </Button>
            <Button small variant='ghost' onClick={() => setShowSave(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}

      <div className='chat__compose'>
        <div className='row row--wrap'>
          {activeSkill ? (
            <Badge tone='info'>
              技能：{activeSkill.name}
              <button
                className='chip-clear'
                onClick={() => setActiveSkillId(null)}
                title='不使用技能'
                type='button'
              >
                ×
              </button>
            </Badge>
          ) : state.skills.length > 0 ? (
            <select
              value=''
              onChange={(event) => setActiveSkillId(event.target.value || null)}
            >
              <option value=''>使用技能…</option>
              {state.skills.map((skill: Skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.name}
                </option>
              ))}
            </select>
          ) : null}
          <span className='spacer' />
          {pendingId ? (
            <span className='faint small'>等待你确认上方的操作…</span>
          ) : null}
        </div>

        <textarea
          rows={3}
          placeholder='说点什么，或描述你想让助手对这个页面做什么…（Enter 发送，Shift+Enter 换行）'
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div className='chat__composer-row'>
          <span className='chat__composer-left'>
            <label
              className='confirm-select'
              title={CONFIRM_MODES.find((m) => m.value === confirmMode)?.hint}
            >
              <select
                value={confirmMode}
                onChange={(event) => {
                  const next = event.target.value as ConfirmMode
                  setConfirmMode(next)
                  // Push immediately so an in-flight turn reads the new mode for
                  // its next action, not just the following user message.
                  void call({ type: 'setConversationConfirmMode', mode: next })
                }}
                aria-label='确认模式'
              >
                {CONFIRM_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value} title={mode.hint}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </label>
            <span
              className='help-icon'
              tabIndex={0}
              aria-label='确认模式说明'
              // The hint text lives in CSS ::after so it is not duplicated here.
              data-hint={CONFIRM_MODES.find((mode) => mode.value === confirmMode)?.hint}
            >
              ?
            </span>
          </span>

          <span className='chat__composer-right'>
            {entries.length > 0 && !state.conversationActive ? (
              <Button
                small
                variant='ghost'
                onClick={() => void call({ type: 'clearConversation' })}
              >
                新对话
              </Button>
            ) : null}
            {state.conversationActive ? (
              <Button small onClick={cancel}>
                停止
              </Button>
            ) : (
              <Button
                small
                variant='primary'
                disabled={draft.trim().length === 0}
                pending={sending.pending}
                onClick={send}
              >
                发送
              </Button>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}
