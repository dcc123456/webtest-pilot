/**
 * Runs: the evidence.
 *
 * The one thing this tab must not do is flatten `failed` into `error`. The
 * backend keeps them apart because they point at different people:
 *
 * - **failed** — the application under test did not meet an expectation. A real
 *   finding. Red. Someone should look at the product.
 * - **error** — this harness could not complete the attempt (no allow-listed
 *   site, model unreachable, tab gone). Orange. Someone should look at the
 *   *setup*; there may well be no bug at all.
 *
 * Screenshots are loaded lazily, per expanded run: a full-window PNG is hundreds
 * of kilobytes as a data URL, and eagerly hydrating two hundred runs' worth would
 * make the panel unusable to save a click.
 *
 * @module panel/RunsTab
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactMeta } from '../lib/artifacts'
import { is } from '../lib/messages'
import { formatDuration } from '../lib/time'
import { isTerminalStatus, type RunTrigger, type StepRecord, type TestRun } from '../lib/types'
import {
  Badge,
  Button,
  Collapsible,
  ConfirmAction,
  Empty,
  Modal,
  Notice,
  StatusBadge,
  fullTime,
  shortTime,
  usePending,
  useToast,
} from './components'
import type { WorkerApi } from './useWorker'

const TRIGGER_LABEL: Record<RunTrigger, string> = {
  manual: '手动',
  chat: '对话',
  schedule: '定时任务',
  bridge: '本地接口（bridge）',
  replay: '脚本回放',
}

/** Wall-clock duration; an unfinished run is measured to its last heartbeat. */
function runDuration(run: TestRun): number {
  return (run.finishedAt ?? run.heartbeatAt) - run.startedAt
}

export function RunsTab({
  worker,
  focusRunId,
  onFocusHandled,
  onOpenSettings,
}: {
  worker: WorkerApi
  focusRunId: string | null
  onFocusHandled: () => void
  onOpenSettings: () => void
}) {
  const { state, call } = worker
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [zoomed, setZoomed] = useState<{ dataUrl: string; label: string } | null>(null)

  // Runs arrive newest-first from storage, but sorting here keeps the tab correct
  // even if an event-driven refresh interleaves.
  const runs = useMemo(() => [...state.runs].sort((a, b) => b.startedAt - a.startedAt), [state.runs])

  // A jump from Chat or Cases should land with the run already open, otherwise
  // the user has to hunt for the row they just started.
  useEffect(() => {
    if (!focusRunId) return
    setExpanded((current) => ({ ...current, [focusRunId]: true }))
    onFocusHandled()
  }, [focusRunId, onFocusHandled])

  const errorCount = runs.filter((run) => run.status === 'error').length
  const sitesConfigured = state.settings.policy.allowedSites.length > 0

  return (
    <div className='stack'>
      {runs.length > 0 ? (
        <div className='row'>
          <span className='dim small'>{runs.length} 条运行记录</span>
          <span className='spacer' />
          <ConfirmAction
            label='清空全部'
            question={`删除全部 ${runs.length} 条运行记录及其截图（artifacts）？这会清空审计痕迹，无法撤销。`}
            confirmLabel='确认清空'
            onConfirm={async () => {
              await call({ type: 'clearRuns' })
            }}
          />
        </div>
      ) : null}

      {errorCount > 0 && !sitesConfigured ? (
        <Notice kind='warn' title={`有 ${errorCount} 条运行是「执行出错（error）」`}>
          出错（error）说明本工具没能完成尝试，而不是被测应用有问题。站点白名单（allowed sites）
          目前为空，这是最常见的原因。
          <Button small onClick={onOpenSettings}>
            去设置白名单
          </Button>
        </Notice>
      ) : null}

      {runs.length === 0 ? (
        <Empty
          title='还没有运行记录'
          hint='在「对话」或「用例」标签页启动一次运行，这里会按时间倒序记录每一步、失败原因和截图。'
        />
      ) : null}

      {runs.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          active={state.activeRunIds.includes(run.id)}
          open={expanded[run.id] === true}
          onToggle={(next) => setExpanded((current) => ({ ...current, [run.id]: next }))}
          worker={worker}
          onZoom={setZoomed}
        />
      ))}

      {zoomed ? (
        <Modal title={zoomed.label} onClose={() => setZoomed(null)}>
          <div className='stack'>
            <img className='shot__full' src={zoomed.dataUrl} alt={zoomed.label} />
          </div>
        </Modal>
      ) : null}
    </div>
  )
}

