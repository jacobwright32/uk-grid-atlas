/**
 * cluster-wind.mjs — aggregate individual wind turbines into farm stations.
 *
 *   node scripts/cluster-wind.mjs <cc> [rawDir]
 *
 * Reads gens_<cc>_wind.json (from pbf-extract-generators.py), single-linkage
 * clusters turbines within ~1.5 km, drops clusters of fewer than 3 turbines
 * and turbines already covered by a mapped power=plant wind station, and
 * writes plants_<cc>_wind_clusters.json in the plants-file shape — so the
 * ordinary build-data pipeline (fuel classify, on/offshore split, capacity
 * parse) consumes it with one plantFiles entry and zero new code.
 *
 * Each cluster is anchored on its first turbine's real OSM element, so the
 * hover card's OSM link points at an actual turbine of the farm.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCapacityMW } from './pipeline-utils.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const cc = process.argv[2]
if (!cc) {
  console.error('usage: node scripts/cluster-wind.mjs <cc> [rawDir]')
  process.exit(1)
}
const RAW_DIR = process.argv[3] ?? join(ROOT, '..', 'data')

/**
 * Parse one turbine's rating with a scale sanity clamp: bare numbers are
 * often kW ("2000") or even watts in OSM, but no single turbine exceeds
 * ~20 MW — divide by 1000 until plausible.
 */
function turbineMW(tag) {
  let mw = parseCapacityMW(tag, { decimalComma: true })
  if (mw == null) return null
  while (mw > 20) mw /= 1000
  return mw >= 0.05 ? mw : null
}

const LINK_KM = 1.5
const MIN_TURBINES = 3
const NEAR_EXISTING_KM = 0.6

const raw = JSON.parse(readFileSync(join(RAW_DIR, `gens_${cc}_wind.json`), 'utf8'))
const turbines = raw.elements
  .map((el) => ({
    type: el.type,
    id: el.id,
    lon: el.center?.lon ?? el.lon,
    lat: el.center?.lat ?? el.lat,
    name: el.tags?.name ?? null,
    operator: el.tags?.operator ?? null,
    mw: turbineMW(el.tags?.['generator:output:electricity']),
  }))
  .filter((t) => Number.isFinite(t.lon) && Number.isFinite(t.lat))

// Existing mapped wind stations — their turbines must not double-count.
const stations = JSON.parse(
  readFileSync(join(ROOT, 'src', 'data', cc, 'stations.json'), 'utf8'),
).features.filter((f) => f.properties.fuel.startsWith('wind'))

const kmPerDegLat = 111.32
const kmPerDegLon = (lat) => Math.cos((lat * Math.PI) / 180) * 111.32
const distKm = (a, b) => {
  const dx = (a.lon - b.lon) * kmPerDegLon((a.lat + b.lat) / 2)
  const dy = (a.lat - b.lat) * kmPerDegLat
  return Math.hypot(dx, dy)
}

const free = turbines.filter(
  (t) =>
    !stations.some(
      (s) =>
        distKm(t, { lon: s.geometry.coordinates[0], lat: s.geometry.coordinates[1] }) <
        NEAR_EXISTING_KM,
    ),
)

// ------------------------------------------- single-linkage via grid hash
const cell = LINK_KM / kmPerDegLat // degrees latitude per cell
const grid = new Map()
const keyOf = (t) => {
  const kx = Math.floor(t.lon / (LINK_KM / kmPerDegLon(t.lat)))
  const ky = Math.floor(t.lat / cell)
  return `${kx}:${ky}`
}
free.forEach((t, i) => {
  const k = keyOf(t)
  if (!grid.has(k)) grid.set(k, [])
  grid.get(k).push(i)
})

const parent = free.map((_, i) => i)
const find = (i) => {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]]
    i = parent[i]
  }
  return i
}
const union = (a, b) => {
  const ra = find(a)
  const rb = find(b)
  if (ra !== rb) parent[rb] = ra
}

free.forEach((t, i) => {
  const kx = Math.floor(t.lon / (LINK_KM / kmPerDegLon(t.lat)))
  const ky = Math.floor(t.lat / cell)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get(`${kx + dx}:${ky + dy}`) ?? []) {
        if (j <= i) continue
        if (distKm(t, free[j]) <= LINK_KM) union(i, j)
      }
    }
  }
})

const clusters = new Map()
free.forEach((t, i) => {
  const r = find(i)
  if (!clusters.has(r)) clusters.set(r, [])
  clusters.get(r).push(t)
})

// ----------------------------------------------------- synthesize plants
const stripUnit = (name) =>
  name
    .replace(/\s*[-–#]?\s*(WTG|WEA|T|VE)?\s*\d+[a-z]?$/i, '')
    .replace(/\s+(I{1,3}|IV|V|VI{0,3})$/i, '')
    .trim()

const elements = []
let turbinesKept = 0
for (const members of clusters.values()) {
  if (members.length < MIN_TURBINES) continue
  turbinesKept += members.length
  const mwKnown = members.filter((m) => m.mw != null)
  const mwSum = mwKnown.reduce((a, m) => a + m.mw, 0)
  // capacity: scale known-average onto unknown turbines when most are tagged
  const mw =
    mwKnown.length >= members.length / 2 && mwSum > 0
      ? (mwSum / mwKnown.length) * members.length
      : mwSum > 0
        ? mwSum
        : null

  const nameCounts = new Map()
  for (const m of members) {
    if (!m.name) continue
    const stem = stripUnit(m.name)
    if (stem.length < 3) continue
    nameCounts.set(stem, (nameCounts.get(stem) ?? 0) + 1)
  }
  const best = [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0]
  const operator = members.map((m) => m.operator).find(Boolean)
  const name = best?.[0] ?? (operator ? `${operator} wind farm` : 'Wind farm')

  const lon = members.reduce((a, m) => a + m.lon, 0) / members.length
  const lat = members.reduce((a, m) => a + m.lat, 0) / members.length
  const anchor = members[0]

  const tags = {
    name: `${name} (${members.length} turbines)`,
    'plant:source': 'wind',
  }
  if (operator) tags.operator = operator
  if (mw != null && mw > 0) tags['plant:output:electricity'] = `${Math.round(mw * 10) / 10} MW`
  elements.push({ type: anchor.type, id: anchor.id, center: { lon, lat }, tags })
}

const out = join(RAW_DIR, `plants_${cc}_wind_clusters.json`)
writeFileSync(out, JSON.stringify({ elements }))
const totalMW = elements.reduce(
  (a, el) => a + (parseCapacityMW(el.tags['plant:output:electricity'], {}) ?? 0),
  0,
)
console.log(
  `${cc}: ${turbines.length} turbines → ${elements.length} farms (${turbinesKept} turbines clustered, ${Math.round(totalMW / 100) / 10} GW) → ${out}`,
)
