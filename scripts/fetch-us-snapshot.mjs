/**
 * fetch-us-snapshot.mjs — US live phase 1: ERCOT + NYISO public fuel mixes.
 *
 *   node scripts/fetch-us-snapshot.mjs
 *
 * No API keys: ERCOT's fuel-mix dashboard JSON carries yesterday AND today
 * (5-min, Central time); NYISO publishes dated real-time fuel-mix CSVs
 * (5-min, Eastern). Together ≈ a third of US generation. No per-plant
 * output — no US ISO publishes it openly (dots stay capacity-sized, like
 * the Nordics) — but day-ahead prices ride along (#99): ERCOT's HB_HUBAVG
 * from the dated DAM CDR report + NYISO's zone LBMP CSV, averaged, USD.
 * Emits us.json in the ENTSO-E snapshot shape.
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
  buildDayRecord,
  buildMixRows,
  compactDate,
  historyDates,
  hourlyDates,
  hoursCovered,
  isoDaysAgo,
  makeHourlyAcc,
  meanCovered,
  mergeHistory,
  patchHistoryDay,
  patchHistoryHour,
  priceAvg,
  readHistory,
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

// ------------------------------------------------------------------ prices
/**
 * ERCOT day-ahead settlement point prices (#99) — the dated CDR report at
 * ercot.com/content/cdr/html/<YYYYMMDD>_dam_spp.html, kept ~a week. The
 * HB_HUBAVG column is ERCOT's own hub average; header-located (#51) so a
 * reordered table fails loudly rather than misreading a load zone as the
 * hub. Returns a 24-slot USD/MWh series (hour ending 1 → slot 0), or null.
 */
export function parseErcotDamSpp(html) {
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []
  if (!rows.length) return null
  const cells = (tr) =>
    [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) =>
      m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim(),
    )
  const header = cells(rows[0])
  const iHour = header.findIndex((h) => /hour ending/i.test(h))
  const iHub = header.indexOf('HB_HUBAVG')
  if (iHour < 0 || iHub < 0) {
    throw new Error(`ERCOT dam_spp header changed: "${header.join(',')}"`)
  }
  const series = new Array(24).fill(null)
  for (const tr of rows.slice(1)) {
    const c = cells(tr)
    const he = parseInt(c[iHour], 10)
    const v = parseFloat(c[iHub])
    if (he >= 1 && he <= 24 && Number.isFinite(v)) series[he - 1] = v
  }
  return series.some((v) => v != null) ? series : null
}

async function fetchErcotDam(dateCompact) {
  const url = `https://www.ercot.com/content/cdr/html/${dateCompact}_dam_spp.html`
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`ERCOT DAM ${res.status} for ${url}`)
  return parseErcotDamSpp(await res.text())
}

/**
 * NYISO day-ahead zone LBMPs (#99) — the public dated CSV. Returns the
 * per-hour mean across the load zones plus how many zones contributed, or
 * null when the file is empty. Header-located columns (#51).
 */
export function parseNyisoDamCsv(text) {
  const lines = text.split('\n')
  const header = (lines[0] ?? '')
    .split(',')
    .map((c) => c.replace(/^"|"$/g, '').trim().toLowerCase())
  const iTime = header.findIndex((h) => h.includes('time stamp'))
  const iName = header.findIndex((h) => h === 'name')
  const iLbmp = header.findIndex((h) => h.startsWith('lbmp'))
  if (iTime < 0 || iName < 0 || iLbmp < 0) {
    throw new Error(`NYISO damlbmp header changed: "${lines[0]}"`)
  }
  const sums = new Array(24).fill(0)
  const counts = new Array(24).fill(0)
  const zones = new Set()
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map((c) => c.replace(/^"|"$/g, '').trim())
    if (cols.length <= Math.max(iTime, iName, iLbmp)) continue
    const hour = parseInt(cols[iTime].slice(11, 13), 10) // "MM/DD/YYYY HH:mm"
    const v = parseFloat(cols[iLbmp])
    if (!Number.isFinite(v) || hour < 0 || hour > 23) continue
    zones.add(cols[iName])
    sums[hour] += v
    counts[hour] += 1
  }
  if (!zones.size) return null
  const series = counts.map((n, h) => (n ? Math.round((sums[h] / n) * 100) / 100 : null))
  return { series, zones: zones.size }
}

async function fetchNyisoDam(dateCompact) {
  const url = `https://mis.nyiso.com/public/csv/damlbmp/${dateCompact}damlbmp_zone.csv`
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`NYISO DAM ${res.status} for ${url}`)
  return parseNyisoDamCsv(await res.text())
}

