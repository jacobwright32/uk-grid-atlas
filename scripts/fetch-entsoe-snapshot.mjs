/**
 * fetch-entsoe-snapshot.mjs — bake per-country European live snapshots.
 *
 *   ENTSOE_TOKEN=... node scripts/fetch-entsoe-snapshot.mjs [cc|all]
 *
 * For each country: finds the latest day with per-unit data (A73), maps
 * units to map stations (registry from A71 + fuzzy name matching, cached in
 * data/entsoe-maps/<cc>.json), and writes public/live/<cc>.json with
 * per-station day series, the daily generation mix, and HVDC border flows.
 * Run by .github/workflows/live-snapshots.yml on a schedule.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENTSOE_COUNTRIES,
  EntsoeClient,
  FLOW_BORDERS,
  PSR_BUCKETS,
  PSR_COMPAT,
  dayWindow,
  parsePriceSeries,
  parseSeries,
  stationDayFromSeries,
} from './entsoe.mjs'
import { INTERCONNECTORS } from './interconnectors.mjs'
import { jaccard, stemTokens, tokens } from './live-matching.mjs'
import {
  accAdd,
  accKeys,
  accMeanSeries,
  accSumSeries,
  buildMixRows,
  hourOfPosition,
  isoDaysAgo,
  makeHourlyAcc,
  meanCovered,
  throughHour,
} from './snapshot-common.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, 'public', 'live')
const MAP_DIR = join(ROOT, 'data', 'entsoe-maps')
mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(MAP_DIR, { recursive: true })

const token = process.env.ENTSOE_TOKEN
if (!token) {
  console.log('ENTSOE_TOKEN not set — skipping European snapshots (nothing to do).')
  process.exit(0)
}
const client = new EntsoeClient(token)

const target = process.argv[2] ?? 'all'
const countryIds = target === 'all' ? Object.keys(ENTSOE_COUNTRIES) : [target]

// --------------------------------------------------- unit → station mapping
function stationIndexFor(cc) {
  const stations = JSON.parse(
    readFileSync(join(ROOT, 'src', 'data', cc, 'stations.json'), 'utf8'),
  ).features
  return stations
    .filter((f) => f.properties.name !== 'Unnamed site')
    .map((f) => ({ id: f.properties.id, fuel: f.properties.fuel, toks: tokens(f.properties.name) }))
}

function overridesFor(cc) {
  const overridesPath = join(MAP_DIR, `${cc}-overrides.json`)
  return existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {}
}

function matchByName(index, name, psrType) {
  const compat = PSR_COMPAT[psrType] ?? PSR_COMPAT.B20
  const unitToks = tokens(name)
  const stem = stemTokens(unitToks)
  let best = null
  for (const st of index) {
    if (!compat.includes(st.fuel)) continue
    const score = Math.max(jaccard(unitToks, st.toks), jaccard(stem, st.toks))
    if (score >= 0.5 && (!best || score > best.score)) best = { id: st.id, score }
  }
  return best?.id ?? null
}

function buildUnitMap(index, overrides, units) {
  const byUnit = {}
  const unmatched = []
  for (const u of units) {
    if (!u.unitEic || !u.unitName) continue
    const id = overrides[u.unitEic] ?? matchByName(index, u.unitName, u.psrType)
    if (id) byUnit[u.unitEic] = id
    else unmatched.push(u)
  }
  unmatched.sort((a, b) => (b.nominalP ?? 0) - (a.nominalP ?? 0))
  return { byUnit, unmatched }
}

// ------------------------------------------------------- mix + flows fetch
/**
 * One day's A75 mix + A11 flows as hourly series, with day averages taken
 * over the covered hours — so a partial (intraday) day averages correctly.
 */
