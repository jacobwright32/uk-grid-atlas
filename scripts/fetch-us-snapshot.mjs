/**
 * fetch-us-snapshot.mjs — US live phase 1: ERCOT + NYISO public fuel mixes.
 *
 *   node scripts/fetch-us-snapshot.mjs
 *
 * No API keys: ERCOT's fuel-mix dashboard JSON carries yesterday AND today
 * (5-min, Central time); NYISO publishes dated real-time fuel-mix CSVs
 * (5-min, Eastern). Together ≈ a third of US generation. Mix-only — no US
 * ISO publishes per-plant output openly (the map's dots stay capacity-sized,
 * like the Nordics). Emits us.json in the ENTSO-E snapshot shape.
 * CAISO blocks non-browser fetches and MISO retired its public API — later.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  UA,
  accAdd,
  accKeys,
  accMeanSeries,
  buildMixRows,
  compactDate,
  isoDaysAgo,
  makeHourlyAcc,
  meanCovered,
  throughHour,
} from './snapshot-common.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'live')

/** ISO fuel label → snapshot bucket (labels/colours come from BUCKET_META). */
export const FUEL_KEY = {
  // ERCOT
  'Coal and Lignite': 'coal',
  'Natural Gas': 'gas',
  Nuclear: 'nuclear',
  Hydro: 'hydro',
  Solar: 'solar',
  Wind: 'wind',
  'Power Storage': 'other',
  Other: 'other',
  // NYISO
  'Dual Fuel': 'gas',
  'Other Fossil Fuels': 'other',
  'Other Renewables': 'biomass',
}

/** finalize an accumulator → Map<bucket, hourly-average series> */
const accToSeriesMap = (acc) => new Map(accKeys(acc).map((k) => [k, accMeanSeries(acc, k)]))

// ------------------------------------------------------------------ ERCOT
/**
 * fuel-mix dashboard JSON → { [isoDate]: Map<bucket, hourlySeries> }.
 * Throws when the document shape changed (#51) — a broken feed should fail
 * loudly, not bake an empty snapshot.
 */
export function parseErcot(doc) {
  if (!doc?.data || typeof doc.data !== 'object') {
    throw new Error('ERCOT fuel-mix JSON shape changed (no data object)')
  }
  const days = {}
  for (const [date, points] of Object.entries(doc.data)) {
    if (!points || typeof points !== 'object') continue
    const acc = makeHourlyAcc()
    for (const [ts, fuels] of Object.entries(points)) {
      if (!fuels || typeof fuels !== 'object') continue
      const hour = parseInt(ts.slice(11, 13), 10) // ERCOT-local hour
      for (const [fuel, v] of Object.entries(fuels)) {
        const key = FUEL_KEY[fuel]
        if (key) accAdd(acc, key, hour, v?.gen)
      }
    }
    days[date] = accToSeriesMap(acc)
  }
  return days
}

async function fetchErcot() {
  const res = await fetch('https://www.ercot.com/api/1/services/read/dashboards/fuel-mix.json', {
    headers: UA,
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`ERCOT ${res.status}`)
  return parseErcot(await res.json())
}

// ------------------------------------------------------------------ NYISO
/**
 * One dated rtfuelmix CSV → Map<bucket, hourlySeries>. Columns are located
 * by header name, not position (#51) — NYISO reordering columns must not
 * silently misread MW as fuel names.
 */
export function parseNyisoCsv(text) {
  const lines = text.split('\n')
  const header = (lines[0] ?? '')
    .split(',')
    .map((c) => c.replace(/^"|"$/g, '').trim().toLowerCase())
  const iTime = header.findIndex((h) => h.includes('time stamp'))
  const iFuel = header.findIndex((h) => h.includes('fuel'))
  const iMW = header.findIndex((h) => h.includes('mw'))
  if (iTime < 0 || iFuel < 0 || iMW < 0) {
    throw new Error(`NYISO rtfuelmix header changed: "${lines[0]}"`)
  }
  const acc = makeHourlyAcc()
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map((c) => c.replace(/^"|"$/g, '').trim())
    if (cols.length <= Math.max(iTime, iFuel, iMW)) continue
    const hour = parseInt(cols[iTime].slice(11, 13), 10) // "MM/DD/YYYY HH:mm:ss"
    const key = FUEL_KEY[cols[iFuel]]
    const mw = parseFloat(cols[iMW])
    if (key) accAdd(acc, key, hour, mw)
  }
  return accToSeriesMap(acc)
}

