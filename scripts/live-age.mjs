/**
 * Freshness gate for the intraday tick (#98).
 *
 * GitHub delays and silently drops `schedule` events. Between 3 Aug 20:32 and
 * 4 Aug 08:00 UTC the hourly tick fired 4 times out of ~11 — every one of them
 * a success — and the 6-hourly bake landed 1h25m–4h08m late with one 17.5 h
 * gap. Nothing failed; the events simply never arrived. So the tick asks three
 * times an hour and this script decides whether each attempt has work to do:
 * a missing slot costs 20 minutes instead of an hour, and a redundant slot
 * costs a 15-second job.
 *
 *   node scripts/live-age.mjs                 # gate: is public/live stale?
 *   node scripts/live-age.mjs --max-age 60    # ...against a different target
 *   node scripts/live-age.mjs --lagging 3     # metered days >3 d behind
 *
 * Deliberately dependency-free — node built-ins only — so the gate job runs on
 * a bare checkout with the runner's own node: no setup-node, no `npm ci`.
 *
 * Always exits 0. Staleness is a decision, not a failure; the workflow reads
 * `stale` from $GITHUB_OUTPUT and skips the tick job.
 */
import { appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const LIVE_DIR = join(process.cwd(), 'public', 'live')

/** Minutes. See assessFreshness for why these two numbers differ. */
export const DEFAULTS = { maxAge: 45, minGap: 15 }

/** coverage.json is derived from the snapshots, not one of them. */
const DERIVED = new Set(['coverage'])

/** Age of a snapshot in minutes. Missing or unparseable = infinitely old. */
export function ageMinutes(generatedAt, now) {
  const t = Date.parse(generatedAt ?? '')
  if (!Number.isFinite(t)) return Infinity
  return Math.max(0, (now - t) / 60000)
}

export function median(nums) {
  if (nums.length === 0) return Infinity
  const s = [...nums].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Stale when the fleet's MEDIAN age is past `maxAge` and nothing has been
 * written in the last `minGap` minutes. Pure: give it ages, get a verdict.
 *
 * Median rather than oldest, because one permanently-broken feed must not pin
 * the gate open. A grid wedged at six hours would otherwise order a tick at
 * every slot forever, and ticking cannot fix it — the 6-hourly bake retries
 * that grid with the full pipeline. The median tracks the fleet, so it goes
 * stale exactly when ticks stop landing, which is the thing being watched.
 * `oldest` is still measured and printed: it names the laggard without giving
 * it a vote.
 *
 * `minGap` is the debounce. It binds when the median is old but something was
 * written moments ago — a bake that wrote a handful of grids and then died, or
 * a run that queued behind the previous one (cancel-in-progress is false) and
 * starts just as that one finishes. It sits below the 20-minute slot spacing,
 * so it can never block a legitimate next-slot rescue.
 *
 * No files at all is stale: an empty public/live is not freshness.
 */
export function assessFreshness(grids, now, opts = {}) {
  const { maxAge, minGap } = { ...DEFAULTS, ...opts }
  const aged = grids
    .map((g) => ({ cc: g.cc, age: ageMinutes(g.generatedAt, now) }))
    .sort((a, b) => a.age - b.age)

  if (aged.length === 0) {
    return {
      stale: true,
      reason: 'public/live has no snapshot files',
      count: 0,
      youngest: Infinity,
      median: Infinity,
      oldest: Infinity,
      worst: null,
      maxAge,
      minGap,
    }
  }

  const youngest = aged[0].age
  const last = aged[aged.length - 1]
  const mid = median(aged.map((a) => a.age))

  let stale, reason
  if (!(mid > maxAge)) {
    stale = false
    reason = `median inside the ${maxAge} min target`
  } else if (!(youngest > minGap)) {
    stale = false
    reason = `something wrote ${fmtAge(youngest)} ago, under the ${minGap} min floor`
  } else {
    stale = true
    reason = `median past the ${maxAge} min target`
  }

  return {
    stale,
    reason,
    count: aged.length,
    youngest,
    median: mid,
    oldest: last.age,
    worst: last.cc,
    maxAge,
    minGap,
  }
}

/** Grids whose metered day is more than `days` behind `today` (YYYY-MM-DD). */
export function laggingGrids(grids, today, days) {
  const t = Date.parse(`${today}T00:00:00Z`)
  return grids
    .map((g) => {
      const d = Date.parse(`${g.date ?? ''}T00:00:00Z`)
      return {
        cc: g.cc,
        date: g.date ?? null,
        daysBehind: Number.isFinite(d) ? (t - d) / 86400000 : Infinity,
      }
    })
    .filter((g) => g.daysBehind > days)
    .sort((a, b) => b.daysBehind - a.daysBehind || a.cc.localeCompare(b.cc))
}

export const fmtAge = (m) => (Number.isFinite(m) ? `${Math.round(m)} min` : 'no timestamp')

export function summaryLine(a) {
  const verdict = a.stale ? 'STALE -> tick' : 'fresh -> holding'
  if (a.count === 0) return `live age: no snapshot files · ${verdict} (${a.reason})`
  return (
    `live age: ${a.count} grids · youngest ${fmtAge(a.youngest)} · ` +
    `median ${fmtAge(a.median)} · oldest ${fmtAge(a.oldest)} (${a.worst}) · ` +
    `${verdict} (${a.reason})`
  )
}

/** Read every grid snapshot's timestamp and metered day. A corrupt file reads
 *  as having neither, which makes it infinitely old — visible in `oldest`, but
 *  outvoted in the median. A missing directory reads as no grids, which
 *  assessFreshness calls stale: a verdict beats a stack trace, and the workflow
 *  fails open anyway. */
export function readGrids(dir = LIVE_DIR) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((f) => f.endsWith('.json') && !DERIVED.has(f.slice(0, -5)))
    .map((f) => {
      const cc = f.slice(0, -5)
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        return { cc, generatedAt: j.generatedAt ?? null, date: j.date ?? null }
      } catch {
        return { cc, generatedAt: null, date: null }
      }
    })
    .sort((a, b) => a.cc.localeCompare(b.cc))
}