/**
 * One us price series from the two ISOs: NYISO's zones are averaged first,
 * then the two ISO figures averaged per hour — 15 small NY zones must not
 * outvote the one Texas hub 15:1. An hour one ISO hasn't priced still shows
 * the other (same as the EU zone-mean behaviour); `zones` counts every
 * underlying zone so the strip's "avg of N zones" stays honest.
 */
export function combinePrices(ercotSeries, nyiso) {
  if (!ercotSeries && !nyiso) return null
  const series = new Array(24).fill(null).map((_, h) => {
    const vals = []
    if (ercotSeries?.[h] != null) vals.push(ercotSeries[h])
    if (nyiso?.series[h] != null) vals.push(nyiso.series[h])
    if (!vals.length) return null
    return Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 100) / 100
  })
  if (!series.some((v) => v != null)) return null
  return { currency: 'USD', series, zones: (ercotSeries ? 1 : 0) + (nyiso?.zones ?? 0) }
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
  // Prices are best-effort too (#99) — day-ahead, so today's are fully known.
  const [ercotDays, nyYesterdayRaw, nyTodayRaw, damErY, damErT, damNyY, damNyT] =
    await Promise.all([
      fetchErcot(),
      fetchNyiso(compactDate(yesterday)).catch(() => null),
      fetchNyiso(compactDate(todayDate)).catch(() => null),
      fetchErcotDam(compactDate(yesterday)).catch(() => null),
      fetchErcotDam(compactDate(todayDate)).catch(() => null),
      fetchNyisoDam(compactDate(yesterday)).catch(() => null),
      fetchNyisoDam(compactDate(todayDate)).catch(() => null),
    ])
  const pricesYesterday = combinePrices(damErY, damNyY)
  const pricesToday = combinePrices(damErT, damNyT)

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
        prices: pricesToday,
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
    prices: pricesYesterday,
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

  // Rolling history: ERCOT's dashboard only exposes ~2 days, so the month
  // deepens one day per workflow run. A day is recorded only when BOTH ISOs
  // have it (an ERCOT-only day would read as a nationwide generation dip);
  // NYISO's archive is deep, so missed days heal on later runs.
  try {
    const histPath = join(OUT_DIR, 'history', 'us.json')
    const haveDay = new Set(historyDates(histPath))
    const haveHourly = new Set(hourlyDates(histPath))
    const nyCache = { [yesterday]: nyYesterdayRaw }
    const damCache = { [yesterday]: pricesYesterday }
    let added = 0
    for (const date of Object.keys(ercotDays).sort()) {
      // Re-record while a date is inside ERCOT's window if its hourly record
      // is missing or pre-dates the current schema (v2 wipe).
      if (date === todayDate || (haveDay.has(date) && haveHourly.has(date))) continue
      const ny =
        date in nyCache ? nyCache[date] : await fetchNyiso(compactDate(date)).catch(() => null)
      if (!hasData(ny)) continue
      const s = combine([ercotDays[date], ny])
      if (hoursCovered(s) < 20) continue
      const prices =
        date in damCache
          ? damCache[date]
          : combinePrices(
              await fetchErcotDam(compactDate(date)).catch(() => null),
              await fetchNyisoDam(compactDate(date)).catch(() => null),
            )
      mergeHistory(histPath, {
        currency: prices ? 'USD' : undefined,
        sourceLabel: 'ERCOT + NYISO',
        day: buildDayRecord(date, rowsFrom(s), null, priceAvg(prices?.series)),
        hourly: {
          date,
          mixSeries: s,
          importSeries: null,
          prices: prices?.series ?? null,
          perStation: null,
          flowSeries: null,
        },
      })
      added++
    }
    if (added) console.log(`us: history +${added} day(s)`)
    // One-off heal (#99): days recorded before prices existed get the DAM
    // average patched in while the ERCOT report (~a week) still has them.
    const needPrice = (readHistory(histPath)?.days ?? [])
      .filter((r) => r.price == null && r.date !== todayDate)
      .map((r) => r.date)
      .slice(-6)
    let priced = 0
    for (const date of needPrice) {
      const p = combinePrices(
        await fetchErcotDam(compactDate(date)).catch(() => null),
        await fetchNyisoDam(compactDate(date)).catch(() => null),
      )
      if (!p) continue
      if (patchHistoryDay(histPath, date, { price: priceAvg(p.series) })) priced++
      patchHistoryHour(histPath, date, { prices: p.series })
    }
    if (needPrice.length) console.log(`us: prices patched ${priced}/${needPrice.length}`)
    // The patch path bypasses mergeHistory, so the file-level currency a
    // fresh install reads must be set here too once any price exists.
    const healed = readHistory(histPath)
    if (healed && !healed.currency && healed.days.some((d) => d.price != null)) {
      healed.currency = 'USD'
      writeFileSync(histPath, JSON.stringify(healed))
    }
  } catch (err) {
    console.warn(`us: history failed — ${err.message}`)
  }

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
