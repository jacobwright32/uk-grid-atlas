/**
 * build-data.mjs — turn raw Overpass extracts into the app's GeoJSON bundles.
 *
 * Inputs  (RAW_DIR): plants_uk.json, wind_sea.json, wind_sea2.json, lines_*.json
 * Outputs (src/data): stations.json, transmission.json, interconnectors.json,
 *                     basemap.json, meta.json
 *
 * Run:  node scripts/build-data.mjs [rawDir]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as topojson from 'topojson-client'
import { INTERCONNECTORS } from './interconnectors.mjs'
import { inRing, parseCapacityMW, parseVoltClass, simplify, smooth } from './pipeline-utils.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RAW_DIR = process.argv[2] ?? join(__dirname, '..', '..', 'data')
const OUT_DIR = join(__dirname, '..', 'src', 'data')
mkdirSync(OUT_DIR, { recursive: true })

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'))

// ---------------------------------------------------------------- land mask
const landTopo = readJSON(join(__dirname, '..', 'node_modules', 'world-atlas', 'land-10m.json'))
const landFC = topojson.feature(landTopo, landTopo.objects.land)

const landRings = []
for (const f of landFC.features) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
  for (const poly of polys) {
    const outer = poly[0]
    let minX = 180,
      minY = 90,
      maxX = -180,
      maxY = -90
    for (const [x, y] of outer) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    landRings.push({ rings: poly, bbox: [minX, minY, maxX, maxY] })
  }
}

function onLand([x, y]) {
  for (const { rings, bbox } of landRings) {
    if (x < bbox[0] || x > bbox[2] || y < bbox[1] || y > bbox[3]) continue
    if (inRing([x, y], rings[0])) {
      let inHole = false
      for (let h = 1; h < rings.length; h++)
        if (inRing([x, y], rings[h])) {
          inHole = true
          break
        }
      if (!inHole) return true
    }
  }
  return false
}

// ------------------------------------------------------------ fuel taxonomy
const FUEL_GROUPS = {
  nuclear: 'nuclear',
  gas: 'gas',
  methane: 'gas',
  abandoned_mine_methane: 'gas',
  'mine gas': 'gas',
  coal: 'coal',
  wind: 'wind',
  solar: 'solar',
  hydro: 'hydro',
  battery: 'storage',
  liquid_air: 'storage',
  flywheel: 'storage',
  biomass: 'bioenergy',
  biofuel: 'bioenergy',
  biogas: 'bioenergy',
  landfill_gas: 'bioenergy',
  wastewater: 'bioenergy',
  sludge: 'bioenergy',
  waste: 'waste',
  oil: 'oil',
  diesel: 'oil',
  kerosene: 'oil',
  tidal: 'marine',
  wave: 'marine',
}

const PUMPED_NAMES = /dinorwig|ffestiniog|cruachan|foyers|coire glas/i

function fuelGroup(tags, name) {
  const src = (tags['plant:source'] ?? '').toLowerCase()
  const primary = src.split(';')[0].trim()
  let group = FUEL_GROUPS[primary]
  if (!group && name) {
    if (/solar/i.test(name)) group = 'solar'
    else if (/wind/i.test(name)) group = 'wind'
    else if (/hydro/i.test(name)) group = 'hydro'
    else if (/battery|storage/i.test(name)) group = 'storage'
    else if (/biomass|biogas/i.test(name)) group = 'bioenergy'
  }
  if (!group) group = 'other'
  if (group === 'hydro') {
    const method = (tags['plant:method'] ?? '').toLowerCase()
    if (method.includes('pumped') || PUMPED_NAMES.test(name ?? '')) group = 'pumped'
  }
  return group
}

// ----------------------------------------------------------------- stations
const ukSet = readJSON(join(RAW_DIR, 'plants_uk.json')).elements
const seaFiles = ['wind_sea.json', 'wind_sea2.json'].filter((f) => existsSync(join(RAW_DIR, f)))
const seaSet = seaFiles.flatMap((f) => readJSON(join(RAW_DIR, f)).elements)

const ukIds = new Set(ukSet.map((e) => `${e.type}/${e.id}`))

/** Heuristic: drop non-UK offshore plants picked up by the sea bounding boxes. */
function isForeignSea([lon, lat]) {
  if (lat < 50.2) return true // French Channel coast farms
  if (lat < 52.1 && lon > 2.25) return true // Belgian / Dunkirk zone
  if (lat > 52.4 && lat < 53.3 && lon > 3.1) return true // Dutch IJmuiden Ver zone
  if (lon < -5.6 && lat < 54.2) return true // Irish east-coast farms
  if (lat > 60.9 && lon > 1.8) return true // Norwegian Hywind Tampen
  return false
}

const merged = [...ukSet]
for (const el of seaSet) {
  const key = `${el.type}/${el.id}`
  if (ukIds.has(key)) continue
  const c = el.center ?? (el.lat != null ? { lat: el.lat, lon: el.lon } : null)
  if (!c) continue
  if (isForeignSea([c.lon, c.lat])) continue
  ukIds.add(key)
  merged.push(el)
}

const seenNames = new Map()
const stationFeatures = []
const rank = { relation: 3, way: 2, node: 1 }

