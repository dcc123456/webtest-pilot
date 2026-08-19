/**
 * Schedule arithmetic and duration formatting. Pure functions.
 *
 * @module lib/time
 */

import type { Schedule } from './types'

/** Chrome silently clamps alarm periods below this in packed extensions. */
export const MIN_INTERVAL_MINUTES = 1

/** Parses `"HH:mm"`; returns null when malformed or out of range. */
export function parseHhMm(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

/**
 * Next firing time strictly after `from`, in epoch ms; null when the schedule
 * can never fire (a malformed time).
 *
 * `interval` is relative to `from`. `daily` walks forward day by day until it
 * finds an allowed weekday, so it handles both the "later today" and the
 * "already past, roll to tomorrow" cases, and empty `days` means every day.
 * Walking real `Date` objects rather than adding 24h keeps it correct across DST
 * transitions, where a day is 23 or 25 hours long.
 */
export function nextRunAt(schedule: Schedule, from: number): number | null {
  if (schedule.kind === 'interval') {
    const minutes = Math.max(MIN_INTERVAL_MINUTES, Math.floor(schedule.everyMinutes))
    if (!Number.isFinite(minutes)) return null
    return from + minutes * 60_000
  }

  const hhmm = parseHhMm(schedule.time)
  if (!hhmm) return null

  const allowed = normalizeDays(schedule.days)
  // Probe today plus the next 7 days; that always covers any non-empty subset.
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(hhmm.hour, hhmm.minute, 0, 0)
    const at = candidate.getTime()
    if (at <= from) continue
    if (allowed.length > 0 && !allowed.includes(candidate.getDay())) continue
    return at
  }
  return null
}

/** Keeps only valid weekday numbers, deduped and sorted. */
export function normalizeDays(days: number[]): number[] {
  const seen = new Set<number>()
  for (const day of days) {
    if (Number.isInteger(day) && day >= 0 && day <= 6) seen.add(day)
  }
  return [...seen].sort((a, b) => a - b)
}

/**
 * True when a scheduled slot passed while the browser was closed and is now too
 * stale to run.
 *
 * Missed runs are deliberately dropped rather than replayed: waking to a burst
 * of backlogged test runs — each opening a window and calling a paid API — is
 * worse than skipping one.
 */
export function isMissedBeyondGrace(scheduledFor: number, now: number, graceMs = 60_000): boolean {
  return now - scheduledFor > graceMs
}

/** Renders an epoch ms as a short local string, or `'—'` when absent. */
export function formatTime(at: number | undefined): string {
  if (!at) return '—'
  return new Date(at).toLocaleString()
}

/** Compact duration, e.g. `1.2s`, `2m 05s`. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/** Human-readable schedule summary. */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === 'interval') {
    const minutes = Math.max(MIN_INTERVAL_MINUTES, Math.floor(schedule.everyMinutes))
    return `every ${minutes} min`
  }
  const days = normalizeDays(schedule.days)
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const when = days.length === 0 ? 'daily' : days.map((day) => names[day]).join(',')
  return `${schedule.time} ${when}`
}