async function fetchNyiso(dateCompact) {
  const url = `https://mis.nyiso.com/public/csv/rtfuelmix/${dateCompact}rtfuelmix.csv`
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`NYISO ${res.status} for ${url}`)
  return parseNyisoCsv(await res.text())
}

// ------------------------------------------------------------- aggregate
/** Sum per-ISO bucket series; a slot is non-null when EVERY ISO covers it,
 *  so the today-so-far total never dips as feeds update out of step.
 *  Callers must drop dead ISOs (no data at all) first — an all-null member
 *  would veto every hour. */
export function combine(isoSeries) {
  const keys = new Set(isoSeries.flatMap((m) => [...m.keys()]))
  const combined = {}
  for (const key of keys) {
    combined[key] = new Array(24).fill(null).map((_, h) => {
      let sum = 0
      for (const m of isoSeries) {
        const v = m.get(key)?.[h]
        if (v != null) sum += v
      }
      const everyIsoHasHour = isoSeries.every((m) =>
        [...m.values()].some((series) => series[h] != null),
      )
      return everyIsoHasHour ? Math.round(sum) : null
    })
  }
  return combined
}

/** combined mixSeries → sorted MixRow[] (positive day-averages only). */
export function rowsFrom(mixSeries) {
  const bucketAvg = new Map()
  for (const [key, series] of Object.entries(mixSeries)) {
    const avg = meanCovered(series)
    if (avg > 0) bucketAvg.set(key, avg)
  }
  return buildMixRows(bucketAvg).rows
}

/** An ISO's series map counts as data when any slot is non-null. */
const hasData = (m) => m != null && [...m.values()].some((s) => s.some((v) => v != null))

// ------------------------------------------------------------------- main
async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const yesterday = isoDaysAgo(1)
  const todayDate = isoDaysAgo(0)

  // NYISO is best-effort (#50): a missing/empty CSV degrades the snapshot
  // to ERCOT-only with an honest sourceLabel instead of exiting non-zero.
  const [ercotDays, nyYesterdayRaw, nyTodayRaw] = await Promise.all([
    fetchErcot(),
    fetchNyiso(compactDate(yesterday)).catch(() => null),
    fetchNyiso(compactDate(todayDate)).catch(() => null),
  ])

  if (!ercotDays[yesterday]) throw new Error(`ERCOT has no data for ${yesterday}`)
  const nyOk = hasData(nyYesterdayRaw)
  const meteredSeries = combine([ercotDays[yesterday], ...(nyOk ? [nyYesterdayRaw] : [])])
  const meteredRows = rowsFrom(meteredSeries)
  const meteredTotal = meteredRows.reduce((a, r) => a + r.nowMW, 0)
  const sourceLabel = nyOk ? 'ERCOT + NYISO' : 'ERCOT'

  // Today must aggregate the same ISO set as the metered day, or the
  // today-so-far total would jump against yesterday's basis.
  let today = null
  if (ercotDays[todayDate] && (!nyOk || hasData(nyTodayRaw))) {
    const s = combine([ercotDays[todayDate], ...(nyOk ? [nyTodayRaw] : [])])
    const rows = rowsFrom(s)
    const through = throughHour(s)
    if (through >= 3) {
      today = {
        date: todayDate,
        throughHour: through,
        mixRows: rows,
        mixSeries: s,
        importSeries: new Array(24).fill(null),
        totalMW: rows.reduce((a, r) => a + r.nowMW, 0),
        importMW: 0,
        prices: null,
      }
    }
  }

  const snapshot = {
    version: 1,
    basis: 'entsoe', // same client contract as the European snapshots
    sourceLabel,
    date: yesterday,
    generatedAt: new Date().toISOString(),
    perStation: {}, // no US ISO publishes per-plant output openly
    mixRows: meteredRows,
    mixSeries: meteredSeries,
    flowSeries: {},
    importSeries: new Array(24).fill(null),
    prices: null,
    today,
    mix: {
      time: `${yesterday}T12:00:00Z`,
      fuels: meteredRows.map((r) => ({ key: r.key, label: r.label, mw: r.nowMW })),
      interconnectors: {},
      totalMW: meteredTotal,
      importMW: 0,
    },
  }
  writeFileSync(join(OUT_DIR, 'us.json'), JSON.stringify(snapshot))
  console.log(
    `us: metered ${yesterday} · mix ${Math.round(meteredTotal / 100) / 10} GW avg (${sourceLabel})${
      today ? ` · today through ${String(today.throughHour).padStart(2, '0')}:00` : ''
    }`,
  )
}

// Import-safe for tests: only run when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
