/**
 * fetch-gb-history.mjs — GB mix + price history from Elexon Insights (key-less).
 *
 *   node scripts/fetch-gb-history.mjs [--backfill N]
 *
 * Writes ONLY public/live/history/gb.json — GB's day view stays browser-live
 * straight from Elexon, this bakes the week/month depth behind it. Fuel mix
 * comes from the generation outturn summary (30-minute, FUELINST fuel codes;
 * embedded solar isn't metered there, so — exactly like the GB live view —
 * solar is absent). Prices are the volume-weighted Market Index (APX + N2EX),
 * the same series the client's live layer uses.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  UA,
  accAdd,
  accKeys,
  accMeanSeries,
  buildDayRecord,
  buildMixRows,
  historyDates,
  hourlyDates,
  hoursCovered,
  importAvg,
  makeHourlyAcc,
  meanCovered,
  mergeHistory,
  missingDates,
  patchHistoryDay,
  priceAvg,
  readHistory,
} from './snapshot-common.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'live')
const BASE = 'https://data.elexon.co.uk/bmrs/api/v1'

/** Elexon fuel code → snapshot bucket; INT* interconnectors → imports. */
export const FUEL_KEY = {
  CCGT: 'gas',
  OCGT: 'gas',
  NUCLEAR: 'nuclear',
  WIND: 'wind',
  PS: 'hydro',
  NPSHYD: 'hydro',
  BIOMASS: 'biomass',
  COAL: 'coal',
  OIL: 'other',
  OTHER: 'other',
}

/**
 * Outturn summary rows → hourly mixSeries + signed importSeries (INT*
 * generation is negative when GB exports). Each row is one timestamp with
 * every fuel's instantaneous MW; the cadence varies (5-minute FUELINST-style
 * readings), so buckets are summed WITHIN a timestamp (CCGT+OCGT, PS+NPSHYD,
 * all INT*) and then averaged across however many readings land in the hour.
 */
export function aggregateOutturnDay(rows) {
  const acc = makeHourlyAcc()
  const imp = makeHourlyAcc()
  for (const period of rows ?? []) {
    const hour = parseInt(period.startTime?.slice(11, 13), 10)
    const perBucket = new Map()
    let netImport = null
    for (const { fuelType, generation } of period.data ?? []) {
      if (!Number.isFinite(generation)) continue
      if (typeof fuelType === 'string' && fuelType.startsWith('INT')) {
        netImport = (netImport ?? 0) + generation
      } else {
        const key = FUEL_KEY[fuelType]
        if (key) perBucket.set(key, (perBucket.get(key) ?? 0) + generation)
      }
    }
    for (const [key, mw] of perBucket) accAdd(acc, key, hour, mw)
    if (netImport != null) accAdd(imp, 'imp', hour, netImport)
  }
  const mixSeries = {}
  for (const key of accKeys(acc)) {
    mixSeries[key] = accMeanSeries(acc, key).map((v) =>
      v == null ? null : Math.round(Math.max(0, v)),
    )
  }
  const impSeries = accMeanSeries(imp, 'imp')
  return {
    mixSeries,
    importSeries: impSeries ? impSeries.map((v) => (v == null ? null : Math.round(v))) : null,
  }
}

/** Market Index rows (30-min, per provider) → hourly volume-weighted £/MWh. */
export function aggregateMidDay(rows) {
  const acc = makeHourlyAcc()
  for (const r of rows ?? []) {
    const hour = parseInt(r.startTime?.slice(11, 13), 10)
    if (Number.isFinite(r.price) && r.volume > 0) accAdd(acc, 'p', hour, r.price, r.volume)
  }
  const series = accMeanSeries(acc, 'p')
  return series ? series.map((v) => (v == null ? null : Math.round(v * 100) / 100)) : null
}

async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`Elexon ${res.status} for ${url}`)
  return res.json()
}