function RunRow({
  run,
  active,
  open,
  onToggle,
  worker,
  onZoom,
}: {
  run: TestRun
  active: boolean
  open: boolean
  onToggle: (next: boolean) => void
  worker: WorkerApi
  onZoom: (value: { dataUrl: string; label: string }) => void
}) {
  const { call } = worker
  const toast = useToast()
  const cancel = usePending()

  const okCount = run.steps.filter((step) => step.ok).length
  const badCount = run.steps.length - okCount

  return (
    <div className='card'>
      <div className='row row--wrap'>
        <StatusBadge status={run.status} />
        <span className='spacer' />
        <span className='faint small' title={fullTime(run.startedAt)}>
          {shortTime(run.startedAt)}
        </span>
      </div>

      <span className='card__title' title={run.caseName}>
        {run.caseName}
      </span>

      <span className='faint small'>
        {TRIGGER_LABEL[run.trigger]} · {run.mode === 'agent' ? '智能体（agent）' : '脚本回放（replay）'}{' '}
        · {formatDuration(runDuration(run))} · 步骤 {okCount} 成功
        {badCount > 0 ? ` / ${badCount} 失败` : ''}
      </span>

      {run.usage ? (
        <span className='faint small'>
          token：输入 {run.usage.promptTokens ?? '—'} · 输出 {run.usage.completionTokens ?? '—'}
        </span>
      ) : null}

      {/* The failure message is promoted out of the step list: for a failing run
          it is the single thing the reader came for, and making them expand a row
          to find it is the difference between a useful report and a log dump. */}
      {run.failure ? (
        <div className={run.status === 'error' ? 'notice notice--warn' : 'notice notice--error'}>
          <span className='notice__title'>
            {run.status === 'error'
              ? `执行出错，停在第 ${run.failure.stepIndex + 1} 步`
              : `未达预期，第 ${run.failure.stepIndex + 1} 步`}
          </span>
          <span className='wrap-any'>{run.failure.message}</span>
          {run.status === 'error' ? (
            <span className='faint small'>
              这是本工具没能完成尝试，而不是被测应用的缺陷 —— 请先检查站点白名单、模型配置和标签页状态。
            </span>
          ) : null}
        </div>
      ) : null}

      {run.summary ? <span className='dim small wrap-any'>{run.summary}</span> : null}

      <div className='row row--wrap' style={{ marginTop: 6 }}>
        {active && !isTerminalStatus(run.status) ? (
          <Button
            variant='danger'
            small
            pending={cancel.pending}
            onClick={() =>
              void cancel.run(async () => {
                const response = await call({ type: 'cancelRun', runId: run.id })
                toast.info(is.message(response) ? response.message : '已请求取消。')
              })
            }
          >
            取消
          </Button>
        ) : null}
        <span className='spacer' />
        <ConfirmAction
          label='删除'
          question={`删除这条运行记录及其截图？「${run.caseName}」的其他运行不受影响。`}
          onConfirm={async () => {
            await call({ type: 'deleteRun', runId: run.id })
          }}
        />
      </div>

      <Collapsible
        open={open}
        onToggle={onToggle}
        summary={
          <span className='dim small'>
            {open ? '收起步骤与截图' : `展开步骤与截图（${run.steps.length} 步）`}
          </span>
        }
      >
        {run.steps.length === 0 ? (
          <span className='faint small'>还没有记录到步骤。</span>
        ) : (
          run.steps.map((step, index) => (
            <StepLine key={`${run.id}-${step.index}-${index}`} step={step} />
          ))
        )}

        {run.extracted && Object.keys(run.extracted).length > 0 ? (
          <div style={{ marginTop: 6 }}>
            <span className='field__label'>提取到的值（extracted）</span>
            <pre className='pre'>{JSON.stringify(run.extracted, null, 2)}</pre>
          </div>
        ) : null}

        {open ? <RunArtifacts runId={run.id} worker={worker} onZoom={onZoom} /> : null}
      </Collapsible>
    </div>
  )
}

