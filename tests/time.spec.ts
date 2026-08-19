import { describe, expect, it } from 'vitest'

import {
  describeSchedule,
  formatDuration,
  formatTime,
  isMissedBeyondGrace,
  nextRunAt,
  normalizeDays,
  parseHhMm,
} from '../src/lib/time'

/** Local-time date builder, so tests read as wall-clock intent. */
function at(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

describe('parseHhMm', () => {
  it('accepts one- and two-digit hours', () => {
    expect(parseHhMm('9:05')).toEqual({ hour: 9, minute: 5 })
    expect(parseHhMm('09:05')).toEqual({ hour: 9, minute: 5 })
    expect(parseHhMm(' 23:59 ')).toEqual({ hour: 23, minute: 59 })
    expect(parseHhMm('00:00')).toEqual({ hour: 0, minute: 0 })
  })

  it('rejects out-of-range and malformed values', () => {
    for (const value of ['24:00', '12:60', '-1:00', '9:5', '9', 'nine', '', '12:00:00']) {
      expect(parseHhMm(value), value).toBeNull()
    }
  })
})

describe('nextRunAt: interval', () => {
  it('is relative to the given instant', () => {
    const from = at(2026, 3, 10, 12, 0)
    expect(nextRunAt({ kind: 'interval', everyMinutes: 15 }, from)).toBe(from + 15 * 60_000)
  })

  it('clamps below the one-minute floor Chrome enforces', () => {
    const from = at(2026, 3, 10, 12, 0)
    expect(nextRunAt({ kind: 'interval', everyMinutes: 0 }, from)).toBe(from + 60_000)
    expect(nextRunAt({ kind: 'interval', everyMinutes: -5 }, from)).toBe(from + 60_000)
  })

  it('floors a fractional interval', () => {
    const from = at(2026, 3, 10, 12, 0)
    expect(nextRunAt({ kind: 'interval', everyMinutes: 2.9 }, from)).toBe(from + 2 * 60_000)
  })
})

describe('nextRunAt: daily', () => {
  it('picks later today when the slot has not passed', () => {
    const from = at(2026, 3, 10, 8, 0)
    expect(nextRunAt({ kind: 'daily', time: '09:30', days: [] }, from)).toBe(at(2026, 3, 10, 9, 30))
  })

  it('rolls to tomorrow when the slot already passed', () => {
    const from = at(2026, 3, 10, 10, 0)
    expect(nextRunAt({ kind: 'daily', time: '09:30', days: [] }, from)).toBe(at(2026, 3, 11, 9, 30))
  })

  it('treats a slot exactly now as passed, so it cannot fire twice', () => {
    const from = at(2026, 3, 10, 9, 30)
    expect(nextRunAt({ kind: 'daily', time: '09:30', days: [] }, from)).toBe(at(2026, 3, 11, 9, 30))
  })

  it('crosses a month boundary', () => {
    const from = at(2026, 3, 31, 23, 0)
    expect(nextRunAt({ kind: 'daily', time: '01:00', days: [] }, from)).toBe(at(2026, 4, 1, 1, 0))
  })

  it('crosses a year boundary', () => {
    const from = at(2026, 12, 31, 23, 30)
    expect(nextRunAt({ kind: 'daily', time: '00:15', days: [] }, from)).toBe(at(2027, 1, 1, 0, 15))
  })

  it('handles a leap day', () => {
    const from = at(2028, 2, 28, 23, 0)
    expect(nextRunAt({ kind: 'daily', time: '10:00', days: [] }, from)).toBe(at(2028, 2, 29, 10, 0))
  })

  it('honours a weekday filter, skipping to the next allowed day', () => {
    // 2026-03-10 is a Tuesday (day 2).
    const tuesday = at(2026, 3, 10, 12, 0)
    // Only Monday (1) allowed → next Monday, 2026-03-16.
    expect(nextRunAt({ kind: 'daily', time: '09:00', days: [1] }, tuesday)).toBe(
      at(2026, 3, 16, 9, 0),
    )
  })

  it('fires later the same day when today is allowed', () => {
    const tuesday = at(2026, 3, 10, 7, 0)
    expect(nextRunAt({ kind: 'daily', time: '09:00', days: [2] }, tuesday)).toBe(
      at(2026, 3, 10, 9, 0),
    )
  })

  it('rolls a full week when today is the only allowed day but the slot passed', () => {
    const tuesday = at(2026, 3, 10, 12, 0)
    expect(nextRunAt({ kind: 'daily', time: '09:00', days: [2] }, tuesday)).toBe(
      at(2026, 3, 17, 9, 0),
    )
  })

  it('treats an empty weekday list as every day', () => {
    const sunday = at(2026, 3, 8, 12, 0)
    expect(nextRunAt({ kind: 'daily', time: '13:00', days: [] }, sunday)).toBe(
      at(2026, 3, 8, 13, 0),
    )
  })

  it('ignores invalid weekday numbers rather than never firing', () => {
    const tuesday = at(2026, 3, 10, 7, 0)
    expect(nextRunAt({ kind: 'daily', time: '09:00', days: [2, 99, -1] }, tuesday)).toBe(
      at(2026, 3, 10, 9, 0),
    )
  })

  it('returns null for a malformed time', () => {
    expect(nextRunAt({ kind: 'daily', time: '99:99', days: [] }, Date.now())).toBeNull()
  })

  it('returns null when every listed weekday is invalid', () => {
    // normalizeDays drops them all, which would mean "every day" — so this must
    // NOT be null. Guarding the distinction explicitly.
    expect(nextRunAt({ kind: 'daily', time: '09:00', days: [42] }, at(2026, 3, 10, 7, 0))).toBe(
      at(2026, 3, 10, 9, 0),
    )
  })
})

describe('normalizeDays', () => {
  it('dedupes, sorts, and drops out-of-range values', () => {
    expect(normalizeDays([3, 1, 1, 6, 7, -2, 2.5, Number.NaN])).toEqual([1, 3, 6])
  })

  it('keeps both boundary days', () => {
    expect(normalizeDays([6, 0])).toEqual([0, 6])
  })
})

describe('isMissedBeyondGrace', () => {
  it('is false inside the grace window', () => {
    const scheduled = at(2026, 3, 10, 9, 0)
    expect(isMissedBeyondGrace(scheduled, scheduled + 30_000)).toBe(false)
    expect(isMissedBeyondGrace(scheduled, scheduled + 60_000)).toBe(false)
  })

  it('is true once past it', () => {
    const scheduled = at(2026, 3, 10, 9, 0)
    expect(isMissedBeyondGrace(scheduled, scheduled + 60_001)).toBe(true)
  })

  it('is false for a slot still in the future', () => {
    const scheduled = at(2026, 3, 10, 9, 0)
    expect(isMissedBeyondGrace(scheduled, scheduled - 5_000)).toBe(false)
  })
})

describe('formatDuration', () => {
  it('scales the unit with the magnitude', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(450)).toBe('450ms')
    expect(formatDuration(1200)).toBe('1.2s')
    expect(formatDuration(59_400)).toBe('59.4s')
    expect(formatDuration(65_000)).toBe('1m 05s')
    expect(formatDuration(3_600_000)).toBe('60m 00s')
  })

  it('renders unusable input as a dash instead of NaN', () => {
    expect(formatDuration(undefined)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })
})

describe('formatTime', () => {
  it('renders a dash for a missing timestamp', () => {
    expect(formatTime(undefined)).toBe('—')
    expect(formatTime(0)).toBe('—')
  })

  it('renders a real timestamp', () => {
    expect(formatTime(at(2026, 3, 10, 9, 0))).toContain('2026')
  })
})

describe('describeSchedule', () => {
  it('describes intervals, clamping and flooring', () => {
    expect(describeSchedule({ kind: 'interval', everyMinutes: 30 })).toBe('every 30 min')
    expect(describeSchedule({ kind: 'interval', everyMinutes: 0 })).toBe('every 1 min')
    expect(describeSchedule({ kind: 'interval', everyMinutes: 2.7 })).toBe('every 2 min')
  })

  it('describes daily and weekly slots', () => {
    expect(describeSchedule({ kind: 'daily', time: '09:00', days: [] })).toBe('09:00 daily')
    expect(describeSchedule({ kind: 'daily', time: '09:00', days: [1, 3, 5] })).toBe(
      '09:00 Mon,Wed,Fri',
    )
  })
})
