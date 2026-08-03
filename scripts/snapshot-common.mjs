/**
 * snapshot-common.mjs — shared helpers for the live-snapshot fetchers
 * (fetch-entsoe-snapshot, fetch-ca-snapshot, fetch-us-snapshot).
 *
 * Before this module each fetcher re-implemented the mix palette, the
 * hourly accumulator, covered-mean/through-hour math, date helpers and the
 * mix-row builder — three drifting copies of everything (#52).
 *
 * Client-side note: src/lib/fuels.ts (per-fuel station palette) and
 * src/lib/fleet.ts (GB mix buckets, where "other" is intentionally the
 * pink storage colour) stay separate — this table is the *snapshot bucket*
 * palette shared by the three bakers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { XMLParser } from 'fast-xml-parser'

export const UA = { 'User-Agent': 'grid-atlas/1.0 (open-data dashboard)' }

/** Snapshot mix-bucket key → display label + colour. */
export const BUCKET_META = {
  wind: { label: 'Wind', color: '#199e70' },
  solar: { label: 'Solar', color: '#c98500' },
  gas: { label: 'Gas', color: '#3987e5' },
  nuclear: { label: 'Nuclear', color: '#9085e9' },
  coal: { label: 'Coal & lignite', color: '#ad7a45' },
  geothermal: { label: 'Geothermal', color: '#bd5fd1' },
  biomass: { label: 'Biomass & waste', color: '#d95926' },
  hydro: { label: 'Hydro & pumped', color: '#1899ac' },
  storage: { label: 'Battery storage', color: '#d55181' },
  other: { label: 'Oil & other', color: '#e66767' },
}
export const FALLBACK_COLOR = '#898781'
export const IMPORTS_COLOR = '#2dd4bf'

// ------------------------------------------------------------------ dates
export const isoDaysAgo = (n) => {
  const d = new Date(Date.now() - n * 24 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}
export const compactDate = (iso) => iso.replace(/-/g, '')

// --------------------------------------------------------------- XML/misc
export const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x])
export const makeXmlParser = () => new XMLParser({ ignoreAttributes: false, parseTagValue: false })

// ----------------------------------------------------- hourly accumulator
/**
 * 24-slot accumulator keyed by bucket. Two read-outs cover the two
 * semantics the fetchers use (kept separate so refactoring changes no
 * output values):
 *  - sumSeries():  slot = Σ(value·portion)  — energy-weighted hour total,
 *    what the ENTSO-E mix uses (portion = stepMin/60).
 *  - meanSeries(): slot = Σ(value·portion)/Σportion — plain average, what
 *    prices and the US ISO feeds use.
 * Slots nobody wrote stay null.
 */
export function makeHourlyAcc() {
  return new Map()
}
export function accAdd(acc, key, hour, value, portion = 1) {
  if (hour < 0 || hour > 23 || !Number.isFinite(value)) return
  let a = acc.get(key)
  if (!a) {
    a = { sums: new Array(24).fill(0), portions: new Array(24).fill(0) }
    acc.set(key, a)
  }
  a.sums[hour] += value * portion
  a.portions[hour] += portion
}
export function accSumSeries(acc, key) {
  const a = acc.get(key)
  if (!a) return null
  return a.sums.map((v, h) => (a.portions[h] > 0 ? v : null))
}
export function accMeanSeries(acc, key) {
  const a = acc.get(key)
  if (!a) return null
  return a.sums.map((v, h) => (a.portions[h] > 0 ? v / a.portions[h] : null))
}
export const accKeys = (acc) => [...acc.keys()]

// hourOfPosition used to live here — position→hour on the assumption that a
// Period starts at midnight and every point covers one slot. Both halves are
// wrong (see expandSeries in entsoe.mjs), so it's gone rather than left
// around to be reached for again.

// ------------------------------------------------------------- day math
/** Mean of the non-null slots (0 when none) — partial-day-correct. */
export function meanCovered(series) {
  let sum = 0
  let n = 0
  for (const v of series) {
    if (v == null) continue
    sum += v
    n++
  }
  return n ? sum / n : 0
}

