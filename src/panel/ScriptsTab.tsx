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
import type { TestScript } from '../lib/types'
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

type ExportFormat = 'json' | 'playwright' | 'markdown'

const FORMAT_META: Record<
  ExportFormat,
  { label: string; extension: string; mime: string; hint: string }
> = {
  json: {
    label: 'JSON',
    extension: 'json',
    mime: 'application/json',
    hint: '本插件自己的格式，可以通过本地接口（bridge）或数据导入重新载入。',
  },
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
  const [sharing, setSharing] = useState<TestScript[] | null>(null)
  const importRun = usePending()
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

  /** Reads a picked bundle file. Shared by the empty state and the toolbar. */
  const importBundle = (text: string) =>
    void importRun.run(async () => {
      const response = await call({ type: 'importScriptBundle', json: text })
      // A rejected bundle carries the reason — a bad file must not be reported as
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
      onText={importBundle}
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
            likely to be loading a colleague's scripts. */}
        <div className='row'>{importButton}</div>
        <span className='faint small'>
          也可以导入别人分享的脚本文件（.json）。导入的脚本一律作为新脚本加入，不会覆盖你已有的脚本。
        </span>
      </div>
    )
  }

  return (
    <div className='stack'>
      <div className='row'>
        {importButton}
        <Button small onClick={() => setSharing(scripts)}>
          导出全部（{scripts.length}）
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
          onShare={() => setSharing([script])}
          onOpenRun={onOpenRun}
        />
      ))}

      {exporting ? (
        <ExportView
          script={exporting.script}
          format={exporting.format}
          call={call}
          onClose={() => setExporting(null)}
        />
      ) : null}

      {sharing ? (
        <ShareView scripts={sharing} call={call} onClose={() => setSharing(null)} />
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
  onShare,
  onOpenRun,
}: {
  script: TestScript
  caseName: string | undefined
  open: boolean
  onToggle: (next: boolean) => void
  worker: WorkerApi
  onExport: (format: ExportFormat) => void
  onShare: () => void
  onOpenRun: (runId: string) => void
}) {
  const { call } = worker
  const toast = useToast()
  const replay = usePending()

  const optionalCount = script.steps.filter((step) => step.optional === true).length
  const secretCount = script.steps.filter((step) => step.secretRef !== undefined).length
  const proposedCount = script.steps.filter((step) => step.proposedFix !== undefined).length

  return (
    <div className='card'>
      <div className='row'>
        <span className='card__title'>{script.name}</span>
        <Badge tone='neutral' title={`共 ${script.steps.length} 个步骤`}>
          {script.steps.length} 步
        </Badge>
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
        <Button small onClick={onShare}>
          分享…
        </Button>
        <Button small onClick={() => onExport('json')}>
          导出 JSON
        </Button>
        <Button small onClick={() => onExport('playwright')}>
          导出 Playwright
        </Button>
        <Button small onClick={() => onExport('markdown')}>
          导出 Markdown
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
          <div className='step' key={`${script.id}-${index}`}>
            <span className='step__index'>{index + 1}</span>
            <span className='step__main'>
              <span className='step__desc'>{describeStep(step)}</span>
              {step.optional ? <span className='faint small'> （可选）</span> : null}
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

/**
 * Builds a shareable bundle and shows what it will and will not contain.
 *
 * The disclosure is not decoration: a user about to paste this into a group chat
 * needs to know, before they send it, that credentials are not in the file. Saying
 * so at the moment of sharing is worth more than a line in the README.
 */
function ShareView({
  scripts,
  call,
  onClose,
}: {
  scripts: TestScript[]
  call: WorkerApi['call']
  onClose: () => void
}) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setText(null)
    setError(null)
    call({ type: 'exportScriptBundle', scriptIds: scripts.map((script) => script.id) })
      .then((response) => {
        if (cancelled) return
        if (is.text(response)) setText(response.text)
        else setError(response.ok ? '后台没有返回导出内容。' : response.error)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
    // Depending on the id list rather than the array identity: a new array with
    // the same ids must not refetch.
  }, [call, scripts.map((script) => script.id).join(',')])

  const secretNames = useMemo(() => {
    const names = new Set<string>()
    for (const script of scripts) {
      for (const step of script.steps) {
        if (step.secretRef) names.add(step.secretRef)
      }
    }
    return [...names].sort()
  }, [scripts])

  const fileName =
    scripts.length === 1 && scripts[0]
      ? safeFileName(scripts[0].name, 'wtp.json')
      : `webtest-pilot-scripts-${scripts.length}.wtp.json`

  return (
    <Modal
      title={scripts.length === 1 ? '分享脚本' : `分享 ${scripts.length} 个脚本`}
      onClose={onClose}
      footer={
        <>
          {text !== null ? <CopyButton text={text} label='复制' small={false} /> : null}
          {text !== null ? (
            <Button variant='primary' onClick={() => downloadText(fileName, text, 'application/json')}>
              下载文件
            </Button>
          ) : null}
          <Button variant='ghost' onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      <div className='stack'>
        <span className='faint small'>
          把这个文件发给同事，对方在「脚本」页点「导入脚本…」即可使用。会一并带上脚本关联的测试用例，
          这样对方能看到这个脚本本来要验证什么。
        </span>
        <Truncated text={fileName} className='faint small' mono />

        <div className='stack' style={{ gap: 2 }}>
          <span className='dim small'>不会包含：API Key、密钥的真实值、bridge 令牌、运行历史、定时任务。</span>
          {secretNames.length > 0 ? (
            <span className='dim small'>
              需要对方自行配置的密钥（只带名字，不带值）：<code>{secretNames.join('、')}</code>
            </span>
          ) : null}
        </div>

        {error !== null ? <span className='field__error'>{error}</span> : null}
        {text === null && error === null ? <span className='dim small'>正在生成…</span> : null}
        {text !== null ? <pre className='pre'>{text}</pre> : null}
      </div>
    </Modal>
  )
}
