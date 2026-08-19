/**
 * Schedules: runs with nobody watching.
 *
 * The empty-allow-list warning at the top of this tab is the most load-bearing
 * thing in the file. An unattended trigger refuses to start when
 * `policy.allowedSites` is empty — deliberately, because an unsupervised model
 * driving arbitrary pages is exactly what that boundary exists to prevent — and
 * the symptom is a nightly suite that silently never runs. Stating it here, next
 * to the schedules it would break, is what turns the single most likely support
 * question into something the user answers themselves.
 *
 * `nextRunAt` is never computed in this tab. The worker recomputes it on save, so
 * a panel-side guess could only ever disagree with the alarm that actually fires.
 *
 * @module panel/SchedulesTab
 */

import { useMemo, useState } from 'react'
import { describeNextRun } from '../background/scheduler'
import { describeSchedule, parseHhMm } from '../lib/time'
import type { NotifyPolicy, Schedule, ScheduleEntry, TestCase } from '../lib/types'
import {
  Badge,
  Button,
  ConfirmAction,
  Empty,
  Field,
  Modal,
  Notice,
  StatusBadge,
  Toggle,
  Truncated,
  fullTime,
  shortTime,
  usePending,
} from './components'
import type { WorkerApi } from './useWorker'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const NOTIFY_LABEL: Record<NotifyPolicy, string> = {
  always: '每次都通知',
  failure: '仅失败时通知',
  never: '不通知',
}

export function SchedulesTab({
  worker,
  onOpenSettings,
  onOpenRun,
}: {
  worker: WorkerApi
  onOpenSettings: () => void
  onOpenRun: (runId: string) => void
}) {
  const { state, call } = worker
  const [editing, setEditing] = useState<ScheduleEntry | null>(null)

  const caseNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const testCase of state.cases) map.set(testCase.id, testCase.name)
    return map
  }, [state.cases])

  const schedules = useMemo(
    () => [...state.schedules].sort((a, b) => a.createdAt - b.createdAt),
    [state.schedules],
  )

  const sitesEmpty = state.settings.policy.allowedSites.length === 0
  const enabledCount = schedules.filter((entry) => entry.enabled).length
  const feishuConfigured = state.settings.feishu.webhookUrl.trim().length > 0

  return (
    <div className='stack'>
      {/* Shown even when no schedule exists yet: a user about to create their
          first one needs this before they wait a night to discover it. */}
      {sitesEmpty ? (
        <Notice kind='warn' title='站点白名单（allowed sites）为空，定时任务不会执行'>
          无人值守的触发方式（定时任务、本地接口）在白名单为空时会直接拒绝启动 ——
          这是本插件唯一的安全边界，不会给出默认的「允许所有站点」。
          {enabledCount > 0 ? `当前有 ${enabledCount} 个已启用的定时任务，它们都会被跳过。` : ''}
          <Button small onClick={onOpenSettings}>
            前往「设置 → 站点白名单」
          </Button>
        </Notice>
      ) : null}

      <div className='row'>
        <span className='dim small'>
          {schedules.length} 个定时任务，{enabledCount} 个已启用
        </span>
        <span className='spacer' />
        <Button
          small
          disabled={state.cases.length === 0}
          title={state.cases.length === 0 ? '需要先有一个测试用例' : undefined}
          onClick={() =>
            setEditing({
              id: '',
              name: '',
              caseId: state.cases[0]?.id ?? '',
              preferScript: true,
              schedule: { kind: 'daily', time: '03:00', days: [] },
              enabled: false,
              notify: 'failure',
              createdAt: 0,
            })
          }
        >
          新建
        </Button>
      </div>

      {schedules.length === 0 ? (
        <Empty
          title='还没有定时任务'
          hint={
            state.cases.length === 0
              ? '先在「对话」标签页创建一个测试用例，然后回来给它设定执行时间。'
              : '定时任务会在无人值守时启动一次运行。默认优先回放已录制的脚本，这样既确定又不消耗 token。'
          }
        />
      ) : null}

      {schedules.map((entry) => (
        <ScheduleRow
          key={entry.id}
          entry={entry}
          caseName={caseNames.get(entry.caseId)}
          feishuConfigured={feishuConfigured}
          worker={worker}
          onEdit={() => setEditing(entry)}
          onOpenRun={onOpenRun}
        />
      ))}

      {editing ? (
        <ScheduleEditor
          entry={editing}
          cases={state.cases}
          onClose={() => setEditing(null)}
          onSave={async (next) => {
            await call({ type: 'saveSchedule', entry: next })
            setEditing(null)
          }}
        />
      ) : null}
    </div>
  )
}