/** Last hour (1-based) with data across all bucket series, 0 when none. */
export function throughHour(mixSeries) {
  return Math.max(
    ...Object.values(mixSeries).map((s) => s.reduce((a, v, h) => (v != null ? h + 1 : a), 0)),
    0,
  )
}

/** hourly series (avg MW per slot) → the StationDay shape the client reads. */
export function buildStationDay(series) {
  const vals = series.filter((v) => v != null)
  if (!vals.length) return null
  const energyMWh = vals.reduce((a, b) => a + b, 0)
  return {
    series: series.map((v) => (v == null ? null : Math.round(v * 10) / 10)),
    periods: vals.length,
    avgMW: Math.round((energyMWh / vals.length) * 10) / 10,
    peakMW: Math.round(Math.max(...vals) * 10) / 10,
    energyGWh: Math.round(energyMWh / 100) / 10,
  }
}

// ------------------------------------------------------------- history
/**
 * Rolling per-country history file (public/live/history/<cc>.json):
 *   { version, updatedAt, currency, sourceLabel,
 *     days:   [{date, mix, importMW, totalMW, price}] oldest→newest ≤ maxDays,
 *     hourly: [{date, mixSeries, importSeries, prices, perStation, flowSeries}]
 *             oldest→newest ≤ maxHourly }
 * Each fetcher upserts its final metered days here every run (idempotent —
 * re-running a day replaces it), so the month view maintains itself.
 *
 * v2 added perStation/flowSeries to hourly records (week scrub on the map);
 * v3 added demand (#24). Upserting into an older file keeps its days but
 * drops the hourly records, so the normal missing-hourly catch-up refetches
 * the week in the new shape.
 */
export const HISTORY_VERSION = 3

export function upsertHistory(existing, { currency, sourceLabel, day, hourly }, opts = {}) {
  const { maxDays = 31, maxHourly = 7 } = opts
  const outdated = existing != null && (existing.version ?? 1) < HISTORY_VERSION
  const out = {
    version: HISTORY_VERSION,
    updatedAt: existing?.updatedAt ?? null,
    currency: currency ?? existing?.currency ?? null,
    sourceLabel: sourceLabel ?? existing?.sourceLabel ?? null,
    days: [...(existing?.days ?? [])],
    hourly: outdated ? [] : [...(existing?.hourly ?? [])],
  }
  const upsert = (list, rec) => {
    if (!rec) return list
    const i = list.findIndex((r) => r.date === rec.date)
    if (i >= 0) list[i] = rec
    else list.push(rec)
    list.sort((a, b) => (a.date < b.date ? -1 : 1))
    return list
  }
  out.days = upsert(out.days, day).slice(-maxDays)
  out.hourly = upsert(out.hourly, hourly).slice(-maxHourly)
  return out
}

/** Read → upsert → write history at path. Returns the merged object. */
export function mergeHistory(path, patch, opts) {
  let existing = null
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      existing = null // corrupt file — rebuild from this run onward
    }
  }
  const merged = upsertHistory(existing, patch, opts)
  merged.updatedAt = new Date().toISOString()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(merged))
  return merged
}

/**
 * Day record for history.days from the pieces every fetcher already has.
 * mixRows: MixRow[] (the imports row is skipped); importMW/price may be null.
 */
export function buildDayRecord(date, mixRows, importMW, price, demandMW = null) {
  const mix = {}
  let totalMW = 0
  for (const r of mixRows) {
    if (r.key === 'imports') continue
    mix[r.key] = r.nowMW
    totalMW += r.nowMW
  }
  return {
    date,
    mix,
    importMW: importMW == null ? null : Math.round(importMW),
    totalMW,
    price: price == null ? null : Math.round(price * 100) / 100,
    // A grid-wide demand of exactly zero is an upstream filing artifact, not a
    // measurement — no interconnected system has zero load. MEPSO (mk) files
    // such zeros on days it has not metered yet; store them as "not reported".
    demandMW: demandMW == null || demandMW <= 0 ? null : Math.round(demandMW),
  }
}

/** Day-average price from an hourly series (null when nothing covered). */
export function priceAvg(series) {
  if (!series || !series.some((v) => v != null)) return null
  return Math.round(meanCovered(series) * 100) / 100
}