async function fetchMixAndFlows(cc, cfg, day) {
  // Energy-weighted hourly accumulator: portion = stepMin/60, so four
  // quarter-hour points average into one hourly MW figure.
  const mixAcc = makeHourlyAcc()
  for (const domain of cfg.mixDomains) {
    const doc = await client.get({
      documentType: 'A75',
      processType: 'A16',
      in_Domain: domain,
      ...dayWindow(day),
    })
    for (const s of parseSeries(doc ?? {})) {
      if (s.outDomain && !s.inDomain) continue // consumption (pumping) series
      const bucket = PSR_BUCKETS[s.psrType]
      if (!bucket) continue
      const portion = s.stepMin / 60
      for (const p of s.points) {
        accAdd(mixAcc, bucket[0], hourOfPosition(p.position, s.stepMin), p.mw, portion)
      }
    }
  }
  const mixSeries = {}
  const bucketAvg = new Map()
  let hoursCovered = 0
  for (const key of accKeys(mixAcc)) {
    const series = accSumSeries(mixAcc, key).map((v) =>
      v == null ? null : Math.round(Math.max(0, v)),
    )
    mixSeries[key] = series
    bucketAvg.set(key, meanCovered(series))
    hoursCovered = Math.max(hoursCovered, series.filter((v) => v != null).length)
  }

  const flows = {}
  const flowSeries = {}
  const importSeries = new Array(24).fill(null)
  // This country's own control/bidding zones — used to orient shared borders.
  const ownDomains = new Set([...cfg.unitDomains, ...cfg.mixDomains])
  for (const border of FLOW_BORDERS.filter((b) => b.countries.includes(cc))) {
    const [home, away] = border.pair
    // Normalize signs per page country (#43): + always = import INTO cc.
    // Shared borders list pair[0] of ONE side — flip when that isn't us
    // (pre-fix, Fenno-Skan on #fi showed Sweden's perspective: imports
    // counted as exports and vice versa).
    const flip = ownDomains.has(home) ? 1 : -1
    const netHours = new Array(24).fill(null)
    for (const [outD, inD, sign] of [
      [away, home, +flip],
      [home, away, -flip],
    ]) {
      const doc = await client.get({
        documentType: 'A11',
        out_Domain: outD,
        in_Domain: inD,
        ...dayWindow(day),
      })
      for (const s of parseSeries(doc ?? {})) {
        const perHour = 60 / s.stepMin
        for (const p of s.points) {
          const hour = hourOfPosition(p.position, s.stepMin)
          if (hour < 0 || hour > 23 || !Number.isFinite(p.mw)) continue
          netHours[hour] = (netHours[hour] ?? 0) + (sign * p.mw) / perHour
        }
      }
    }
    const net = meanCovered(netHours)
    const links = border.links
      .map((id) => INTERCONNECTORS.find((ic) => ic.id === id))
      .filter(Boolean)
    const capSum = links.reduce((a, l) => a + l.capMW, 0) || 1
    for (const link of links) {
      flows[link.id] = Math.round((net * link.capMW) / capSum)
      flowSeries[link.id] = netHours.map((v) =>
        v == null ? null : Math.round((v * link.capMW) / capSum),
      )
    }
    for (let h = 0; h < 24; h++) {
      if (netHours[h] != null) importSeries[h] = (importSeries[h] ?? 0) + Math.max(0, netHours[h])
    }
  }
  for (let h = 0; h < 24; h++) {
    if (importSeries[h] != null) importSeries[h] = Math.round(importSeries[h])
  }
  const importMW = meanCovered(importSeries)
  const { rows: mixRows, totalMW } = buildMixRows(bucketAvg, importMW)

  return { mixSeries, flows, flowSeries, importSeries, importMW, mixRows, totalMW, hoursCovered }
}

/**
 * Day-ahead prices (A44) for one day, averaged across the country's bidding
 * zones per hour. Multi-currency countries keep the majority currency's
 * zones. Returns { currency, series[24], zones } or null when unpublished.
 */
