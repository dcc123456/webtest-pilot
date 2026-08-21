/**
 * Scripts: the library of *mechanism*.
 *
 * A script is what a passing agent run leaves behind — a deterministic step list
 * that replays with no model and no token cost. So this tab's job is mostly to
 * make one legible and to get it out of the browser:
 *
 * - Steps are rendered with `describeStep`, the same formatter the run log, the
 *   exported comments, and the Feishu card use, so a step reads identically
 *   wherever it is seen.
 * - Export is a handover artefact. Playwright TS is the important one: a QA
 *   engineer can drop it into an existing suite and run it in CI without this
 *   extension. Each format is offered both as copy-to-clipboard and as a file,
 *   because "paste into a PR" and "add to a repo" are different errands.
 *
 * @module panel/ScriptsTab
 */

import { useEffect, useMemo, useState } from 'react'
import { is } from '../lib/messages'
import { describeStep, describeValue } from '../lib/script'
import type { ScriptStep, TestScript } from '../lib/types'
import {
  Badge,
  Button,
  Collapsible,
  ConfirmAction,
  CopyButton,
  Empty,
  Modal,
  Truncated,
  FilePickButton,
  downloadText,
  fullTime,
  safeFileName,
  shortTime,
  usePending,
  useToast,
} from './components'
import type { WorkerApi } from './useWorker'

/**
 * Formats that get a preview before download.
 *
 * The extension's own JSON is not among them: it now downloads directly, because
 * a user asking for the script file wants the file, not a wall of JSON to read.
 * These two are code and prose meant to be looked at before being taken away.
 */
type ExportFormat = 'playwright' | 'markdown'

const FORMAT_META: Record<
  ExportFormat,
  { label: string; extension: string; mime: string; hint: string }
> = {
  playwright: {
    label: 'Playwright TS',
    extension: 'spec.ts',
    mime: 'text/typescript',
    hint: '可直接放进现有 Playwright 套件在 CI 里跑；密钥（secrets）会导出成环境变量读取，不会写入明文。',
  },
  markdown: {
    label: 'Markdown',
    extension: 'md',
    mime: 'text/markdown',
    hint: '给人看的步骤清单，方便评审录制结果是否符合本意。',
  },
}

