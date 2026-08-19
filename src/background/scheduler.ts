/**
 * Scheduled runs, on `chrome.alarms`.
 *
 * `chrome.alarms` is the only timer that survives MV3 worker eviction — a
 * `setTimeout` in a service worker dies with the worker, so a nightly test set
 * with `setInterval` would silently stop running the first time Chrome reclaimed
 * memory. That constraint dictates the whole design here:
 *
 * - **One repeating alarm, not one per schedule.** Chrome enforces a one-minute
 *   floor and a limited alarm budget; a single tick that consults storage scales
 *   to any number of schedules and needs no cleanup when one is deleted.
 * - **`nextRunAt` lives in storage.** The alarm carries no state, so a schedule's
 *   next fire time must be durable, or a worker restart would re-fire it or skip
 *   it depending on timing.
 * - **A missed window is reported, not silently swallowed.** A laptop asleep
 *   through the 3am slot is the normal case, and a team that believes a test ran
 *   when it did not is worse off than one that knows it was missed.
 *
 * @module background/scheduler
 */

import { isMissedBeyondGrace, nextRunAt } from '../lib/time'
import {
  appendLog,
  getCase,
  getSchedule,
  getSchedules,
  getSettings,
  patchSchedule,
} from '../lib/storage'
import type { ScheduleEntry, TestRun } from '../lib/types'

/** Name of the single repeating alarm. */
export const TICK_ALARM = 'wtp.tick'

/**
 * How often the tick fires.
 *
 * One minute is Chrome's floor for a released extension, and it is also the
 * finest granularity a schedule expresses, so a shorter period would cost wakeups
 * without improving accuracy.
 */
const TICK_PERIOD_MINUTES = 1

/**
 * How late a run may start and still be worth starting.
 *
 * Ten minutes: long enough to cover a laptop waking up or the worker being slow
 * to start, short enough that a 3am suite does not suddenly run at 9am while
 * someone is using the machine.
 */
export const GRACE_MS = 10 * 60 * 1000

/** Installs the repeating alarm. Idempotent, so it is safe on every startup. */
export async function installScheduler(): Promise<void> {
  const existing = await chrome.alarms.get(TICK_ALARM)
  if (existing) return
  await chrome.alarms.create(TICK_ALARM, {
    periodInMinutes: TICK_PERIOD_MINUTES,
    // Deliberately not `when: Date.now()`: firing immediately on install would
    // start a run before the user has finished configuring anything.
    delayInMinutes: TICK_PERIOD_MINUTES,
  })
}

/** Removes the alarm. Used when every schedule is disabled. */
export async function uninstallScheduler(): Promise<void> {
  await chrome.alarms.clear(TICK_ALARM)
}

/** Recomputes and stores `nextRunAt` for one schedule. */
export async function refreshNextRun(entry: ScheduleEntry, now = Date.now()): Promise<number | undefined> {
  if (!entry.enabled) {
    await patchSchedule(entry.id, { nextRunAt: undefined })
    return undefined
  }
  // `nextRunAt` returns null for a daily schedule with no selected weekdays,
  // which is a schedule that can never fire; storing undefined makes the UI say
  // so rather than showing a bogus time.
  const next = nextRunAt(entry.schedule, now) ?? undefined
  await patchSchedule(entry.id, { nextRunAt: next })
  return next
}

/** Recomputes every schedule's next fire time, and installs or removes the alarm. */
export async function resyncSchedules(now = Date.now()): Promise<void> {
  const entries = await getSchedules()
  for (const entry of entries) await refreshNextRun(entry, now)
  if (entries.some((entry) => entry.enabled)) await installScheduler()
  else await uninstallScheduler()
}

/** A schedule the tick decided to act on. */
export interface DueSchedule {
  entry: ScheduleEntry
  /** When it was supposed to run. */
  dueAt: number
  /** True when the window was missed by more than the grace period. */
  missed: boolean
}

/**
 * Decides which schedules are due.
 *
 * Pure, given the entries and the clock, so the awkward cases — a missed window,
 * a schedule enabled with no `nextRunAt` yet, two schedules due in the same tick
 * — are unit-testable without alarms or storage.
 */
