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

/** Position→hour for ENTSO-E period points (position is 1-based). */
export const hourOfPosition = (position, stepMin) => Math.floor(((position - 1) * stepMin) / 60)

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

/**
 * bucket key → avg MW map → sorted MixRow[] + total. When importMW is a
 * number an imports/net-export row is appended (the ENTSO-E fetcher); pass
 * null to omit it (IESO/US feeds carry no flow data).
 * Row shape matches src/lib/fleet.ts MixRow (capMW omitted for snapshots).
 */
export function buildMixRows(bucketAvg, importMW = null) {
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
      label: importMW >= 0 ? 'Imports (HVDC)' : 'Net export (HVDC)',
      color: IMPORTS_COLOR,
      nowMW: Math.round(Math.abs(importMW)),
      capMW: 0,
    })
  }
  const totalMW = rows.filter((r) => r.key !== 'imports').reduce((a, r) => a + r.nowMW, 0)
  return { rows, totalMW }
}