/** Net-import day average, null when the country has no flow data at all. */
export function importAvg(importSeries) {
  if (!importSeries || !importSeries.some((v) => v != null)) return null
  return Math.round(meanCovered(importSeries))
}

/** Parse a history file (null on missing/corrupt). */
export function readHistory(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Dates already recorded in a history file's days (empty on missing/corrupt). */
export function historyDates(path) {
  return (readHistory(path)?.days ?? []).map((d) => d.date)
}

/**
 * Patch fields onto an existing month day in place, leaving its mix rows
 * alone. Cheap self-heal for fields added after a day was first recorded
 * (demandMW landed in v3), so old days gain them without a full re-bake.
 * Returns false when the day isn't in the file.
 */
export function patchHistoryDay(histPath, date, fields) {
  const h = readHistory(histPath)
  const rec = h?.days?.find((r) => r.date === date)
  if (!rec) return false
  Object.assign(rec, fields)
  writeFileSync(histPath, JSON.stringify(h))
  return true
}

/**
 * Dates whose HOURLY record is missing or pre-dates the current schema —
 * the week-scrub catch-up worklist (a v1 file reports every recent day).
 */
export function hourlyDates(path) {
  const h = readHistory(path)
  if (!h || (h.version ?? 1) < HISTORY_VERSION) return []
  return (h.hourly ?? []).map((r) => r.date)
}

/** StationDay map → lean {id: series} for hourly history (null when empty). */
export function stationSeriesOnly(perStation) {
  const out = {}
  for (const [id, d] of Object.entries(perStation ?? {})) {
    if (d?.series) out[id] = d.series
  }
  return Object.keys(out).length ? out : null
}

/**
 * ISO dates from `backFrom`..`backTo` days ago (inclusive) that are missing
 * from `haveDates` — the catch-up worklist for incremental history runs.
 */
export function missingDates(haveDates, backFrom, backTo) {
  const have = new Set(haveDates)
  const out = []
  for (let back = backFrom; back <= backTo; back++) {
    const d = isoDaysAgo(back)
    if (!have.has(d)) out.push(d)
  }
  return out
}

/** How many hours of a day's mixSeries are covered (max across buckets). */
export function hoursCovered(mixSeries) {
  return Math.max(...Object.values(mixSeries).map((s) => s.filter((v) => v != null).length), 0)
}

/**
 * bucket key → avg MW map → sorted MixRow[] + total. When importMW is a
 * number an imports/net-export row is appended (the ENTSO-E fetcher); pass
 * null to omit it (IESO/US feeds carry no flow data).
 * Row shape matches src/lib/fleet.ts MixRow (capMW omitted for snapshots).
 */
export function buildMixRows(bucketAvg, importMW = null, { net = false } = {}) {
  const rows = [...bucketAvg.entries()]
    .map(([key, mw]) => ({
      key,
      label: BUCKET_META[key]?.label ?? key,
      color: BUCKET_META[key]?.color ?? FALLBACK_COLOR,
      nowMW: Math.round(mw),
      capMW: 0,
    }))
    .filter((r) => r.nowMW > 0)
    .sort((a, b) => b.nowMW - a.nowMW)
  if (importMW != null) {
    rows.push({
      key: 'imports',
      // `net` means the figure is the A11 sum over EVERY border (#93) — the
      // honest signed position. Without it the figure is HVDC links only,
      // and the label must keep saying so.
      label: net
        ? importMW >= 0
          ? 'Net imports'
          : 'Net exports'
        : importMW >= 0
          ? 'Imports (HVDC)'
          : 'Net export (HVDC)',
      color: IMPORTS_COLOR,
      nowMW: Math.round(Math.abs(importMW)),
      capMW: 0,
    })
  }
  const totalMW = rows.filter((r) => r.key !== 'imports').reduce((a, r) => a + r.nowMW, 0)
  return { rows, totalMW }
}

/**
 * Whether an existing snapshot's today block may survive an intraday tick
 * (#98): only when it still describes the current calendar day. A block from
 * yesterday under a fresh generatedAt would read "today through 23:00" at
 * 01:00 — a lie the strip has no date field to correct.
 */
export function carryToday(existingToday, todayDate) {
  return existingToday?.date === todayDate ? existingToday : null
}
