/**
 * Cases: the library of *intent*.
 *
 * A case is prose — what to do, what should then be true — so the editor is a
 * list of text lines rather than a form of selectors. That is the whole point of
 * keeping cases separate from scripts: a human edits the intent, and the script
 * is regenerated whenever the UI changes underneath it.
 *
 * The Markdown view is the interchange format, not a nicety: `renderCaseMarkdown`
 * round-trips through the parser, so copying it out, editing it anywhere, and
 * pasting it back into Chat is lossless.
 *
 * @module panel/CasesTab
 */

import { useEffect, useMemo, useState } from 'react'
import { renderCaseMarkdown } from '../lib/markdown'
import { is } from '../lib/messages'
import type { CaseSource, TestCase } from '../lib/types'
import {
  Badge,
  Button,
  ConfirmAction,
  CopyButton,
  Empty,
  Field,
  Modal,
  Notice,
  Toggle,
  Truncated,
  downloadText,
  safeFileName,
  usePending,
  useToast,
} from './components'
import type { WorkerApi } from './useWorker'

/** Where a case came from. Shown as a badge so provenance is never guesswork. */
const SOURCE_LABEL: Record<CaseSource, string> = {
  chat: '对话',
  markdown: 'Markdown',
  manual: '手动',
  bridge: '本地接口（bridge）',
}

export function CasesTab({
  worker,
  focusCaseId,
  onFocusHandled,
  onOpenRun,
  onOpenSettings,
}: {
  worker: WorkerApi
  /** Case the Chat tab asked us to open for editing; cleared once honoured. */
  focusCaseId: string | null
  onFocusHandled: () => void
  onOpenRun: (runId: string) => void
  onOpenSettings: () => void
}) {
  const { state, call } = worker
  const [editing, setEditing] = useState<TestCase | null>(null)
  const [markdownFor, setMarkdownFor] = useState<TestCase | null>(null)
  const [filter, setFilter] = useState('')

  const scriptByCase = useMemo(() => {
    const map = new Map<string, string>()
    for (const script of state.scripts) {
      if (script.caseId) map.set(script.caseId, script.id)
    }
    return map
  }, [state.scripts])

  // A jump from Chat opens the editor directly; without the effect the tab would
  // switch and then require a second click to reach the case that was asked for.
  useEffect(() => {
    if (!focusCaseId) return
    const found = state.cases.find((entry) => entry.id === focusCaseId)
    if (found) setEditing(found)
    onFocusHandled()
  }, [focusCaseId, onFocusHandled, state.cases])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const sorted = [...state.cases].sort((a, b) => b.updatedAt - a.updatedAt)
    if (!needle) return sorted
    return sorted.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(needle)) ||
        (entry.startUrl ?? '').toLowerCase().includes(needle),
    )
  }, [filter, state.cases])

  const sitesConfigured = state.settings.policy.allowedSites.length > 0

  return (
    <div className='stack'>
      {!sitesConfigured ? (
        <Notice kind='warn' title='站点白名单（allowed sites）为空'>
          任何运行都会被立即拒绝。
          <Button small onClick={onOpenSettings}>
            去设置白名单
          </Button>
        </Notice>
      ) : null}

      <div className='row'>
        <input
          type='text'
          placeholder='按名称、标签或 URL 过滤'
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Button
          small
          onClick={() =>
            setEditing({
              id: '',
              name: '',
              tags: [],
              source: 'manual',
              steps: [''],
              expectations: [''],
              createdAt: 0,
              updatedAt: 0,
            })
          }
        >
          新建
        </Button>
      </div>

      {state.cases.length === 0 ? (
        <Empty
          title='还没有测试用例'
          hint='在「对话」标签页粘贴一段自然语言或 Markdown，或在这里手动新建一个用例。'
        />
      ) : visible.length === 0 ? (
        <Empty title='没有匹配的用例' hint='试试更短的关键词。' />
      ) : null}

      {visible.map((testCase) => (
        <CaseRow
          key={testCase.id}
          testCase={testCase}
          scriptId={scriptByCase.get(testCase.id)}
          worker={worker}
          onEdit={() => setEditing(testCase)}
          onMarkdown={() => setMarkdownFor(testCase)}
          onOpenRun={onOpenRun}
        />
      ))}

      {editing ? (
        <CaseEditor
          testCase={editing}
          onClose={() => setEditing(null)}
          onSave={async (next) => {
            await call({ type: 'saveCase', testCase: next })
            setEditing(null)
          }}
        />
      ) : null}

      {markdownFor ? (
        <MarkdownView testCase={markdownFor} onClose={() => setMarkdownFor(null)} />
      ) : null}
    </div>
  )
}

