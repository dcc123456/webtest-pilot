import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GRACE_MS, describeNextRun, selectDue } from '../src/background/scheduler'
import type { ScheduleEntry } from '../src/lib/types'

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    id: 'sch-1',
    name: 'Nightly smoke',
    caseId: 'case-1',
    preferScript: true,
    schedule: { kind: 'interval', everyMinutes: 60 },
    enabled: true,
    notify: 'failure',
    createdAt: 0,
    ...overrides,
  }
}

const NOW = new Date('2025-03-10T10:00:00Z').getTime()

beforeEach(() => {
  vi.useRealTimers()
})

describe('selectDue', () => {
  it('returns a schedule whose time has arrived', () => {
    const due = selectDue([entry({ nextRunAt: NOW - 1000 })], NOW)
    expect(due).toHaveLength(1)
    expect(due[0]?.missed).toBe(false)
  })

  it('ignores a schedule that is not due yet', () => {
    expect(selectDue([entry({ nextRunAt: NOW + 60_000 })], NOW)).toEqual([])
  })

  it('ignores a disabled schedule even when its time passed', () => {
    expect(selectDue([entry({ enabled: false, nextRunAt: NOW - 60_000 })], NOW)).toEqual([])
  })

  it('ignores a schedule with no computed next time, which was just enabled', () => {
    // Firing immediately here would mean enabling a schedule triggers a run at
    // once, which is not what "run nightly at 3am" means.
    expect(selectDue([entry({ nextRunAt: undefined })], NOW)).toEqual([])
  })

  it('marks a window missed beyond the grace period', () => {
    const due = selectDue([entry({ nextRunAt: NOW - GRACE_MS - 1000 })], NOW)
    expect(due[0]?.missed).toBe(true)
  })

  it('does not mark a window missed inside the grace period', () => {
    const due = selectDue([entry({ nextRunAt: NOW - GRACE_MS + 1000 })], NOW)
    expect(due[0]?.missed).toBe(false)
  })

  it('honours a custom grace period', () => {
    const due = selectDue([entry({ nextRunAt: NOW - 5000 })], NOW, 1000)
    expect(due[0]?.missed).toBe(true)
  })

  it('returns a backlog earliest-first, so it is worked in order', () => {
    const due = selectDue(
      [
        entry({ id: 'later', nextRunAt: NOW - 1000 }),
        entry({ id: 'earlier', nextRunAt: NOW - 60_000 }),
        entry({ id: 'middle', nextRunAt: NOW - 30_000 }),
      ],
      NOW,
    )
    expect(due.map((item) => item.entry.id)).toEqual(['earlier', 'middle', 'later'])
  })

  it('handles a schedule due at exactly this instant', () => {
    expect(selectDue([entry({ nextRunAt: NOW })], NOW)).toHaveLength(1)
  })

  it('returns nothing for an empty list', () => {
    expect(selectDue([], NOW)).toEqual([])
  })

  it('reports the time the run was supposed to happen, not now', () => {
    const dueAt = NOW - 45_000
    expect(selectDue([entry({ nextRunAt: dueAt })], NOW)[0]?.dueAt).toBe(dueAt)
  })
})

describe('describeNextRun', () => {
  it('says a disabled schedule is disabled', () => {
    expect(describeNextRun(entry({ enabled: false }), NOW)).toBe('已停用')
  })

  it('says it is waiting when no next time is computed', () => {
    expect(describeNextRun(entry({ nextRunAt: undefined }), NOW)).toContain('等待计算')
  })

  it('says imminent when the time has passed', () => {
    expect(describeNextRun(entry({ nextRunAt: NOW - 1000 }), NOW)).toBe('即将执行')
  })

  it('counts minutes under an hour', () => {
    expect(describeNextRun(entry({ nextRunAt: NOW + 25 * 60_000 }), NOW)).toBe('25 分钟后执行')
  })

  it('counts hours and minutes under a day', () => {
    expect(describeNextRun(entry({ nextRunAt: NOW + (3 * 60 + 20) * 60_000 }), NOW)).toBe(
      '3 小时 20 分钟后执行',
    )
  })

  it('gives an absolute time beyond a day, since a relative one stops being useful', () => {
    const described = describeNextRun(entry({ nextRunAt: NOW + 3 * 86_400_000 }), NOW)
    expect(described).toContain('3 天后执行')
    expect(described).toContain('（')
  })
})