async function fetchPrices(cfg, day) {
  const domains = cfg.priceDomains ?? cfg.mixDomains
  const perZone = []
  for (const domain of domains) {
    const doc = await client.get({
      documentType: 'A44',
      'contract_MarketAgreement.type': 'A01',
      in_Domain: domain,
      out_Domain: domain,
      ...dayWindow(day),
    })
    const acc = makeHourlyAcc()
    let currency = null
    for (const s of parsePriceSeries(doc ?? {})) {
      currency ??= s.currency
      for (const p of s.points) {
        accAdd(acc, 'price', hourOfPosition(p.position, s.stepMin), p.price)
      }
    }
    const series = accMeanSeries(acc, 'price')
    if (!currency || !series) continue
    perZone.push({ currency, series })
  }
  if (!perZone.length) return null
  const byCurrency = new Map()
  for (const z of perZone) byCurrency.set(z.currency, (byCurrency.get(z.currency) ?? 0) + 1)
  const currency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0][0]
  const zones = perZone.filter((z) => z.currency === currency)
  const series = new Array(24).fill(null).map((_, h) => {
    let sum = 0
    let n = 0
    for (const z of zones) {
      const v = z.series[h]
      if (v == null) continue
      sum += v
      n++
    }
    return n ? Math.round((sum / n) * 100) / 100 : null
  })
  return { currency, series, zones: zones.length }
}

