/**
 * fetch-live-snapshot.mjs — bake a recent metered day + mix instant into
 * src/data/live-snapshot.json so the single-file/offline build still
 * demonstrates the live layer (clearly labelled as a snapshot).
 *
 *   node scripts/fetch-live-snapshot.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aggregateDay,
  chunk,
  currentSettlement,
  daysBefore,
  parseOutturn,
} from '../src/lib/live-core.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'src', 'data')
const API = 'https://data.elexon.co.uk/bmrs/api/v1'

const bmuMap = JSON.parse(readFileSync(join(DATA_DIR, 'bmu-map.json'), 'utf8'))

const get = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'ukgrid-dashboard/1.0' } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

const streamUrl = (date, units) =>
  `${API}/datasets/B1610/stream?from=${daysBefore(date, 1)}T22:00:00Z&to=${date}T23:30:00Z` +
  units.map((u) => `&bmUnit=${encodeURIComponent(u)}`).join('')

// latest metered day
const { settlementDate } = currentSettlement()
let date = null
for (let back = 1; back <= 16; back++) {
  const candidate = daysBefore(settlementDate, back)
  const rows = await get(streamUrl(candidate, bmuMap.sentinels))
  if (Array.isArray(rows) && rows.some((r) => r.settlementDate === candidate)) {
    date = candidate
    break
  }
}
if (!date) throw new Error('no metered day found in lookback window')
console.log(`latest metered day: ${date}`)

const units = Object.keys(bmuMap.byUnit)
const rows = []
for (const batch of chunk(units, 30)) {
  const data = await get(streamUrl(date, batch))
  for (const row of data) if (row.settlementDate === date) rows.push(row)
  process.stdout.write('.')
}
console.log(` ${rows.length} rows`)

const per = aggregateDay(rows, bmuMap.byUnit)

// mix instant
let mix = null
try {
  const now = new Date()
  const start = new Date(now.getTime() - 90 * 60_000).toISOString().slice(0, 19) + 'Z'
  const end = new Date(now.getTime() + 30 * 60_000).toISOString().slice(0, 19) + 'Z'
  mix = parseOutturn(await get(`${API}/generation/outturn/summary?startTime=${start}&endTime=${end}`))
} catch (err) {
  console.warn('mix fetch failed:', err.message)
}

const out = {
  date,
  generatedAt: new Date().toISOString(),
  perStation: Object.fromEntries(per),
  mix,
}
const json = JSON.stringify(out)
writeFileSync(join(DATA_DIR, 'live-snapshot.json'), json)
console.log(
  `live-snapshot.json: ${(json.length / 1024).toFixed(0)} kB, ${per.size} stations with data`,
)