function CaseRow({
  testCase,
  scriptId,
  worker,
  onEdit,
  onMarkdown,
  onOpenRun,
}: {
  testCase: TestCase
  scriptId: string | undefined
  worker: WorkerApi
  onEdit: () => void
  onMarkdown: () => void
  onOpenRun: (runId: string) => void
}) {
  const { call } = worker
  const toast = useToast()
  const agent = usePending()
  const replay = usePending()
  const [alsoDeleteScript, setAlsoDeleteScript] = useState(false)

  const start = async (useAgent: boolean): Promise<void> => {
    const response = await call({ type: 'runCase', caseId: testCase.id, useAgent })
    if (is.run(response)) {
      onOpenRun(response.run.id)
      return
    }
    toast.info(is.message(response) ? response.message : '运行已启动。')
  }

  return (
    <div className='card'>
      <div className='row'>
        <span className='card__title'>{testCase.name}</span>
        <Badge tone='neutral' title={`来源：${SOURCE_LABEL[testCase.source]}`}>
          {SOURCE_LABEL[testCase.source]}
        </Badge>
      </div>

      {testCase.startUrl ? (
        <Truncated text={testCase.startUrl} className='faint small' mono />
      ) : (
        <span className='faint small'>没有起始 URL（start URL）</span>
      )}

      <span className='faint small'>
        {testCase.steps.length} 个步骤 · {testCase.expectations.length} 条预期
        {scriptId ? ' · 已有脚本' : ''}
      </span>

      {testCase.tags.length > 0 ? (
        <div className='checks' style={{ marginTop: 4 }}>
          {testCase.tags.map((tag) => (
            <span className='tag' key={tag} title={tag}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      <div className='row row--wrap' style={{ marginTop: 6 }}>
        <Button
          variant='primary'
          small
          pending={agent.pending}
          onClick={() => void agent.run(() => start(true))}
        >
          运行
        </Button>
        {scriptId ? (
          <Button
            small
            pending={replay.pending}
            onClick={() => void replay.run(() => start(false))}
            title='回放已录制的脚本，不调用模型'
          >
            回放脚本
          </Button>
        ) : null}
        <Button small onClick={onEdit}>
          编辑
        </Button>
        <Button variant='ghost' small onClick={onMarkdown}>
          Markdown
        </Button>
      </div>

      <ConfirmAction
        label='删除'
        question={`删除测试用例「${testCase.name}」？已完成的运行记录会保留（其中的用例名称是快照），此操作不可撤销。`}
        onArmedChange={(armed) => {
          if (!armed) setAlsoDeleteScript(false)
        }}
        extra={
          scriptId ? (
            <Toggle
              label='同时删除脚本'
              hint='不勾选时，录制的脚本（script）会保留下来，可以在「脚本」标签页单独回放。'
              checked={alsoDeleteScript}
              onChange={setAlsoDeleteScript}
            />
          ) : undefined
        }
        onConfirm={async () => {
          await call({
            type: 'deleteCase',
            caseId: testCase.id,
            withScripts: alsoDeleteScript,
          })
        }}
      />
    </div>
  )
}

/**
 * Case editor.
 *
 * Steps and expectations are edited as separate lists, mirroring the domain: a
 * step failing is an execution problem, an expectation failing is a test failure,
 * and one merged textarea would let the user blur that line — which is exactly
 * the distinction that makes a report worth reading.
 */
function CaseEditor({
  testCase,
  onClose,
  onSave,
}: {
  testCase: TestCase
  onClose: () => void
  onSave: (next: TestCase) => Promise<void>
}) {
  const [name, setName] = useState(testCase.name)
  const [startUrl, setStartUrl] = useState(testCase.startUrl ?? '')
  const [tags, setTags] = useState(testCase.tags.join(', '))
  const [description, setDescription] = useState(testCase.description ?? '')
  const [steps, setSteps] = useState<string[]>(
    testCase.steps.length > 0 ? testCase.steps : [''],
  )
  const [expectations, setExpectations] = useState<string[]>(
    testCase.expectations.length > 0 ? testCase.expectations : [''],
  )
  const { pending, run } = usePending()

  const trimmedSteps = steps.map((step) => step.trim()).filter((step) => step.length > 0)
  const trimmedExpectations = expectations
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  const nameError = name.trim().length === 0 ? '用例需要一个名称。' : undefined
  const urlError =
    startUrl.trim().length > 0 && !/^https?:\/\//i.test(startUrl.trim())
      ? '起始 URL 必须以 http:// 或 https:// 开头。'
      : undefined
  const emptyError =
    trimmedSteps.length === 0 && trimmedExpectations.length === 0
      ? '至少需要一个步骤或一条预期，否则没有可执行的内容。'
      : undefined
  const invalid = Boolean(nameError ?? urlError ?? emptyError)

  const save = (): void => {
    void run(async () => {
      const now = Date.now()
      const next: TestCase = {
        ...testCase,
        // An empty id means this is a new case; the worker's `saveCase` assigns
        // one, so the panel does not invent ids the worker would have to trust.
        id: testCase.id || `case_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        name: name.trim(),
        tags: tags
          .split(/[,，;；\s]+/)
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0),
        steps: trimmedSteps,
        expectations: trimmedExpectations,
        createdAt: testCase.createdAt || now,
        updatedAt: now,
      }
      if (startUrl.trim()) next.startUrl = startUrl.trim()
      else delete next.startUrl
      if (description.trim()) next.description = description.trim()
      else delete next.description
      await onSave(next)
    })
  }

  return (
    <Modal
      title={testCase.id ? '编辑测试用例' : '新建测试用例'}
      onClose={onClose}
      footer={
        <>
          <Button variant='primary' pending={pending} disabled={invalid} onClick={save}>
            保存
          </Button>
          <Button onClick={onClose}>取消</Button>
        </>
      }
    >
      <div className='stack'>
        <Field label='名称' error={nameError}>
          <input type='text' value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <Field
          label='起始 URL（start URL）'
          hint='运行会先打开这个地址。留空时，智能体会尝试从步骤文字里找到它。'
          error={urlError}
        >
          <input
            type='url'
            value={startUrl}
            placeholder='https://staging.example.com/login'
            onChange={(event) => setStartUrl(event.target.value)}
          />
        </Field>

        <Field label='标签（tags）' hint='用逗号或空格分隔，例如 登录, 冒烟'>
          <input type='text' value={tags} onChange={(event) => setTags(event.target.value)} />
        </Field>

        <Field label='说明（可选）' hint='背景信息，会一并交给模型作为上下文。'>
          <textarea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <LineListEditor
          title='步骤（steps）'
          hint='自然语言，按顺序执行。一步一行，例如「点击登录按钮」。'
          lines={steps}
          onChange={setSteps}
          placeholder='点击「登录」按钮'
        />

        <LineListEditor
          title='预期（expectations）'
          hint='只有全部满足才算通过（passed）。不满足会记为 failed，也就是被测应用的问题。'
          lines={expectations}
          onChange={setExpectations}
          placeholder='页面出现「欢迎回来」'
          error={emptyError}
        />

        <span className='faint small'>
          需要用到密码时，不要直接写在这里：在「设置 → 密钥（secrets）」里存好，然后在步骤里按名称引用，
          真实值只会在后台被替换。
        </span>
      </div>
    </Modal>
  )
}

/** A reorderable list of one-line text entries. */
function LineListEditor({
  title,
  hint,
  lines,
  onChange,
  placeholder,
  error,
}: {
  title: string
  hint: string
  lines: string[]
  onChange: (next: string[]) => void
  placeholder: string
  error?: string
}) {
  return (
    <div className='field'>
      <span className='field__label'>{title}</span>
      <span className='field__hint'>{hint}</span>
      <div className='list'>
        {lines.map((line, index) => (
          // The index is the identity here: entries are positional and may be
          // duplicated, so the text cannot serve as a key.
          <div className='row' key={`line-${index}`}>
            <span className='faint mono' style={{ flex: 'none', width: 16, textAlign: 'right' }}>
              {index + 1}
            </span>
            <textarea
              rows={1}
              value={line}
              placeholder={placeholder}
              onChange={(event) => onChange(lines.with(index, event.target.value))}
            />
            <Button
              variant='ghost'
              small
              aria-label={`上移第 ${index + 1} 行`}
              disabled={index === 0}
              onClick={() => {
                const previous = lines[index - 1]
                const current = lines[index]
                if (previous === undefined || current === undefined) return
                onChange(lines.with(index - 1, current).with(index, previous))
              }}
            >
              ↑
            </Button>
            <Button
              variant='ghost'
              small
              aria-label={`删除第 ${index + 1} 行`}
              onClick={() => onChange(lines.filter((_, at) => at !== index))}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>
      <Button small onClick={() => onChange([...lines, ''])}>
        添加一行
      </Button>
      {error ? <span className='field__error'>{error}</span> : null}
    </div>
  )
}

/** Read-only Markdown rendering of a case, for copying or saving to a file. */
function MarkdownView({ testCase, onClose }: { testCase: TestCase; onClose: () => void }) {
  const markdown = renderCaseMarkdown(testCase)
  return (
    <Modal
      title='Markdown 视图'
      onClose={onClose}
      footer={
        <>
          <CopyButton text={markdown} label='复制 Markdown' small={false} />
          <Button
            onClick={() => downloadText(safeFileName(testCase.name, 'md'), markdown, 'text/markdown')}
          >
            下载 .md
          </Button>
          <Button variant='ghost' onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      <div className='stack'>
        <span className='faint small'>
          这段 Markdown 可以原样粘回「对话」标签页重新导入：解析与渲染是可逆的（round-trip）。
        </span>
        <pre className='pre'>{markdown}</pre>
      </div>
    </Modal>
  )
}
