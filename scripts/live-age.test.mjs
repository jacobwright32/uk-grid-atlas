// Freshness gate (#98 cadence fix). The gate decides whether an intraday slot
// has work to do; getting it wrong is expensive in both directions — too eager
// and the repo takes three commits and three Pages deploys an hour, too shy and
// the atlas goes stale exactly as it did on 3 Aug.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULTS,
  ageMinutes,
  assessFreshness,
  laggingGrids,
  median,
  readGrids,
  summaryLine,
} from './live-age.mjs'

const NOW = Date.parse('2026-08-04T12:00:00Z')
/** An ISO stamp `mins` minutes before NOW. */
const at = (mins) => new Date(NOW - mins * 60000).toISOString()
/** A fleet where every grid was written the same number of minutes ago. */
const fleet = (mins, n = 31) =>
  Array.from({ length: n }, (_, i) => ({ cc: `c${i}`, generatedAt: at(mins) }))

describe('ageMinutes', () => {
  it('measures minutes since generatedAt', () => {
    expect(ageMinutes(at(0), NOW)).toBe(0)
    expect(ageMinutes(at(73), NOW)).toBe(73)
  })

  it('treats a missing or unparseable stamp as infinitely old', () => {
    expect(ageMinutes(null, NOW)).toBe(Infinity)
    expect(ageMinutes(undefined, NOW)).toBe(Infinity)
    expect(ageMinutes('', NOW)).toBe(Infinity)
    expect(ageMinutes('last tuesday', NOW)).toBe(Infinity)
  })

  it('never reports a future stamp as negative age', () => {
    expect(ageMinutes(at(-30), NOW)).toBe(0)
  })
})

describe('median', () => {
  it('handles odd, even and empty', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(Infinity)
  })
})

describe('assessFreshness', () => {
  it('holds while the fleet is inside the target', () => {
    const a = assessFreshness(fleet(20), NOW)
    expect(a.stale).toBe(false)
    expect(a.median).toBe(20)
    expect(a.reason).toContain('45 min target')
  })

  it('calls for a tick once the fleet is past the target', () => {
    const a = assessFreshness(fleet(60), NOW)
    expect(a.stale).toBe(true)
    expect(a.youngest).toBe(60)
    expect(a.oldest).toBe(60)
  })

  it('is strict at the boundary — exactly maxAge is still fresh', () => {
    expect(assessFreshness(fleet(45), NOW).stale).toBe(false)
    expect(assessFreshness(fleet(46), NOW).stale).toBe(true)
  })

  // The behaviour the three-slot cron is buying: a landed tick silences the
  // next two slots, and a dropped one is rescued 20 minutes later, not 60.
  it('walks the :07/:27/:47 slots correctly after a tick lands', () => {
    const ages = { landed: 0, plus20: 20, plus40: 40, plus60: 60, plus80: 80, plus100: 100 }
    expect(assessFreshness(fleet(ages.plus20), NOW).stale).toBe(false) // :27, holds
    expect(assessFreshness(fleet(ages.plus40), NOW).stale).toBe(false) // :47, holds
    expect(assessFreshness(fleet(ages.plus60), NOW).stale).toBe(true) // :07, ticks
    expect(assessFreshness(fleet(ages.plus80), NOW).stale).toBe(true) // :07 dropped
    expect(assessFreshness(fleet(ages.plus100), NOW).stale).toBe(true) // and :27 too
  })

  it('a tight spread from one 4-minute pass reads as one age', () => {
    // A full 29-grid --intraday pass takes ~253 s, so a healthy fleet is
    // smeared over about four minutes. That must not tip the verdict.
    const grids = Array.from({ length: 31 }, (_, i) => ({
      cc: `c${i}`,
      generatedAt: at(42 + i / 8),
    }))
    expect(assessFreshness(grids, NOW).stale).toBe(false)
    expect(assessFreshness(grids, NOW).oldest).toBeCloseTo(45.75, 5)
  })

  // The reason the gate reads the median and not the maximum.
  it('will not let one wedged grid order a tick every slot', () => {
    const grids = [...fleet(10, 30), { cc: 'ca', generatedAt: at(6 * 60) }]
    const a = assessFreshness(grids, NOW)
    expect(a.stale).toBe(false)
    expect(a.oldest).toBe(360)
    expect(a.worst).toBe('ca') // named, but outvoted
    expect(a.median).toBe(10)
  })

  it('still names a grid that has no timestamp at all without giving it a vote', () => {
    const grids = [...fleet(10, 30), { cc: 'zz', generatedAt: null }]
    const a = assessFreshness(grids, NOW)
    expect(a.stale).toBe(false)
    expect(a.oldest).toBe(Infinity)
    expect(a.worst).toBe('zz')
  })

  it('goes stale when most of the fleet has no timestamp', () => {
    const mostlyBlank = (youngestMins) => [
      ...Array.from({ length: 20 }, (_, i) => ({ cc: `x${i}`, generatedAt: null })),
      ...fleet(youngestMins, 11),
    ]
    const a = assessFreshness(mostlyBlank(25), NOW)
    expect(a.median).toBe(Infinity)
    expect(a.stale).toBe(true)
    // The floor still comes first, though: 11 grids written five minutes ago
    // means a run is mid-flight or just died, and the next slot is soon enough.
    expect(assessFreshness(mostlyBlank(5), NOW).stale).toBe(false)
  })

  // A run that wrote three grids and died leaves the median old and the
  // youngest brand new. The retry belongs on the next slot, not immediately.
  it('debounces a partial write instead of stampeding', () => {
    const partial = (youngestMins) => [...fleet(200, 28), ...fleet(youngestMins, 3)]
    expect(assessFreshness(partial(2), NOW).stale).toBe(false)
    expect(assessFreshness(partial(2), NOW).reason).toContain('15 min floor')
    // ...and by the next slot, 20 minutes later, it goes ahead.
    expect(assessFreshness(partial(20), NOW).stale).toBe(true)
  })

  it('never blocks a next-slot rescue: the floor is under the slot spacing', () => {
    expect(DEFAULTS.minGap).toBeLessThan(20)
    expect(DEFAULTS.minGap).toBeLessThan(DEFAULTS.maxAge)
  })

  it('treats an empty public/live as stale', () => {
    const a = assessFreshness([], NOW)
    expect(a.stale).toBe(true)
    expect(a.count).toBe(0)
    expect(a.reason).toContain('no snapshot files')
  })

  it('honours overridden thresholds', () => {
    expect(assessFreshness(fleet(60), NOW, { maxAge: 90 }).stale).toBe(false)
    expect(assessFreshness(fleet(30), NOW, { maxAge: 20 }).stale).toBe(true)
    const partial = [...fleet(200, 28), ...fleet(25, 3)]
    expect(assessFreshness(partial, NOW, { minGap: 30 }).stale).toBe(false)
  })
})