export function ScriptsTab({
  worker,
  onOpenRun,
}: {
  worker: WorkerApi
  onOpenRun: (runId: string) => void
}) {
  const { state, call } = worker
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [exporting, setExporting] = useState<{ script: TestScript; format: ExportFormat } | null>(
    null,
  )
  const [editing, setEditing] = useState<TestScript | null>(null)
  const importRun = usePending()
  const downloadRun = usePending()
  const toast = useToast()

  const caseNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const testCase of state.cases) map.set(testCase.id, testCase.name)
    return map
  }, [state.cases])

  const scripts = useMemo(
    () => [...state.scripts].sort((a, b) => b.updatedAt - a.updatedAt),
    [state.scripts],
  )

  /**
   * Downloads scripts as a file, with no preview step.
   *
   * The file is built in the worker (one implementation of the format) but lands
   * straight in the download folder: what the user wants is the file, and sending
   * it onward is a job for whatever tool they already use.
   */
  const downloadScripts = (chosen: TestScript[], fileName: string) =>
    void downloadRun.run(async () => {
      const response = await call({
        type: 'exportScriptBundle',
        scriptIds: chosen.map((script) => script.id),
      })
      if (!response.ok) {
        toast.error(response.error)
        return
      }
      if (!is.text(response)) {
        toast.error('后台没有返回脚本内容。')
        return
      }
      downloadText(fileName, response.text, 'application/json')
      toast.success(`已下载 ${fileName}`)
    })

  /** Reads a picked script file. Shared by the empty state and the toolbar. */
  const importScripts = (text: string) =>
    void importRun.run(async () => {
      const response = await call({ type: 'importScriptBundle', json: text })
      // A rejected file carries the reason — a bad file must not be reported as
      // a success just because the message channel worked.
      if (!response.ok) {
        toast.error(response.error)
        return
      }
      toast.success(is.message(response) ? response.message : '导入完成。')
    })

  const importButton = (
    <FilePickButton
      accept='application/json,.json'
      label='导入脚本…'
      pending={importRun.pending}
      onText={importScripts}
      onError={(message) => toast.error(`读取文件失败：${message}`)}
    />
  )

  if (scripts.length === 0) {
    return (
      <div className='stack'>
        <Empty
          title='还没有录制脚本'
          hint='当智能体（agent）运行通过后，会自动把它录制成可回放的脚本（需要在「设置 → 运行策略」里开启「自动保存脚本」）。回放脚本不调用模型，结果确定。'
        />
        {/* Import belongs here too: an empty list is exactly when someone is most
            likely to be loading scripts they were sent. */}
        <div className='row'>{importButton}</div>
        <span className='faint small'>
          可以导入下载过的脚本文件（.json）。导入的脚本一律作为新脚本加入，不会覆盖你已有的脚本。
        </span>
      </div>
    )
  }

  return (
    <div className='stack'>
      <div className='row'>
        {importButton}
        <Button
          small
          pending={downloadRun.pending}
          onClick={() =>
            downloadScripts(scripts, `webtest-pilot-scripts-${scripts.length}.json`)
          }
        >
          下载全部（{scripts.length}）
        </Button>
      </div>

      {scripts.map((script) => (
        <ScriptRow
          key={script.id}
          script={script}
          caseName={script.caseId ? caseNames.get(script.caseId) : undefined}
          open={expanded[script.id] === true}
          onToggle={(next) => setExpanded((current) => ({ ...current, [script.id]: next }))}
          worker={worker}
          onExport={(format) => setExporting({ script, format })}
          onDownload={() => downloadScripts([script], safeFileName(script.name, 'json'))}
          onOpenRun={onOpenRun}
          onEdit={() => setEditing(script)}
        />
      ))}

      {editing ? (
        <ScriptEditor
          script={editing}
          worker={worker}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setEditing(null)
            toast.success(`已保存「${updated.name}」`)
          }}
        />
      ) : null}

      {exporting ? (
        <ExportView
          script={exporting.script}
          format={exporting.format}
          call={call}
          onClose={() => setExporting(null)}
        />
      ) : null}
    </div>
  )
}

