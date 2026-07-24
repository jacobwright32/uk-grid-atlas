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
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'live')
mkdirSync(OUT_DIR, { recursive: true })

const UA = { 'User-Agent': 'grid-atlas/1.0 (open-data dashboard)' }

/** ISO fuel label → Grid Atlas mix bucket. */
const BUCKETS = {
  // ERCOT
  'Coal and Lignite': ['coal', 'Coal & lignite'],
  'Natural Gas': ['gas', 'Gas'],
  Nuclear: ['nuclear', 'Nuclear'],
  Hydro: ['hydro', 'Hydro & pumped'],
  Solar: ['solar', 'Solar'],
  Wind: ['wind', 'Wind'],
  'Power Storage': ['other', 'Oil & other'],
  Other: ['other', 'Oil & other'],
  // NYISO
  'Dual Fuel': ['gas', 'Gas'],
  'Other Fossil Fuels': ['other', 'Oil & other'],
  'Other Renewables': ['biomass', 'Biomass & waste'],
}
const MIX_COLORS = {
  wind: '#199e70',
  solar: '#c98500',
  gas: '#3987e5',
  nuclear: '#9085e9',
  coal: '#ad7a45',
  biomass: '#d95926',
  hydro: '#1899ac',
  other: '#e66767',
}

/** hourly accumulator: bucket → {sums:[24], counts:[24]} */
function makeAcc() {
  return new Map()
}
function accAdd(acc, bucketKey, hour, mw) {
  if (hour < 0 || hour > 23 || !Number.isFinite(mw)) return
  let a = acc.get(bucketKey)
  if (!a) {
    a = { sums: new Array(24).fill(0), counts: new Array(24).fill(0) }
    acc.set(bucketKey, a)
  }
  a.sums[hour] += mw
  a.counts[hour] += 1
}
/** finalize one ISO's accumulator → bucket → hourly-average series */
function accSeries(acc) {
  const out = new Map()
  for (const [key, a] of acc) {
    out.set(
      key,
      a.sums.map((v, h) => (a.counts[h] > 0 ? v / a.counts[h] : null)),
    )
  }
  return out
}

// ------------------------------------------------------------------ ERCOT
/** Returns { [isoDate]: Map<bucket, hourlySeries> } for the dates present. */
async function fetchErcot() {
  const res = await fetch('https://www.ercot.com/api/1/services/read/dashboards/fuel-mix.json', {
    headers: UA,
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`ERCOT ${res.status}`)
  const doc = await res.json()
  const days = {}
  for (const [date, points] of Object.entries(doc.data ?? {})) {
    const acc = makeAcc()
    for (const [ts, fuels] of Object.entries(points)) {
      const hour = parseInt(ts.slice(11, 13), 10) // ERCOT-local hour
      for (const [fuel, v] of Object.entries(fuels)) {
        const bucket = BUCKETS[fuel]
        if (bucket) accAdd(acc, bucket[0], hour, v?.gen)
      }
    }
    days[date] = accSeries(acc)
  }
  return days
}

// ------------------------------------------------------------------ NYISO
/** One dated CSV → Map<bucket, hourlySeries>. */
async function fetchNyiso(dateCompact) {
  const url = `https://mis.nyiso.com/public/csv/rtfuelmix/${dateCompact}rtfuelmix.csv`
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`NYISO ${res.status} for ${url}`)
  const text = await res.text()
  const acc = makeAcc()
  for (const line of text.split('\n').slice(1)) {
    const cols = line.split(',')
    if (cols.length < 4) continue
    const hour = parseInt(cols[0]?.slice(11, 13), 10) // "MM/DD/YYYY HH:mm:ss"
    const bucket = BUCKETS[cols[2]?.trim()]
    const mw = parseFloat(cols[3])
    if (bucket) accAdd(acc, bucket[0], hour, mw)
  }
  return accSeries(acc)
}

// ------------------------------------------------------------- aggregate
/** Sum per-ISO bucket series; a slot is non-null when EVERY ISO covers it,
 *  so the today-so-far total never dips as feeds update out of step. */
function combine(isoSeries) {
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

function rowsFrom(mixSeries) {
  const rows = []
  for (const [key, series] of Object.entries(mixSeries)) {
    const vals = series.filter((v) => v != null)
    if (!vals.length) continue
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length
    if (avg <= 0) continue
    rows.push({
      key,
      label: BUCKETS_LABEL[key] ?? key,
      color: MIX_COLORS[key] ?? '#898781',
      nowMW: Math.round(avg),
      capMW: 0,
    })
  }
  rows.sort((a, b) => b.nowMW - a.nowMW)
  return rows
}
const BUCKETS_LABEL = Object.fromEntries(Object.values(BUCKETS).map(([k, l]) => [k, l]))

const isoDaysAgo = (n) => {
  const d = new Date(Date.now() - n * 24 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

const yesterday = isoDaysAgo(1)
const todayDate = isoDaysAgo(0)

const [ercotDays, nyYesterday, nyToday] = await Promise.all([
  fetchErcot(),
  fetchNyiso(yesterday.replace(/-/g, '')),
  fetchNyiso(todayDate.replace(/-/g, '')).catch(() => null),
])

if (!ercotDays[yesterday]) throw new Error(`ERCOT has no data for ${yesterday}`)
const meteredSeries = combine([ercotDays[yesterday], nyYesterday])
const meteredRows = rowsFrom(meteredSeries)
const meteredTotal = meteredRows.reduce((a, r) => a + r.nowMW, 0)

let today = null
if (ercotDays[todayDate] && nyToday) {
  const s = combine([ercotDays[todayDate], nyToday])
  const rows = rowsFrom(s)
  const throughHour = Math.max(
    ...Object.values(s).map((x) => x.reduce((a, v, h) => (v != null ? h + 1 : a), 0)),
    0,
  )
  if (throughHour >= 3) {
    today = {
      date: todayDate,
      throughHour,
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
  sourceLabel: 'ERCOT + NYISO',
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
  `us: metered ${yesterday} · mix ${Math.round(meteredTotal / 100) / 10} GW avg (ERCOT+NYISO)${
    today ? ` · today through ${String(today.throughHour).padStart(2, '0')}:00` : ''
  }`,
)