export function selectDue(entries: ScheduleEntry[], now: number, graceMs = GRACE_MS): DueSchedule[] {
  const due: DueSchedule[] = []
  for (const entry of entries) {
    if (!entry.enabled) continue
    const dueAt = entry.nextRunAt
    // A schedule with no computed next time has just been enabled; the resync
    // that follows will set it, and skipping it here avoids firing immediately.
    if (typeof dueAt !== 'number') continue
    if (dueAt > now) continue
    due.push({ entry, dueAt, missed: isMissedBeyondGrace(dueAt, now, graceMs) })
  }
  // Earliest first, so a backlog is worked through in the order it accumulated.
  return due.sort((a, b) => a.dueAt - b.dueAt)
}

/** What the tick needs from the rest of the extension. */
export interface TickDeps {
  /** Starts a run and resolves when it finishes. */
  startRun: (entry: ScheduleEntry) => Promise<TestRun | undefined>
  now?: () => number
}

/**
 * Handles one alarm tick.
 *
 * Runs due schedules **serially**. Two browser automation runs at once would
 * fight over window focus and `captureVisibleTab`, and the failures would look
 * like flaky tests rather than a scheduling problem.
 */
export async function onTick(deps: TickDeps): Promise<{ started: number; skipped: number }> {
  const now = deps.now?.() ?? Date.now()
  const settings = await getSettings()
  const entries = await getSchedules()
  const due = selectDue(entries, now)

  let started = 0
  let skipped = 0

  for (const { entry, dueAt, missed } of due) {
    // Re-read: a long previous run in this same tick may have changed things,
    // and acting on a stale copy could re-run a schedule the user just disabled.
    const fresh = await getSchedule(entry.id)
    if (!fresh || !fresh.enabled) {
      skipped += 1
      continue
    }

    if (missed) {
      // Reported rather than run: starting a 3am suite at 10am would be
      // surprising, and believing it ran on time would be worse.
      await appendLog({
        level: 'warn',
        source: 'scheduler',
        message: `定时任务「${fresh.name}」错过了 ${new Date(dueAt).toLocaleString()} 的执行窗口（超过 ${Math.round(
          GRACE_MS / 60000,
        )} 分钟宽限期，通常是电脑处于睡眠状态），本次跳过。`,
      })
      await refreshNextRun(fresh, now)
      skipped += 1
      continue
    }

    // The allow-list check also happens in the driver, but failing here gives a
    // log line naming the schedule, which is what the user will actually see.
    if (settings.policy.allowedSites.length === 0) {
      await appendLog({
        level: 'error',
        source: 'scheduler',
        message: `定时任务「${fresh.name}」未执行：尚未配置站点白名单（allowed sites）。请在设置中添加后重试。`,
      })
      await refreshNextRun(fresh, now)
      skipped += 1
      continue
    }

    const testCase = await getCase(fresh.caseId)
    if (!testCase) {
      // The case was deleted but the schedule was not. Disabling is the honest
      // response: leaving it enabled would log an error every single night.
      await patchSchedule(fresh.id, { enabled: false, nextRunAt: undefined })
      await appendLog({
        level: 'error',
        source: 'scheduler',
        message: `定时任务「${fresh.name}」已自动停用：它引用的测试用例已被删除。`,
      })
      skipped += 1
      continue
    }

    // Advance the schedule *before* running. A run can take minutes and the
    // worker may be evicted during it; if the next time were written afterwards,
    // a crash would leave `nextRunAt` in the past and the run would repeat on
    // every tick.
    await refreshNextRun(fresh, now + 1000)

    try {
      const run = await deps.startRun(fresh)
      await patchSchedule(fresh.id, {
        lastRunAt: now,
        ...(run ? { lastRunId: run.id, lastStatus: run.status } : {}),
      })
      started += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await appendLog({
        level: 'error',
        source: 'scheduler',
        message: `定时任务「${fresh.name}」启动失败：${message}`,
      })
      await patchSchedule(fresh.id, { lastRunAt: now, lastStatus: 'error' })
      skipped += 1
    }
  }

  return { started, skipped }
}

/**
 * Describes a schedule's state for the UI.
 *
 * Centralised so the panel, the log, and a notification all phrase "next run" the
 * same way; three separate formatters would drift.
 */
export function describeNextRun(entry: ScheduleEntry, now = Date.now()): string {
  if (!entry.enabled) return '已停用'
  if (typeof entry.nextRunAt !== 'number') return '等待计算下次执行时间'
  const delta = entry.nextRunAt - now
  if (delta <= 0) return '即将执行'
  const minutes = Math.round(delta / 60000)
  if (minutes < 60) return `${minutes} 分钟后执行`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟后执行`
  return `${Math.floor(hours / 24)} 天后执行（${new Date(entry.nextRunAt).toLocaleString()}）`
}