function ScriptRow({
  script,
  caseName,
  open,
  onToggle,
  worker,
  onExport,
  onDownload,
  onOpenRun,
  onEdit,
}: {
  script: TestScript
  caseName: string | undefined
  open: boolean
  onToggle: (next: boolean) => void
  worker: WorkerApi
  onExport: (format: ExportFormat) => void
  onDownload: () => void
  onOpenRun: (runId: string) => void
  onEdit: () => void
}) {
  const { call } = worker
  const toast = useToast()
  const replay = usePending()

  const optionalCount = script.steps.filter((step) => step.optional === true).length
  const secretCount = script.steps.filter((step) => step.secretRef !== undefined).length
  const proposedCount = script.steps.filter((step) => step.proposedFix !== undefined).length
  const disabledCount = script.steps.filter((step) => step.disabled === true).length

  return (
    <div className='card'>
      <div className='row'>
        <span className='card__title'>{script.name}</span>
        <Badge tone='neutral' title={`共 ${script.steps.length} 个步骤`}>
          {script.steps.length} 步
        </Badge>
        {disabledCount > 0 ? (
          <Badge tone='neutral' title='回放时会跳过这些被禁用的步骤'>
            {disabledCount} 已禁用
          </Badge>
        ) : null}
      </div>

      <span className='faint small' title={caseName ?? '这个脚本没有关联的测试用例'}>
        {caseName ? `属于用例：${caseName}` : '未关联用例（用例可能已被删除）'}
      </span>
      {script.startUrl ? <Truncated text={script.startUrl} className='faint small' mono /> : null}
      <span className='faint small' title={fullTime(script.updatedAt)}>
        更新于 {shortTime(script.updatedAt)}
      </span>

      {(optionalCount > 0 || secretCount > 0 || proposedCount > 0) ? (
        <div className='row row--wrap' style={{ marginTop: 4 }}>
          {optionalCount > 0 ? (
            <Badge tone='neutral' title='可选步骤失败不会导致整个运行失败'>
              {optionalCount} 个可选步骤
            </Badge>
          ) : null}
          {secretCount > 0 ? (
            <Badge tone='info' title='这些步骤按名称引用密钥，真实值只在后台替换'>
              {secretCount} 处引用密钥
            </Badge>
          ) : null}
          {proposedCount > 0 ? (
            <Badge
              tone='warn'
              title='自愈（self-heal）提出了新的选择器建议，但不会自动生效，需要人工确认'
            >
              {proposedCount} 条待确认的选择器建议
            </Badge>
          ) : null}
        </div>
      ) : null}

      <div className='row row--wrap' style={{ marginTop: 6 }}>
        <Button
          variant='primary'
          small
          pending={replay.pending}
          onClick={() =>
            void replay.run(async () => {
              const response = await call({ type: 'runScript', scriptId: script.id })
              if (is.run(response)) {
                onOpenRun(response.run.id)
                return
              }
              toast.info(is.message(response) ? response.message : '回放已启动。')
            })
          }
        >
          回放
        </Button>
        <Button small onClick={onDownload}>
          下载脚本
        </Button>
        <Button small onClick={() => onExport('playwright')}>
          导出 Playwright
        </Button>
        <Button small onClick={() => onExport('markdown')}>
          导出 Markdown
        </Button>
        <Button small onClick={onEdit}>
          编辑步骤
        </Button>
      </div>

      <Collapsible
        open={open}
        onToggle={onToggle}
        summary={<span className='dim small'>{open ? '收起步骤' : '展开步骤'}</span>}
      >
        {script.steps.map((step, index) => (
          // Steps are positional and two identical steps are legitimate, so the
          // index is the only stable identity.
          <div
            className={`step${step.disabled ? ' step--disabled' : ''}`}
            key={`${script.id}-${index}`}
          >
            <span className='step__index'>{index + 1}</span>
            <span className='step__main'>
              <span className='step__desc'>{describeStep(step)}</span>
              {step.optional ? <span className='faint small'> （可选）</span> : null}
              {step.disabled ? <span className='faint small'> （已禁用，回放时跳过）</span> : null}
              {step.secretRef ? (
                <span className='faint small' title='真实值保存在后台，不会出现在脚本或导出文件里'>
                  {' '}
                  值来自密钥 {describeValue(step)}
                </span>
              ) : null}
              {step.note ? <span className='faint small'>备注：{step.note}</span> : null}
            </span>
          </div>
        ))}
      </Collapsible>

      <ConfirmAction
        label='删除脚本'
        question={`删除脚本「${script.name}」？关联的测试用例（test case）会保留，但会失去可回放的脚本，需要重新用智能体跑一次才能再录制。`}
        onConfirm={async () => {
          await call({ type: 'deleteScript', scriptId: script.id })
        }}
      />
    </div>
  )
}

/**
 * Edits a saved script's step list: enable/disable individual steps and remove
 * steps, without re-recording.
 *
 * The draft is a local copy until "保存" writes it back through `saveScript`,
 * which restamps `updatedAt`. Disabled steps are kept (not deleted) so they can
 * be turned back on later; the runner records them as skipped.
 */