// --------------------------------------------------------------- main loop
for (const cc of countryIds) {
  const cfg = ENTSOE_COUNTRIES[cc]
  if (!cfg) {
    console.error(`unknown country ${cc}`)
    continue
  }
  console.log(`\n=== ${cc.toUpperCase()} ===`)
  try {
    const index = stationIndexFor(cc)
    const overrides = overridesFor(cc)

    // 1. Unit registry (A71) — cached, refreshed when older than ~30 days.
    const mapPath = join(MAP_DIR, `${cc}.json`)
    let registry = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf8')) : null
    const stale =
      !registry || Date.now() - Date.parse(registry.builtAt ?? 0) > 30 * 24 * 3600 * 1000
    if (stale) {
      const units = []
      for (const domain of cfg.unitDomains) {
        const doc = await client.get({
          documentType: 'A71',
          processType: 'A33',
          in_Domain: domain,
          ...dayWindow(isoDaysAgo(3)),
        })
        for (const s of parseSeries(doc ?? {})) {
          if (s.unitEic) units.push(s)
        }
      }
      const { byUnit, unmatched } = buildUnitMap(index, overrides, units)
      registry = {
        builtAt: new Date().toISOString(),
        unitCount: units.length,
        byUnit,
        unmatchedTop: unmatched.slice(0, 20).map((u) => ({
          eic: u.unitEic,
          name: u.unitName,
          psr: u.psrType,
          mw: u.nominalP,
        })),
      }
      writeFileSync(mapPath, JSON.stringify(registry, null, 1))
      console.log(
        `unit map: ${Object.keys(byUnit).length}/${units.length} matched (${unmatched.length} unmatched — see ${cc}.json unmatchedTop)`,
      )
    }

    // 2. Latest day with per-unit actuals (A73), walking back up to 14 days.
    let day = null
    let unitSeries = []
    for (let back = 1; back <= 14 && !day; back++) {
      const candidate = isoDaysAgo(back)
      const collected = []
      for (const domain of cfg.unitDomains) {
        const doc = await client.get({
          documentType: 'A73',
          processType: 'A16',
          in_Domain: domain,
          ...dayWindow(candidate),
        })
        if (doc) collected.push(...parseSeries(doc))
      }
      if (collected.length) {
        day = candidate
        unitSeries = collected
      }
    }
    if (!day) {
      // Nordic TSOs publish little/no per-unit A73 — fall back to a
      // mix-only snapshot so the country still gets its generation mix.
      console.warn(`${cc}: no A73 data in lookback window — writing mix-only snapshot`)
      day = isoDaysAgo(1)
      unitSeries = []
    }

    // 3. Aggregate unit series → stations. Units missing from the A71
    // registry (common for hydro fleets) are matched here by their A73
    // name; hits are persisted into the registry for future runs.
    const byStation = new Map()
    let unmappedMW = 0
    let registryDirty = false
    for (const s of unitSeries) {
      // Overrides outrank the cached registry, so a hand-mapping added after
      // a wrong fuzzy match takes effect immediately (not at the 30d rebuild).
      let stationId = overrides[s.unitEic] ?? registry.byUnit[s.unitEic] ?? null
      if (!stationId && s.unitName) {
        stationId = matchByName(index, s.unitName, s.psrType)
      }
      if (stationId && registry.byUnit[s.unitEic] !== stationId) {
        registry.byUnit[s.unitEic] = stationId
        registryDirty = true
      }
      if (!stationId) {
        unmappedMW += Math.max(...s.points.map((p) => p.mw), 0)
        continue
      }
      if (!byStation.has(stationId)) byStation.set(stationId, [])
      byStation.get(stationId).push(s)
    }
    if (registryDirty) writeFileSync(mapPath, JSON.stringify(registry, null, 1))
    const perStation = {}
    for (const [stationId, list] of byStation) {
      const d = stationDayFromSeries(list)
      if (d) perStation[stationId] = d
    }

    // 4+5. Mix (A75) + border flows (A11) for the metered day: hourly series
    // (#17 scrub) and day averages derived from them. The same fetch runs
    // again for today's partial day (#18 intraday, below).
    const { mixSeries, flows, flowSeries, importSeries, importMW, mixRows, totalMW } =
      await fetchMixAndFlows(cc, cfg, day)
    const prices = await fetchPrices(cfg, day).catch(() => null)

    // 6. Intraday (#18): today's partial mix, when the TSO has published
    // at least a few hours. Shown as the default strip; the metered day
    // above stays the scrub/station basis.
    let today = null
    const todayDate = isoDaysAgo(0)
    if (todayDate !== day) {
      try {
        const t = await fetchMixAndFlows(cc, cfg, todayDate)
        if (t.hoursCovered >= 3) {
          const todayPrices = await fetchPrices(cfg, todayDate).catch(() => null)
          today = {
            date: todayDate,
            prices: todayPrices,
            throughHour: throughHour(t.mixSeries),
            mixRows: t.mixRows,
            mixSeries: t.mixSeries,
            importSeries: t.importSeries,
            totalMW: t.totalMW,
            importMW: Math.round(t.importMW),
          }
        }
      } catch {
        // intraday is best-effort — the snapshot is complete without it
      }
    }

    const snapshot = {
      version: 1,
      basis: 'entsoe',
      date: day,
      generatedAt: new Date().toISOString(),
      perStation,
      mixRows,
      mixSeries,
      flowSeries,
      importSeries,
      prices,
      today,
      mix: {
        time: `${day}T12:00:00Z`,
        fuels: mixRows
          .filter((r) => r.key !== 'imports')
          .map((r) => ({ key: r.key, label: r.label, mw: r.nowMW })),
        interconnectors: flows,
        totalMW,
        importMW: Math.round(importMW),
      },
    }
    writeFileSync(join(OUT_DIR, `${cc}.json`), JSON.stringify(snapshot))
    console.log(
      `${cc}: day ${day} · ${Object.keys(perStation).length} stations · mix ${
        Math.round(totalMW / 100) / 10
      } GW avg · ${Object.keys(flows).length} link flows · unmapped peak ${Math.round(unmappedMW)} MW${
        today ? ` · today through ${String(today.throughHour).padStart(2, '0')}:00` : ''
      }`,
    )
  } catch (err) {
    console.error(`${cc} failed:`, err.message)
    process.exitCode = 1
  }
}