function ScheduleRow({
  entry,
  caseName,
  feishuConfigured,
  worker,
  onEdit,
  onOpenRun,
}: {
  entry: ScheduleEntry
  caseName: string | undefined
  feishuConfigured: boolean
  worker: WorkerApi
  onEdit: () => void
  onOpenRun: (runId: string) => void
}) {
  const { call } = worker
  const toggle = usePending()
  // Extracted so the click handler closes over a `string` rather than
  // `string | undefined`; a narrowing done inside JSX does not reach the callback.
  const lastRunId = entry.lastRunId

  return (
    <div className='card'>
      <div className='row'>
        <span className='card__title'>{entry.name}</span>
        {entry.enabled ? <Badge tone='ok'>已启用</Badge> : <Badge tone='neutral'>已停用</Badge>}
      </div>

      <span className='faint small'>
        {caseName ? `用例：${caseName}` : '关联的用例已被删除，这个任务不会执行'}
      </span>
      <Truncated
        text={`${describeSchedule(entry.schedule)} · ${describeNextRun(entry)}`}
        className='dim small'
      />
      <span className='faint small'>
        {entry.preferScript ? '优先回放脚本（prefer script）' : '总是用智能体（agent）'} ·{' '}
        {NOTIFY_LABEL[entry.notify]}
        {entry.notify !== 'never' && !feishuConfigured ? '（飞书未配置，通知不会发出）' : ''}
      </span>

      {entry.lastStatus ? (
        <div className='row row--wrap' style={{ marginTop: 4 }}>
          <span className='faint small'>上次结果</span>
          <StatusBadge status={entry.lastStatus} />
          <span className='faint small' title={fullTime(entry.lastRunAt)}>
            {shortTime(entry.lastRunAt)}
          </span>
          {lastRunId !== undefined ? (
            <Button variant='ghost' small onClick={() => onOpenRun(lastRunId)}>
              查看
            </Button>
          ) : null}
        </div>
      ) : (
        <span className='faint small'>还没有执行过。</span>
      )}

      <div className='row row--wrap' style={{ marginTop: 6 }}>
        <Button
          small
          pending={toggle.pending}
          disabled={caseName === undefined}
          onClick={() =>
            void toggle.run(async () => {
              await call({
                type: 'toggleSchedule',
                scheduleId: entry.id,
                enabled: !entry.enabled,
              })
            })
          }
        >
          {entry.enabled ? '停用' : '启用'}
        </Button>
        <Button small onClick={onEdit}>
          编辑
        </Button>
      </div>

      <ConfirmAction
        label='删除'
        question={`删除定时任务「${entry.name}」？测试用例和历史运行记录都会保留，只是不再自动执行。`}
        onConfirm={async () => {
          await call({ type: 'deleteSchedule', scheduleId: entry.id })
        }}
      />
    </div>
  )
}

