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
  NET_BORDERS,
  PSR_BUCKETS,
  dayStartMs,
  dayWindow,
  expandSeries,
  matchByName,
  orientFlow,
  parsePriceSeries,
  parseSeries,
  stationDayFromSeries,
} from './entsoe.mjs'
import { INTERCONNECTORS } from './interconnectors.mjs'
import { tokens } from './live-matching.mjs'
import {
  accAdd,
  accKeys,
  accMeanSeries,
  accSumSeries,
  buildDayRecord,
  buildMixRows,
  carryToday,
  historyDates,
  hourlyDates,
  importAvg,
  isoDaysAgo,
  makeHourlyAcc,
  meanCovered,
  mergeHistory,
  meteredBasis,
  missingDates,
  priceAvg,
  patchHistoryDay,
  readHistory,
  stationSeriesOnly,
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

const target = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all'
// --intraday (#98): refresh only the today block + generatedAt of existing
// snapshots — ~4–20 requests per grid instead of ~50+, cheap enough to run
// hourly. INTRADAY_GRIDS (space/comma-separated) stages the rollout when the
// target is 'all'; a grid with no snapshot yet is skipped (full bakes create).
const intraday = process.argv.includes('--intraday')
const intradayGrids = (process.env.INTRADAY_GRIDS ?? '').split(/[\s,]+/).filter(Boolean)
const countryIds =
  target === 'all'
    ? intraday && intradayGrids.length
      ? intradayGrids
      : Object.keys(ENTSOE_COUNTRIES)
    : [target]
// --backfill N: one-off deep history fill (default window 7, catch-up cap 3)
const bfIdx = process.argv.indexOf('--backfill')
const backfillDays = bfIdx >= 0 ? Math.max(1, parseInt(process.argv[bfIdx + 1], 10) || 31) : null
// How far back to hunt for per-unit actuals. Overridable so the carry path
// (#106) can be exercised against a live feed without waiting for a TSO to
// fall off the end of the window.
const LOOKBACK_DAYS = Math.max(1, Number(process.env.A73_LOOKBACK_DAYS) || 14)

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

/** One day's per-unit actuals (A73) across the country's control areas. */
async function fetchUnitsDay(cfg, date) {
  const collected = []
  for (const domain of cfg.unitDomains) {
    const doc = await client.get({
      documentType: 'A73',
      processType: 'A16',
      in_Domain: domain,
      ...dayWindow(date),
    })
    if (doc) collected.push(...parseSeries(doc))
  }
  return collected
}

/**
 * Aggregate unit series → stations. Units missing from the A71 registry
 * (common for hydro fleets) are matched by their A73 name; hits are written
 * into the registry so future runs skip the fuzzy pass. Overrides outrank
 * the cached registry, so a hand-mapping added after a wrong fuzzy match
 * takes effect immediately (not at the 30-day rebuild).
 */
function stationsFromUnits(unitSeries, index, overrides, registry, day) {
  const byStation = new Map()
  let unmappedMW = 0
  let registryDirty = false
  for (const s of unitSeries) {
    let stationId = overrides[s.unitEic] ?? registry.byUnit[s.unitEic] ?? null
    if (!stationId && s.unitName) {
      stationId = matchByName(index, s.unitName, s.psrType)
    }
    if (stationId && s.unitEic && registry.byUnit[s.unitEic] !== stationId) {
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
  const perStation = {}
  for (const [stationId, list] of byStation) {
    const d = stationDayFromSeries(list, day ? dayStartMs(day) : null)
    if (d) perStation[stationId] = d
  }
  return { perStation, unmappedMW, registryDirty }
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
  const originMs = dayStartMs(day)
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
      for (const { hour, value } of expandSeries(s, originMs)) {
        accAdd(mixAcc, bucket[0], hour, value, portion)
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
    // Normalize signs per page country (#43): + always = import INTO cc —
    // extracted to orientFlow() and regression-tested (#57).
    const netHours = new Array(24).fill(null)
    for (const [outD, inD, sign] of orientFlow(border, ownDomains)) {
      const doc = await client.get({
        documentType: 'A11',
        out_Domain: outD,
        in_Domain: inD,
        ...dayWindow(day),
      })
      for (const s of parseSeries(doc ?? {})) {
        const perHour = 60 / s.stepMin
        for (const { hour, value } of expandSeries(s, originMs)) {
          netHours[hour] = (netHours[hour] ?? 0) + (sign * value) / perHour
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
  // Only grids with a FLOW_BORDERS entry actually measure anything here. For
  // the other eighteen, meanCovered over the untouched all-null series used to
  // come back 0 and put a hard "Imports (HVDC) 0 MW" row on screen — a claim
  // of zero trade where the truth is "not tracked". No coverage → null → no row.
  const measuresFlows = importSeries.some((v) => v != null)
  const importMW = measuresFlows ? meanCovered(importSeries) : null

  // Honest net position (#93): A11 summed over EVERY border of the zone, both
  // directions, signed — imports positive, exports negative. This is the
  // measured answer to the demand-vs-stack gap the strip has always drawn:
  // Croatia imports ~40% of demand, Bosnia exports ~60% of generation, and
  // until now the only cross-border figure on screen was an HVDC-shaped zero.
  let netImportSeries = null
  const neighbours = NET_BORDERS[cc]
  if (neighbours?.length) {
    const own = cfg.mixDomains[0]
    const acc = new Array(24).fill(null)
    for (const nbr of neighbours) {
      for (const [outD, inD, sign] of [
        [nbr, own, 1], // flow INTO cc → import
        [own, nbr, -1], // flow OUT of cc → export
      ]) {
        const doc = await client.get({
          documentType: 'A11',
          out_Domain: outD,
          in_Domain: inD,
          ...dayWindow(day),
        })
        for (const s of parseSeries(doc ?? {})) {
          const perHour = 60 / s.stepMin
          for (const { hour, value } of expandSeries(s, originMs)) {
            acc[hour] = (acc[hour] ?? 0) + (sign * value) / perHour
          }
        }
      }
    }
    if (acc.some((v) => v != null))
      netImportSeries = acc.map((v) => (v == null ? null : Math.round(v)))
  }
  const netImportMW = netImportSeries ? Math.round(meanCovered(netImportSeries)) : null

  const { rows: mixRows, totalMW } = buildMixRows(bucketAvg, netImportMW ?? importMW, {
    net: netImportMW != null,
  })

  return {
    mixSeries,
    flows,
    flowSeries,
    importSeries: measuresFlows ? importSeries : null,
    importMW,
    netImportSeries,
    netImportMW,
    mixRows,
    totalMW,
    hoursCovered,
  }
}

/**
 * Actual total load (A65) for one day, summed across the country's bidding
 * zones — the demand line the mix stacks against (#24). Null when the TSO
 * hasn't published.
 */
async function fetchDemandDay(cfg, day) {
  const acc = makeHourlyAcc()
  // Load lives on control areas, generation on bidding zones; they're the same
  // domain everywhere except Ireland. See ENTSOE_COUNTRIES.ie.
  for (const domain of cfg.loadDomains ?? cfg.mixDomains) {
    const doc = await client.get({
      documentType: 'A65',
      processType: 'A16',
      outBiddingZone_Domain: domain,
      ...dayWindow(day),
    })
    for (const s of parseSeries(doc ?? {})) {
      const portion = s.stepMin / 60
      for (const { hour, value } of expandSeries(s, dayStartMs(day))) {
        accAdd(acc, 'demand', hour, value, portion)
      }
    }
  }
  const series = accSumSeries(acc, 'demand')
  // Zero-valued hours are filing artifacts, not measurements — no
  // interconnected system has zero load (MEPSO files such zeros on days it
  // has not metered yet). Same rule as buildDayRecord's demand guard.
  const cleaned = series?.map((v) => (v == null || v <= 0 ? null : Math.round(v)))
  return cleaned?.some((v) => v != null) ? cleaned : null
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
      for (const { hour, value } of expandSeries(s, dayStartMs(day), 'price')) {
        accAdd(acc, 'price', hour, value)
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

// ---------------------------------------------------------------- history
/**
 * Record one final day into history/<cc>.json (week of hourly series with
 * per-station and per-link detail for the map scrub, month of daily
 * averages). `pre` passes the already-fetched metered day so the snapshot's
 * own fetches are reused; other days fetch their own A73 + A75 + A11 + A44.
 * Days covered less than 20 hours are left out — they stay "missing" and
 * the next run retries them once complete. `ctx` carries the unit-matching
 * machinery (station index, overrides, registry) for per-station series.
 */
async function recordHistoryDay(cc, cfg, histPath, date, ctx, pre = null) {
  const t = pre?.t ?? (await fetchMixAndFlows(cc, cfg, date))
  if (t.hoursCovered < 20) return false
  const p = pre ? pre.p : await fetchPrices(cfg, date).catch(() => null)
  const demand =
    pre?.demand !== undefined ? pre.demand : await fetchDemandDay(cfg, date).catch(() => null)
  let perStation = pre?.perStation ?? null
  if (!perStation && ctx) {
    const units = await fetchUnitsDay(cfg, date).catch(() => [])
    const r = stationsFromUnits(units, ctx.index, ctx.overrides, ctx.registry, date)
    perStation = r.perStation
    if (r.registryDirty) writeFileSync(ctx.mapPath, JSON.stringify(ctx.registry, null, 1))
  }
  mergeHistory(histPath, {
    currency: p?.currency ?? null,
    day: buildDayRecord(
      date,
      t.mixRows,
      // Net position when measured (#93) — signed, and finally matching the
      // Python package's documented import_mw semantics ("negative when
      // exporting"). HVDC-only gross imports remain the fallback.
      t.netImportMW ?? importAvg(t.importSeries),
      priceAvg(p?.series),
      demand ? meanCovered(demand) : null,
    ),
    hourly: {
      date,
      mixSeries: t.mixSeries,
      importSeries: t.importSeries?.some((v) => v != null) ? t.importSeries : null,
      netImportSeries: t.netImportSeries ?? null,
      prices: p?.series ?? null,
      perStation: stationSeriesOnly(perStation),
      flowSeries: Object.keys(t.flowSeries).length ? t.flowSeries : null,
      demand: demand ?? null,
    },
  })
  return true
}

/** The snapshot already on disk; null when absent or unreadable. */
function readSnapshot(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// --------------------------------------------------------------- main loop
for (const cc of countryIds) {
  const cfg = ENTSOE_COUNTRIES[cc]
  if (!cfg) {
    console.error(`unknown country ${cc}`)
    continue
  }
  console.log(`\n=== ${cc.toUpperCase()} ===`)
  const snapPath = join(OUT_DIR, `${cc}.json`)

  // Intraday tick (#98): today's headline numbers only. The metered day,
  // per-station detail and history belong to the full bake and are left
  // byte-identical; generatedAt bumps because the pipeline genuinely reran.
  if (intraday) {
    try {
      if (!existsSync(snapPath)) {
        console.log(`${cc}: no snapshot yet — full bake creates it, skipping`)
        continue
      }
      const snapshot = JSON.parse(readFileSync(snapPath, 'utf8'))
      const todayDate = isoDaysAgo(0)
      // A stale block from a previous calendar day must not survive under a
      // fresh timestamp (see carryToday).
      let today = carryToday(snapshot.today, todayDate)
      if (todayDate !== snapshot.date) {
        const t = await fetchMixAndFlows(cc, cfg, todayDate)
        if (t.hoursCovered >= 3) {
          const todayPrices = await fetchPrices(cfg, todayDate).catch(() => null)
          const todayDemand = await fetchDemandDay(cfg, todayDate).catch(() => null)
          today = {
            date: todayDate,
            prices: todayPrices,
            demandSeries: todayDemand,
            throughHour: throughHour(t.mixSeries),
            mixRows: t.mixRows,
            mixSeries: t.mixSeries,
            importSeries: t.importSeries,
            netImportSeries: t.netImportSeries,
            totalMW: t.totalMW,
            importMW: Math.round(t.netImportMW ?? t.importMW ?? 0),
          }
        }
      }
      snapshot.today = today
      snapshot.generatedAt = new Date().toISOString()
      writeFileSync(snapPath, JSON.stringify(snapshot))
      console.log(
        `${cc}: intraday ${
          today ? `through ${String(today.throughHour).padStart(2, '0')}:00` : 'too early (<3 h)'
        } · metered day ${snapshot.date} untouched`,
      )
    } catch (err) {
      console.error(`${cc} intraday failed:`, err.message)
      process.exitCode = 1
    }
    continue
  }

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

    // 2. Latest day with per-unit actuals (A73), walking back over the lookback
    //    window. `found` stays null when the TSO has published none of it.
    let found = null
    let unitSeries = []
    for (let back = 1; back <= LOOKBACK_DAYS && !found; back++) {
      const candidate = isoDaysAgo(back)
      const collected = await fetchUnitsDay(cfg, candidate)
      if (collected.length) {
        found = candidate
        unitSeries = collected
      }
    }

    // 3. Aggregate unit series → stations, then decide whether that basis beats
    // the one the file already has (#106, meteredBasis). A TSO that stops filing
    // A73 used to cost the grid its entire per-station set *and* move its date
    // forward to yesterday — data loss presented as freshness. A grid that has
    // never had A73 (several Nordic TSOs) has nothing to keep and still gets its
    // mix-only snapshot for yesterday.
    const yesterday = isoDaysAgo(1)
    const fresh = stationsFromUnits(unitSeries, index, overrides, registry, found ?? yesterday)
    if (fresh.registryDirty) writeFileSync(mapPath, JSON.stringify(registry, null, 1))
    const prevSnap = readSnapshot(snapPath)
    const basis = meteredBasis({
      found,
      foundStations: Object.keys(fresh.perStation).length,
      prev: prevSnap,
      fallbackDate: yesterday,
    })
    const day = basis.date
    const perStation = basis.carried ? prevSnap.perStation : fresh.perStation
    const unmappedMW = basis.carried ? 0 : fresh.unmappedMW
    if (basis.carried || found == null) console.warn(`${cc}: ${basis.reason}`)
    else console.log(`${cc}: ${basis.reason}`)

    // 4+5. Mix (A75) + border flows (A11) for the metered day: hourly series
    // (#17 scrub) and day averages derived from them. The same fetch runs
    // again for today's partial day (#18 intraday, below).
    const metered = await fetchMixAndFlows(cc, cfg, day)
    const {
      mixSeries,
      flows,
      flowSeries,
      importSeries,
      importMW,
      netImportSeries,
      netImportMW,
      mixRows,
      totalMW,
    } = metered
    const prices = await fetchPrices(cfg, day).catch(() => null)
    const demandSeries = await fetchDemandDay(cfg, day).catch(() => null)

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
          const todayDemand = await fetchDemandDay(cfg, todayDate).catch(() => null)
          today = {
            date: todayDate,
            prices: todayPrices,
            demandSeries: todayDemand,
            throughHour: throughHour(t.mixSeries),
            mixRows: t.mixRows,
            mixSeries: t.mixSeries,
            importSeries: t.importSeries,
            netImportSeries: t.netImportSeries,
            totalMW: t.totalMW,
            importMW: Math.round(t.netImportMW ?? t.importMW ?? 0),
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
      // #106: the per-station basis is older than this run could confirm — kept
      // deliberately rather than blanked, and said out loud so a frozen date is
      // never mistaken for a fresh measurement.
      ...(basis.carried ? { carriedBasis: { days: basis.ageDays, note: basis.reason } } : {}),
      perStation,
      mixRows,
      mixSeries,
      flowSeries,
      importSeries,
      netImportSeries,
      prices,
      demandSeries,
      today,
      mix: {
        time: `${day}T12:00:00Z`,
        fuels: mixRows
          .filter((r) => r.key !== 'imports')
          .map((r) => ({ key: r.key, label: r.label, mw: r.nowMW })),
        interconnectors: flows,
        totalMW,
        // Net position when measured (#93), signed; HVDC gross otherwise.
        importMW: Math.round(netImportMW ?? importMW ?? 0),
      },
    }
    writeFileSync(snapPath, JSON.stringify(snapshot))

    // 7. Rolling history: week of hourly series (with per-station/link
    // detail for the map scrub) + month of daily averages. The metered day
    // rides along free; the hourly window and any missing month days are
    // back-filled, capped per incremental run so the workflow stays quick.
    try {
      const histPath = join(OUT_DIR, 'history', `${cc}.json`)
      const ctx = { index, overrides, registry, mapPath }
      await recordHistoryDay(cc, cfg, histPath, day, ctx, {
        t: metered,
        p: prices,
        perStation,
        demand: demandSeries,
      })
      const hourlyWant = missingDates([...hourlyDates(histPath), day], 1, 7)
      const dailyWant = backfillDays
        ? missingDates([...historyDates(histPath), day], 8, backfillDays)
        : []
      // Self-heal partial publications: a day recorded while the TSO had
      // published only some of its A73 units keeps a degraded perStation set
      // (DE lags days and fills in piecemeal). Recent days with fewer
      // stations than the file's best get re-recorded until they settle.
      const hist = readHistory(histPath)
      const stationsOf = (r) => Object.keys(r.perStation ?? {}).length
      const maxStations = Math.max(0, ...(hist?.hourly ?? []).map(stationsOf))
      const degraded = maxStations
        ? (hist?.hourly ?? [])
            .filter((r) => stationsOf(r) < maxStations)
            .map((r) => r.date)
            .filter((d) => d >= isoDaysAgo(5) && d !== day)
        : []
      const want = [...new Set([...hourlyWant, ...degraded, ...dailyWant])].slice(
        0,
        backfillDays ?? 3,
      )
      let added = 0
      for (const date of want) {
        // Beyond the 7-day hourly window the record is trimmed to its daily
        // average anyway — skip the expensive per-unit A73 fetch there.
        const dayCtx = hourlyWant.includes(date) ? ctx : null
        if (await recordHistoryDay(cc, cfg, histPath, date, dayCtx).catch(() => false)) added++
      }
      if (want.length) console.log(`${cc}: history +${added}/${want.length} day(s)`)
      // Cheap demand backfill (#24): month days recorded before demand
      // existed get just their A65 average patched in — no full refetch.
      const needDemand = (readHistory(histPath)?.days ?? [])
        .filter((r) => r.demandMW === undefined)
        .map((r) => r.date)
        .slice(0, backfillDays ?? 3)
      let patched = 0
      for (const date of needDemand) {
        const d = await fetchDemandDay(cfg, date).catch(() => null)
        if (patchHistoryDay(histPath, date, { demandMW: d ? Math.round(meanCovered(d)) : null }))
          patched++
      }
      if (needDemand.length) console.log(`${cc}: demand patched ${patched}/${needDemand.length}`)
    } catch (err) {
      console.warn(`${cc}: history failed — ${err.message}`)
    }

    console.log(
      `${cc}: day ${day}${basis.carried ? ` (carried, ${basis.ageDays} d)` : ''} · ${
        Object.keys(perStation).length
      } stations · mix ${Math.round(totalMW / 100) / 10} GW avg · ${
        Object.keys(flows).length
      } link flows · unmapped peak ${Math.round(unmappedMW)} MW${
        today ? ` · today through ${String(today.throughHour).padStart(2, '0')}:00` : ''
      }`,
    )
  } catch (err) {
    console.error(`${cc} failed:`, err.message)
    process.exitCode = 1
  }
}