for (const el of merged) {
  const tags = el.tags ?? {}
  const c = el.center ?? (el.lat != null ? { lat: el.lat, lon: el.lon } : null)
  if (!c) continue
  const coords = [Math.round(c.lon * 1e5) / 1e5, Math.round(c.lat * 1e5) / 1e5]
  const name = tags.name ?? tags['name:en'] ?? null
  let group = fuelGroup(tags, name)
  const capacityMW = parseCapacityMW(tags['plant:output:electricity'])
  if (group === 'wind') group = onLand(coords) ? 'wind_onshore' : 'wind_offshore'

  const feature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: coords },
    properties: {
      id: `${el.type}/${el.id}`,
      name: name ?? 'Unnamed site',
      fuel: group,
      source: tags['plant:source'] ?? null,
      method: tags['plant:method'] ?? null,
      capacityMW,
      operator: tags.operator ?? null,
      start: tags.start_date ?? null,
      osmType: el.type,
    },
  }

  if (name) {
    const norm = name.toLowerCase().replace(/\s+/g, ' ').trim()
    const prevIdx = seenNames.get(norm)
    if (prevIdx != null) {
      const prev = stationFeatures[prevIdx]
      const better =
        rank[el.type] > rank[prev.properties.osmType] ||
        (rank[el.type] === rank[prev.properties.osmType] &&
          capacityMW != null &&
          prev.properties.capacityMW == null)
      if (better) stationFeatures[prevIdx] = feature
      continue
    }
    seenNames.set(norm, stationFeatures.length)
  }
  stationFeatures.push(feature)
}

// ------------------------------------------------------------------- lines
const lineFiles = readdirSync(RAW_DIR).filter((f) => /^lines_.*\.json$/.test(f))
const seenWays = new Set()
const lineFeatures = []
let skippedNoGeom = 0

for (const f of lineFiles) {
  let data
  try {
    data = readJSON(join(RAW_DIR, f))
  } catch {
    continue // partial/failed download artifacts
  }
  for (const el of data.elements ?? []) {
    if (el.type !== 'way' || seenWays.has(el.id)) continue
    seenWays.add(el.id)
    if (!el.geometry) {
      skippedNoGeom++
      continue
    }
    const tags = el.tags ?? {}
    const v = parseVoltClass(tags.voltage)
    if (!v) continue
    let pts = el.geometry.map((g) => [g.lon, g.lat])
    const probes = [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]]
    // France spillover: Pas-de-Calais strip (UK's easternmost circuits at
    // Richborough sit north of 51.15, Kent lines west of 1.35) and the
    // Normandy coast (no UK 400/275 kV south of 50.5 east of -0.5 —
    // Cornwall's southern circuits are all further west).
    if (probes.every(([lon, lat]) => lat < 51.15 && lon > 1.35)) continue
    if (probes.every(([lon, lat]) => lat < 50.5 && lon > -0.5)) continue
    if (probes.every(([lon, lat]) => lat < 53.9 && lon < -6.15)) continue // Republic of Ireland
    pts = simplify(pts, 0.00025).map(([x, y]) => [
      Math.round(x * 1e5) / 1e5,
      Math.round(y * 1e5) / 1e5,
    ])
    lineFeatures.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: pts },
      properties: {
        v,
        name: tags.name ?? null,
        operator: tags.operator ?? null,
        circuits: tags.circuits ? parseInt(tags.circuits, 10) || null : null,
      },
    })
  }
}

// --------------------------------------------------------- interconnectors
const icFeatures = INTERCONNECTORS.map((ic) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: smooth(ic.waypoints) },
  properties: {
    id: ic.id,
    name: ic.name,
    to: ic.to,
    capMW: ic.capMW,
    year: ic.year,
    kv: ic.kv,
    kind: ic.kind,
    status: ic.status,
  },
}))

// ---------------------------------------------------------------- basemap
const CLIP = [-11.5, 47.5, 11.0, 62.7] // W,S,E,N
function clipFeature(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates
  const kept = []
  for (const poly of polys) {
    const outer = poly[0]
    const intersects = outer.some(
      ([x, y]) => x >= CLIP[0] && x <= CLIP[2] && y >= CLIP[1] && y <= CLIP[3],
    )
    if (!intersects) continue
    const simplified = poly.map((ring) => simplify(ring, 0.004))
    if (simplified[0].length >= 4) kept.push(simplified)
  }
  return kept
}
const landPolys = []
for (const f of landFC.features) landPolys.push(...clipFeature(f.geometry))
const basemap = {
  type: 'FeatureCollection',
  features: landPolys.map((coords) => ({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: coords.map((r) => r.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4])),
    },
    properties: {},
  })),
}

// ------------------------------------------------------------------ output
const write = (name, obj) => {
  const s = JSON.stringify(obj)
  writeFileSync(join(OUT_DIR, name), s)
  console.log(`${name}: ${(s.length / 1024).toFixed(0)} kB`)
}

write('stations.json', { type: 'FeatureCollection', features: stationFeatures })
write('transmission.json', { type: 'FeatureCollection', features: lineFeatures })
write('interconnectors.json', { type: 'FeatureCollection', features: icFeatures })
write('basemap.json', basemap)
write('meta.json', {
  generated: new Date().toISOString().slice(0, 10),
  stationCount: stationFeatures.length,
  lineCount: lineFeatures.length,
  attribution: 'Power data © OpenStreetMap contributors (ODbL). Coastline: Natural Earth.',
})

console.log(
  `stations: ${stationFeatures.length}, lines: ${lineFeatures.length} (skipped ${skippedNoGeom} without geometry)`,
)
const byFuel = {}
for (const f of stationFeatures) byFuel[f.properties.fuel] = (byFuel[f.properties.fuel] ?? 0) + 1
console.log(byFuel)