function ScheduleEditor({
  entry,
  cases,
  onClose,
  onSave,
}: {
  entry: ScheduleEntry
  cases: TestCase[]
  onClose: () => void
  onSave: (next: ScheduleEntry) => Promise<void>
}) {
  const [name, setName] = useState(entry.name)
  const [caseId, setCaseId] = useState(entry.caseId)
  const [kind, setKind] = useState<Schedule['kind']>(entry.schedule.kind)
  const [everyMinutes, setEveryMinutes] = useState(
    entry.schedule.kind === 'interval' ? String(entry.schedule.everyMinutes) : '60',
  )
  const [time, setTime] = useState(entry.schedule.kind === 'daily' ? entry.schedule.time : '03:00')
  const [days, setDays] = useState<number[]>(
    entry.schedule.kind === 'daily' ? entry.schedule.days : [],
  )
  const [notify, setNotify] = useState<NotifyPolicy>(entry.notify)
  const [preferScript, setPreferScript] = useState(entry.preferScript)
  const [enabled, setEnabled] = useState(entry.enabled)
  const { pending, run } = usePending()

  const minutes = Number(everyMinutes)
  const intervalError =
    kind === 'interval' && (!Number.isInteger(minutes) || minutes < 1)
      ? '间隔必须是不小于 1 的整数分钟（Chrome 对闹钟周期的下限就是 1 分钟）。'
      : undefined
  const timeError =
    kind === 'daily' && parseHhMm(time) === null ? '时间格式应为 HH:mm，例如 03:00。' : undefined
  const nameError = name.trim().length === 0 ? '定时任务需要一个名称。' : undefined
  const caseError = caseId.length === 0 ? '请选择要执行的测试用例。' : undefined
  const invalid = Boolean(nameError ?? caseError ?? intervalError ?? timeError)

  const buildSchedule = (): Schedule =>
    kind === 'interval'
      ? { kind: 'interval', everyMinutes: minutes }
      : { kind: 'daily', time: time.trim(), days }

  return (
    <Modal
      title={entry.id ? '编辑定时任务' : '新建定时任务'}
      onClose={onClose}
      footer={
        <>
          <Button
            variant='primary'
            pending={pending}
            disabled={invalid}
            onClick={() =>
              void run(async () => {
                const now = Date.now()
                const next: ScheduleEntry = {
                  ...entry,
                  id: entry.id || `sch_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
                  name: name.trim(),
                  caseId,
                  preferScript,
                  schedule: buildSchedule(),
                  enabled,
                  notify,
                  createdAt: entry.createdAt || now,
                }
                // `nextRunAt` is intentionally dropped: the worker recomputes it
                // on save, and a value guessed here could only ever disagree with
                // the alarm that actually fires.
                delete next.nextRunAt
                await onSave(next)
              })
            }
          >
            保存
          </Button>
          <Button onClick={onClose}>取消</Button>
        </>
      }
    >
      <div className='stack'>
        <Field label='名称' error={nameError}>
          <input
            type='text'
            value={name}
            placeholder='每晚登录冒烟'
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label='执行哪个用例' error={caseError}>
          <select value={caseId} onChange={(event) => setCaseId(event.target.value)}>
            <option value=''>请选择…</option>
            {cases.map((testCase) => (
              <option key={testCase.id} value={testCase.id}>
                {testCase.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label='频率'>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value === 'interval' ? 'interval' : 'daily')}
          >
            <option value='daily'>每天固定时间</option>
            <option value='interval'>按间隔重复</option>
          </select>
        </Field>

        {kind === 'interval' ? (
          <Field label='间隔（分钟）' hint='相对上一次执行时间计算。' error={intervalError}>
            <input
              type='number'
              min={1}
              value={everyMinutes}
              onChange={(event) => setEveryMinutes(event.target.value)}
            />
          </Field>
        ) : (
          <>
            <Field label='时间（本地时区）' error={timeError}>
              <input type='time' value={time} onChange={(event) => setTime(event.target.value)} />
            </Field>
            <div className='field'>
              <span className='field__label'>星期</span>
              <span className='field__hint'>全部不勾选表示每天执行。</span>
              <div className='checks'>
                {WEEKDAYS.map((label, day) => {
                  const on = days.includes(day)
                  return (
                    <label className='check-chip' data-on={on} key={label}>
                      <input
                        type='checkbox'
                        checked={on}
                        onChange={() =>
                          setDays((current) =>
                            on
                              ? current.filter((value) => value !== day)
                              : [...current, day].sort((a, b) => a - b),
                          )
                        }
                      />
                      {label}
                    </label>
                  )
                })}
              </div>
            </div>
          </>
        )}

        <Field label='通知策略（notify policy）'>
          <select
            value={notify}
            onChange={(event) => {
              const value = event.target.value
              setNotify(value === 'always' || value === 'never' ? value : 'failure')
            }}
          >
            <option value='failure'>仅失败时通知（推荐）</option>
            <option value='always'>每次都通知</option>
            <option value='never'>不通知</option>
          </select>
        </Field>

        <Toggle
          label='优先回放脚本（prefer script）'
          hint='用例已有录制脚本时直接回放：结果确定，也不消耗模型 token；没有脚本时自动退回智能体。'
          checked={preferScript}
          onChange={setPreferScript}
        />

        <Toggle
          label='保存后立即启用'
          hint='停用状态下任务会保留配置但不会触发。'
          checked={enabled}
          onChange={setEnabled}
        />

        <span className='faint small'>
          错过的执行窗口不会补跑：设备休眠一夜后一次性补上十几次运行（每次都开窗口、调用付费接口）比跳过更糟。
        </span>
      </div>
    </Modal>
  )
}
