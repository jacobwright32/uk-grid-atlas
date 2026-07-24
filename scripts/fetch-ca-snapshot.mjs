/**
 * fetch-ca-snapshot.mjs — Canada live phase 1: Ontario via IESO.
 *
 *   node scripts/fetch-ca-snapshot.mjs
 *
 * IESO publishes a public, key-less Generator Output and Capability report:
 * per-generator hourly MW for the whole market day (XML, versioned per day).
 * The latest complete day becomes the scrubbable metered day (walking back a
 * few days when publication lags); today's partial file becomes the
 * today-so-far mix — the same shape as the European ENTSO-E snapshots, so
 * the client needs no new code paths.
 * Alberta (AESO) and Québec (HQ) don't publish per-plant series — phase 2.
 *
 * Unit → station mapping reuses the ENTSO-E machinery: IESO names are
 * stemmed ("BRUCEA-G1" → "bruce a"), fuzzy-matched against OSM station
 * names, with hand overrides in data/entsoe-maps/ca-overrides.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { jaccard, stemTokens, tokens } from './live-matching.mjs'
import {
  UA,
  accAdd,
  accKeys,
  accSumSeries,
  asArray,
  buildMixRows,
  buildStationDay,
  compactDate,
  isoDaysAgo,
  makeHourlyAcc,
  makeXmlParser,
  meanCovered,
  throughHour,
} from './snapshot-common.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, 'public', 'live')
const MAP_DIR = join(ROOT, 'data', 'entsoe-maps')

const BASE = 'https://reports-public.ieso.ca/public/GenOutputCapability'
const parser = makeXmlParser()

/** IESO fuel → station fuel groups it may match. */
export const FUEL_COMPAT = {
  NUCLEAR: ['nuclear'],
  GAS: ['gas', 'oil'],
  HYDRO: ['hydro', 'pumped'],
  WIND: ['wind_onshore', 'wind_offshore'],
  SOLAR: ['solar'],
  BIOFUEL: ['bioenergy', 'waste'],
  OTHER: ['other', 'gas', 'oil', 'storage', 'bioenergy'],
}

/** IESO fuel → snapshot mix bucket (labels/colours come from BUCKET_META). */
export const FUEL_KEY = {
  NUCLEAR: 'nuclear',
  GAS: 'gas',
  HYDRO: 'hydro',
  WIND: 'wind',
  SOLAR: 'solar',
  BIOFUEL: 'biomass',
  OTHER: 'other',
}

/**
 * "BRUCEA-G1" → "bruce a" · "HARMON-G2" → "harmon" · "PORTDOVER" stays.
 * Strips unit designators, then splits a trailing station letter (A/B)
 * so "BRUCEA"/"BRUCEB" both stem to "bruce".
 */
export function stationStem(genName) {
  let s = genName.toLowerCase()
  s = s.replace(/[-_ ]?(g|u|unit|t|tg|lt)\.?\d+[a-z]?$/i, '')
  s = s.replace(/([a-z]{4,})([ab])$/, '$1 $2')
  return s.trim()
}

async function fetchDay(dateCompact) {
  const url = dateCompact
    ? `${BASE}/PUB_GenOutputCapability_${dateCompact}.xml`
    : `${BASE}/PUB_GenOutputCapability.xml`
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`IESO ${res.status} for ${url}`)
  const doc = parser.parse(await res.text())
  const body = doc?.IMODocument?.IMODocBody
  if (!body) throw new Error('unexpected IESO document shape')
  const date = body.Date
  const gens = []
  for (const g of asArray(body.Generators?.Generator)) {
    const series = new Array(24).fill(null)
    for (const o of asArray(g.Outputs?.Output)) {
      const h = parseInt(o.Hour, 10)
      const mw = parseFloat(o.EnergyMW)
      if (h >= 1 && h <= 24 && Number.isFinite(mw)) series[h - 1] = mw
    }
    gens.push({ name: String(g.GeneratorName ?? ''), fuel: String(g.FuelType ?? 'OTHER'), series })
  }
  return { date, gens }
}