describe('summaryLine', () => {
  it('reports every measurement and the verdict', () => {
    const line = summaryLine(
      assessFreshness([...fleet(70, 30), { cc: 'rs', generatedAt: null }], NOW),
    )
    expect(line).toContain('31 grids')
    expect(line).toContain('youngest 70 min')
    expect(line).toContain('median 70 min')
    expect(line).toContain('oldest no timestamp (rs)')
    expect(line).toContain('STALE')
  })

  it('says so when it is holding', () => {
    expect(summaryLine(assessFreshness(fleet(5), NOW))).toContain('fresh -> holding')
  })
})

describe('laggingGrids', () => {
  const grids = [
    { cc: 'rs', date: '2026-07-22' },
    { cc: 'pl', date: '2026-07-25' },
    { cc: 'at', date: '2026-07-30' },
    { cc: 'de', date: '2026-08-01' },
    { cc: 'it', date: '2026-08-03' },
    { cc: 'gb', date: null },
  ]

  it('lists the worst offenders first', () => {
    const out = laggingGrids(grids, '2026-08-04', 3)
    expect(out.map((g) => g.cc)).toEqual(['gb', 'rs', 'pl', 'at'])
    expect(out.find((g) => g.cc === 'rs').daysBehind).toBe(13)
    expect(out.find((g) => g.cc === 'pl').daysBehind).toBe(10)
  })

  it('is strict about the threshold', () => {
    // de is exactly 3 d behind — not "more than 3".
    expect(laggingGrids(grids, '2026-08-04', 3).map((g) => g.cc)).not.toContain('de')
    expect(laggingGrids(grids, '2026-08-04', 2).map((g) => g.cc)).toContain('de')
  })

  it('counts a missing metered date as infinitely behind', () => {
    expect(laggingGrids(grids, '2026-08-04', 3).find((g) => g.cc === 'gb').daysBehind).toBe(
      Infinity,
    )
  })

  it('ignores a metered day that is somehow ahead of today', () => {
    expect(laggingGrids([{ cc: 'xx', date: '2026-08-09' }], '2026-08-04', 0)).toEqual([])
  })
})

describe('readGrids', () => {
  it('reads timestamps, skips derived files and survives corruption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-age-'))
    writeFileSync(join(dir, 'de.json'), JSON.stringify({ generatedAt: at(5), date: '2026-08-01' }))
    writeFileSync(join(dir, 'at.json'), JSON.stringify({ date: '2026-07-30' })) // no stamp
    writeFileSync(join(dir, 'coverage.json'), JSON.stringify({ generatedAt: at(0) })) // derived
    writeFileSync(join(dir, 'bad.json'), '{ not json')
    writeFileSync(join(dir, 'notes.txt'), 'ignored')

    const grids = readGrids(dir)
    expect(grids.map((g) => g.cc)).toEqual(['at', 'bad', 'de'])
    expect(grids.find((g) => g.cc === 'de').date).toBe('2026-08-01')
    expect(grids.find((g) => g.cc === 'at').generatedAt).toBe(null)
    expect(grids.find((g) => g.cc === 'bad').generatedAt).toBe(null)
  })

  it('reports no grids rather than throwing when the directory is missing', () => {
    expect(readGrids(join(tmpdir(), 'live-age-does-not-exist'))).toEqual([])
    expect(assessFreshness(readGrids(join(tmpdir(), 'nope-not-here')), NOW).stale).toBe(true)
  })
})