function StepLine({ step }: { step: StepRecord }) {
  return (
    <div className='step'>
      <span className='step__index'>{step.index + 1}</span>
      <span className={step.ok ? 'step__mark step__mark--ok' : 'step__mark step__mark--bad'}>
        {step.ok ? '✓' : '✕'}
      </span>
      <span className='step__main'>
        <span className='step__desc'>{step.description}</span>
        <span className='faint small'>
          {formatDuration(step.durationMs)}
          {step.attempts !== undefined && step.attempts > 1 ? ` · 重试 ${step.attempts} 次` : ''}
        </span>
        {step.usedFallback ? (
          <Badge
            tone='warn'
            title={`主选择器（selector）已失效，实际命中的是备用选择器：${step.usedSpec ?? '未知'}`}
          >
            使用了备用选择器
          </Badge>
        ) : null}
        {step.assertion ? (
          <span className={step.assertion.passed ? 'faint small' : 'step__error'}>
            断言（assert）：期望「{step.assertion.expected}」，实际「{step.assertion.actual}」
          </span>
        ) : null}
        {step.error ? <span className='step__error'>{step.error}</span> : null}
      </span>
    </div>
  )
}

/**
 * Screenshot thumbnails for one run.
 *
 * Two hops on purpose: `getRunArtifacts` returns metadata only, and each image is
 * fetched by id with `getArtifact`. That is what keeps the list itself cheap — the
 * data URLs never enter `PanelState`, so refreshing state during a live run does
 * not re-transfer megabytes of PNG.
 */
function RunArtifacts({
  runId,
  worker,
  onZoom,
}: {
  runId: string
  worker: WorkerApi
  onZoom: (value: { dataUrl: string; label: string }) => void
}) {
  const { call } = worker
  const [metas, setMetas] = useState<ArtifactMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [images, setImages] = useState<Record<string, string>>({})
  /** Ids already requested, so a re-render never refetches an image. */
  const requested = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    setMetas(null)
    setError(null)
    call({ type: 'getRunArtifacts', runId })
      .then((response) => {
        if (cancelled) return
        if (is.artifacts(response)) setMetas(response.artifacts)
        else setError('后台没有返回截图列表。')
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [call, runId])

  const load = useCallback(
    (artifactId: string) => {
      if (requested.current.has(artifactId)) return
      requested.current.add(artifactId)
      call({ type: 'getArtifact', artifactId })
        .then((response) => {
          if (is.dataUrl(response)) {
            setImages((current) => ({ ...current, [artifactId]: response.dataUrl }))
          }
        })
        .catch((cause: unknown) => {
          // A pruned artifact is expected — the store enforces a byte budget — so
          // it is reported in place rather than as a toast for every thumbnail.
          setError(cause instanceof Error ? cause.message : String(cause))
        })
    },
    [call],
  )

  // Thumbnails are hydrated as soon as the list is known: the user already opted
  // in by expanding the run, and a second click per image would be pure friction.
  useEffect(() => {
    if (!metas) return
    for (const meta of metas) load(meta.id)
  }, [load, metas])

  if (error !== null && metas === null) {
    return <span className='field__error'>{error}</span>
  }
  if (metas === null) return <span className='faint small'>正在读取截图…</span>
  if (metas.length === 0) {
    return (
      <span className='faint small'>
        这次运行没有截图。可以在「设置 → 运行策略」里开启「每步都截图」。
      </span>
    )
  }

  return (
    <div style={{ marginTop: 6 }}>
      <span className='field__label'>截图（{metas.length}）</span>
      {error !== null ? <span className='field__error'>{error}</span> : null}
      <div className='shots'>
        {metas.map((meta) => {
          const dataUrl = images[meta.id]
          const label = `第 ${meta.stepIndex + 1} 步`
          return (
            <div className='shot' key={meta.id}>
              {dataUrl ? (
                <img
                  src={dataUrl}
                  alt={label}
                  title={`${label} · ${meta.width}×${meta.height} · 点击放大`}
                  onClick={() => onZoom({ dataUrl, label })}
                />
              ) : (
                <span className='shot__meta'>加载中…</span>
              )}
              <span className='shot__meta'>{label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