// ------------------------------------------------------------------- main
async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  // ------------------------------------------------- station name matching
  const stations = JSON.parse(
    readFileSync(join(ROOT, 'src', 'data', 'ca', 'stations.json'), 'utf8'),
  ).features
  const index = stations
    .filter((f) => f.properties.name !== 'Unnamed site')
    .map((f) => ({
      id: f.properties.id,
      fuel: f.properties.fuel,
      toks: tokens(f.properties.name),
    }))
  const overridesPath = join(MAP_DIR, 'ca-overrides.json')
  const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {}

  const matchCache = new Map()
  const unmatched = new Map()
  function matchStation(gen) {
    const stem = stationStem(gen.name)
    if (overrides[stem]) return overrides[stem]
    if (matchCache.has(stem)) return matchCache.get(stem)
    const compat = FUEL_COMPAT[gen.fuel] ?? FUEL_COMPAT.OTHER
    const genToks = stemTokens(tokens(stem))
    let best = null
    for (const st of index) {
      if (!compat.includes(st.fuel)) continue
      const score = jaccard(genToks, st.toks)
      if (score >= 0.5 && (!best || score > best.score)) best = { id: st.id, score }
    }
    const id = best?.id ?? null
    matchCache.set(stem, id)
    return id
  }

  function aggregate(dayData) {
    const byStation = new Map()
    const mixAcc = makeHourlyAcc()
    for (const gen of dayData.gens) {
      const bucket = FUEL_KEY[gen.fuel] ?? FUEL_KEY.OTHER
      gen.series.forEach((mw, h) => {
        if (mw == null) return
        accAdd(mixAcc, bucket, h, mw)
      })
      const stationId = matchStation(gen)
      if (!stationId) {
        const stem = stationStem(gen.name)
        const peak = Math.max(...gen.series.map((v) => v ?? 0), 0)
        unmatched.set(stem, Math.max(unmatched.get(stem) ?? 0, peak))
        continue
      }
      let s = byStation.get(stationId)
      if (!s) {
        s = new Array(24).fill(null)
        byStation.set(stationId, s)
      }
      gen.series.forEach((mw, h) => {
        if (mw == null) return
        s[h] = (s[h] ?? 0) + mw
      })
    }

    const perStation = {}
    for (const [id, series] of byStation) {
      const d = buildStationDay(series)
      if (d) perStation[id] = d
    }

    const mixSeries = {}
    const bucketAvg = new Map()
    for (const key of accKeys(mixAcc)) {
      const series = accSumSeries(mixAcc, key).map((v) => (v == null ? null : Math.round(v)))
      if (!series.some((v) => v != null && v > 0)) continue
      mixSeries[key] = series
      bucketAvg.set(key, meanCovered(series))
    }
    const { rows: mixRows, totalMW } = buildMixRows(bucketAvg)
    return { perStation, mixSeries, mixRows, totalMW, throughHour: throughHour(mixSeries) }
  }

  // ----------------------------------------------------------------- build
  // Metered day: walk back a few days — IESO occasionally lags the dated
  // report, and one missing morning shouldn't kill the whole snapshot (#50).
  let metered = null
  let lastErr = null
  for (let back = 1; back <= 4 && !metered; back++) {
    try {
      metered = await fetchDay(compactDate(isoDaysAgo(back)))
    } catch (err) {
      lastErr = err
    }
  }
  if (!metered) throw lastErr ?? new Error('IESO: no metered day found')

  // Today is best-effort (#50): the current-day file failing to parse or
  // fetch should degrade to a metered-only snapshot, not exit non-zero.
  const todayData = await fetchDay(null).catch(() => null)

  const m = aggregate(metered)
  const t = todayData && todayData.date !== metered.date ? aggregate(todayData) : null

  const snapshot = {
    version: 1,
    basis: 'entsoe', // same client contract as the European snapshots
    sourceLabel: 'IESO',
    date: metered.date,
    generatedAt: new Date().toISOString(),
    perStation: m.perStation,
    mixRows: m.mixRows,
    mixSeries: m.mixSeries,
    flowSeries: {},
    importSeries: new Array(24).fill(null),
    prices: null,
    today:
      t && t.throughHour >= 3
        ? {
            date: todayData.date,
            throughHour: t.throughHour,
            mixRows: t.mixRows,
            mixSeries: t.mixSeries,
            importSeries: new Array(24).fill(null),
            totalMW: t.totalMW,
            importMW: 0,
            prices: null,
          }
        : null,
    mix: {
      time: `${metered.date}T12:00:00Z`,
      fuels: m.mixRows.map((r) => ({ key: r.key, label: r.label, mw: r.nowMW })),
      interconnectors: {},
      totalMW: m.totalMW,
      importMW: 0,
    },
  }
  writeFileSync(join(OUT_DIR, 'ca.json'), JSON.stringify(snapshot))

  const topUnmatched = [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  console.log(
    `ca: metered ${metered.date} · ${Object.keys(m.perStation).length} stations · mix ${
      Math.round(m.totalMW / 100) / 10
    } GW avg${t ? ` · today through ${String(t.throughHour).padStart(2, '0')}:00` : ' · no today file'}`,
  )
  if (topUnmatched.length) {
    console.log('unmatched (stem → peak MW):')
    for (const [stem, mw] of topUnmatched) console.log(`  ${stem} — ${Math.round(mw)}`)
  }
}

// Import-safe for tests: only run when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
