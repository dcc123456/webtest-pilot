/**
 * Local desktop notifications for unattended runs.
 *
 * The side panel shows everything while it is open, but the runs that most need
 * attention are the ones nobody is watching: a 3am schedule or a CI-triggered
 * run. Feishu covers the team; this covers the person at the machine, and works
 * when no webhook is configured at all.
 *
 * Deliberately quiet: only unattended runs, and only outcomes that need a human.
 * A notification per passing run would train the user to dismiss them all.
 *
 * @module background/notify
 */

import { formatDuration } from '../lib/time'
import type { TestRun } from '../lib/types'

/** Icon-less notifications are rejected by Chrome, so this points at the action icon. */
const ICON = 'icons/icon-128.png'

/**
 * Whether a run deserves a desktop notification.
 *
 * Manual runs never qualify: the user is right there, looking at the panel that
 * already shows the result.
 */
export function shouldNotifyLocally(run: TestRun): boolean {
  if (run.trigger === 'manual') return false
  // `cancelled` was a deliberate human act, so it is not news.
  return run.status === 'failed' || run.status === 'error' || run.status === 'interrupted'
}

/** Title and body for a run, phrased so the status is clear from the title alone. */
export function describeRunForNotification(run: TestRun): { title: string; message: string } {
  const duration = run.finishedAt ? formatDuration(run.finishedAt - run.startedAt) : '未知时长'
  const trigger = run.trigger === 'schedule' ? '定时任务' : '本地接口'

  if (run.status === 'failed') {
    return {
      // "测试失败" means the application under test did not meet the expectation:
      // a real finding, and the wording must not blur into a tooling problem.
      title: `测试失败：${run.caseName}`,
      message: `${trigger} · ${duration}\n${run.failure?.message ?? run.summary ?? '未通过预期检查。'}`,
    }
  }
  if (run.status === 'interrupted') {
    return {
      title: `测试被中断：${run.caseName}`,
      message: `${trigger} · 后台在运行结束前被回收，本次结果不可信，建议重跑。`,
    }
  }
  return {
    // `error` is a tooling or configuration problem. Saying "未能执行" rather than
    // "失败" keeps the user from hunting for a bug in their application.
    title: `测试未能执行：${run.caseName}`,
    message: `${trigger} · ${duration}\n${run.failure?.message ?? run.summary ?? '工具未能完成本次运行。'}`,
  }
}

/**
 * Shows a notification for a run, if it warrants one.
 *
 * Never throws: notifications are a convenience, and a permission or platform
 * problem must not turn a completed run into a failed one.
 */
export async function notifyRunLocally(run: TestRun): Promise<void> {
  if (!shouldNotifyLocally(run)) return
  const { title, message } = describeRunForNotification(run)
  try {
    await chrome.notifications.create(`wtp-${run.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL(ICON),
      title,
      message,
      // Failures stay on screen until dismissed: the whole point is that nobody
      // was watching when it happened.
      requireInteraction: run.status === 'failed',
    })
  } catch {
    /* notifications are optional; a failure here is not worth surfacing */
  }
}