function ScriptEditor({
  script,
  worker,
  onClose,
  onSaved,
}: {
  script: TestScript
  worker: WorkerApi
  onClose: () => void
  onSaved: (updated: TestScript) => void
}) {
  const { call } = worker
  const toast = useToast()
  const saving = usePending()
  const [steps, setSteps] = useState<ScriptStep[]>(() =>
    script.steps.map((step) => ({ ...step })),
  )
  const [name, setName] = useState(script.name)

  const enabledCount = steps.filter((step) => !step.disabled).length

  const toggle = (index: number): void => {
    setSteps((current) =>
      current.map((step, i) =>
        i === index ? { ...step, disabled: step.disabled ? undefined : true } : step,
      ),
    )
  }

  const remove = (index: number): void => {
    setSteps((current) => current.filter((_, i) => i !== index))
  }

  const move = (index: number, direction: -1 | 1): void => {
    setSteps((current) => {
      const target = index + direction
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      const [item] = next.splice(index, 1)
      if (!item) return current
      next.splice(target, 0, item)
      return next
    })
  }

  const save = (): void => {
    if (steps.length === 0) {
      toast.error('至少保留一个步骤；要清空请直接删除整个脚本。')
      return
    }
    if (!name.trim()) {
      toast.error('请填写脚本名称。')
      return
    }
    void saving.run(async () => {
      const updated: TestScript = { ...script, name: name.trim(), steps }
      const response = await call({ type: 'saveScript', script: updated })
      if (is.script(response)) onSaved(response.script)
      else toast.error(is.message(response) ? response.message : '保存失败。')
    })
  }

  return (
    <Modal
      title={`编辑步骤：${script.name}`}
      onClose={onClose}
      footer={
        <>
          <span className='dim small'>
            已启用 {enabledCount} / {steps.length} 步
          </span>
          <span className='spacer' />
          <Button variant='ghost' small onClick={onClose}>
            取消
          </Button>
          <Button variant='primary' small pending={saving.pending} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className='scriptedit'>
        <label className='saveform__field'>
          <span className='small dim'>脚本名称</span>
          <input
            type='text'
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </label>
        <div className='scriptedit__hint small dim'>
          取消勾选即禁用该步骤（保留在脚本里，回放时跳过并记为 skipped）；也可以上移/下移调整顺序，或直接删除。
        </div>
        <div className='scriptedit__list'>
          {steps.map((step, index) => (
            <div
              className={`scriptedit__step${step.disabled ? ' scriptedit__step--off' : ''}`}
              key={index}
            >
              <label className='scriptedit__enable' title={step.disabled ? '启用以回放' : '禁用（回放时跳过）'}>
                <input
                  type='checkbox'
                  checked={!step.disabled}
                  onChange={() => toggle(index)}
                />
              </label>
              <span className='chat__step-index small dim'>{index + 1}</span>
              <span className='scriptedit__desc small'>{describeStep(step)}</span>
              <span className='scriptedit__actions'>
                <button
                  type='button'
                  className='linklike small'
                  title='上移'
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type='button'
                  className='linklike small'
                  title='下移'
                  disabled={index === steps.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type='button'
                  className='linklike linklike--danger small'
                  title='删除该步骤'
                  onClick={() => remove(index)}
                >
                  删除
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/**
 * Fetches and shows one export, with copy and download.
 *
 * The conversion happens in the worker (`exportScript`), not here: the exporters
 * live next to the script model and there must be exactly one implementation, or
 * a Playwright file copied from the panel could differ from one fetched over the
 * bridge.
 */
function ExportView({
  script,
  format,
  call,
  onClose,
}: {
  script: TestScript
  format: ExportFormat
  call: WorkerApi['call']
  onClose: () => void
}) {
  const meta = FORMAT_META[format]
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // `cancelled` rather than an AbortController: `sendToWorker` has no abort
    // channel, so the reply is discarded on unmount instead of prevented.
    let cancelled = false
    setText(null)
    setError(null)
    call({ type: 'exportScript', scriptId: script.id, format })
      .then((response) => {
        if (cancelled) return
        if (is.text(response)) setText(response.text)
        else setError('后台没有返回导出内容。')
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [call, format, script.id])

  const fileName = safeFileName(script.name, meta.extension)

  return (
    <Modal
      title={`导出：${meta.label}`}
      onClose={onClose}
      footer={
        <>
          {text !== null ? <CopyButton text={text} label='复制' small={false} /> : null}
          {text !== null ? (
            <Button onClick={() => downloadText(fileName, text, meta.mime)}>下载文件</Button>
          ) : null}
          <Button variant='ghost' onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      <div className='stack'>
        <span className='faint small'>{meta.hint}</span>
        <Truncated text={fileName} className='faint small' mono />
        {error !== null ? <span className='field__error'>{error}</span> : null}
        {text === null && error === null ? <span className='dim small'>正在生成…</span> : null}
        {text !== null ? <pre className='pre'>{text}</pre> : null}
      </div>
    </Modal>
  )
}