// Entry point — skipped under vitest import.
if (process.argv[1] && process.argv[1].endsWith('live-age.mjs')) {
  const num = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`)
    if (i < 0) return dflt
    const v = Number(process.argv[i + 1])
    return Number.isFinite(v) ? v : dflt
  }
  const str = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`)
    return i < 0 ? dflt : (process.argv[i + 1] ?? dflt)
  }

  const dir = str('dir', LIVE_DIR)
  const grids = readGrids(dir)

  if (process.argv.includes('--lagging')) {
    const days = num('lagging', 3)
    const today = new Date().toISOString().slice(0, 10)
    const behind = laggingGrids(grids, today, days)
    if (behind.length === 0) {
      console.log(`metered day: none of ${grids.length} grids more than ${days} d behind ${today}`)
    } else {
      console.log(`metered day, more than ${days} d behind ${today}:`)
      for (const g of behind) {
        const n = Number.isFinite(g.daysBehind) ? `${g.daysBehind} d` : 'no date'
        console.log(`  ${g.cc.padEnd(3)} ${n.padStart(7)}  ${g.date ?? '—'}`)
      }
      console.log(`  ${behind.length} of ${grids.length} grids lagging`)
    }
  } else {
    const a = assessFreshness(grids, Date.now(), {
      maxAge: num('max-age', DEFAULTS.maxAge),
      minGap: num('min-gap', DEFAULTS.minGap),
    })
    console.log(summaryLine(a))
    if (process.env.GITHUB_OUTPUT) {
      // -1 stands in for Infinity so every value stays a number downstream.
      const n = (v) => (Number.isFinite(v) ? Math.round(v) : -1)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `stale=${a.stale}\noldest=${n(a.oldest)}\nyoungest=${n(a.youngest)}\n` +
          `median=${n(a.median)}\ncount=${a.count}\n`,
      )
    }
  }
}