/** INDO rows (half-hourly national demand) → hourly mean MW series (#24). */
export function aggregateIndoDay(rows) {
  const acc = makeHourlyAcc()
  for (const r of rows ?? []) {
    const hour = parseInt(r.startTime?.slice(11, 13), 10)
    if (Number.isFinite(r.initialDemandOutturn)) accAdd(acc, 'd', hour, r.initialDemandOutturn)
  }
  const series = accMeanSeries(acc, 'd')
  return series ? series.map((v) => (v == null ? null : Math.round(v))) : null
}

async function fetchDay(date) {
  const outturn = await getJson(
    `${BASE}/generation/outturn/summary?startTime=${date}T00:00Z&endTime=${date}T23:59Z&format=json`,
  )
  const mid = await getJson(
    `${BASE}/balancing/pricing/market-index?from=${date}T00:00Z&to=${date}T23:59Z&format=json`,
  ).catch(() => null)
  const indo = await getJson(
    `${BASE}/demand/outturn?settlementDateFrom=${date}&settlementDateTo=${date}&format=json`,
  ).catch(() => null)
  const { mixSeries, importSeries } = aggregateOutturnDay(
    Array.isArray(outturn) ? outturn : (outturn?.data ?? []),
  )
  return {
    mixSeries,
    importSeries,
    prices: aggregateMidDay(mid?.data),
    demand: aggregateIndoDay(indo?.data),
  }
}

// ------------------------------------------------------------------- main
async function main() {
  mkdirSync(join(OUT_DIR, 'history'), { recursive: true })
  const bfIdx = process.argv.indexOf('--backfill')
  const backfillDays = bfIdx >= 0 ? Math.max(1, parseInt(process.argv[bfIdx + 1], 10) || 31) : null

  const histPath = join(OUT_DIR, 'history', 'gb.json')
  const hourlyWant = missingDates(hourlyDates(histPath), 1, 7)
  const dailyWant = backfillDays ? missingDates(historyDates(histPath), 8, backfillDays) : []
  const want = [...hourlyWant, ...dailyWant].slice(0, backfillDays ?? 3)
  let added = 0
  for (const date of want) {
    try {
      const { mixSeries, importSeries, prices, demand } = await fetchDay(date)
      if (hoursCovered(mixSeries) < 20) continue // partial day — retry next run
      const bucketAvg = new Map()
      for (const [key, series] of Object.entries(mixSeries)) {
        const avg = meanCovered(series)
        if (avg > 0) bucketAvg.set(key, avg)
      }
      mergeHistory(histPath, {
        currency: 'GBP',
        sourceLabel: 'Elexon',
        day: buildDayRecord(
          date,
          buildMixRows(bucketAvg).rows,
          importAvg(importSeries),
          priceAvg(prices),
          demand ? meanCovered(demand) : null,
        ),
        hourly: {
          date,
          mixSeries,
          importSeries,
          prices,
          perStation: null,
          flowSeries: null,
          demand: demand ?? null,
        },
      })
      added++
    } catch (err) {
      console.warn(`gb: ${date} failed — ${err.message}`)
    }
  }
  console.log(`gb: history +${added}/${want.length} day(s)`)

  // Month days recorded before demandMW existed (v3) carry no demand field.
  // INDO is a cheap standalone call, so patch them in place rather than
  // re-baking the whole day — same self-heal the ENTSO-E baker runs (#24).
  const needDemand = (readHistory(histPath)?.days ?? [])
    .filter((r) => r.demandMW === undefined)
    .map((r) => r.date)
    .slice(0, backfillDays ?? 3)
  let patched = 0
  for (const date of needDemand) {
    const indo = await getJson(
      `${BASE}/demand/outturn?settlementDateFrom=${date}&settlementDateTo=${date}&format=json`,
    ).catch(() => null)
    const d = aggregateIndoDay(indo?.data)
    if (patchHistoryDay(histPath, date, { demandMW: d ? Math.round(meanCovered(d)) : null }))
      patched++
  }
  if (needDemand.length) console.log(`gb: demand patched ${patched}/${needDemand.length}`)
}

// Import-safe for tests: only run when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
