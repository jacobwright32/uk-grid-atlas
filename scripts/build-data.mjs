/**
 * build-data.mjs — turn raw Overpass extracts into per-country GeoJSON bundles.
 *
 *   node scripts/build-data.mjs <country> [rawDir]     country: gb | nl
 *
 * Inputs  (RAW_DIR): country-specific raw extracts (see COUNTRIES below)
 * Outputs (src/data/<country>/): stations.json, transmission.json,
 *          interconnectors.json, meta.json  — plus shared src/data/basemap.json
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as topojson from 'topojson-client'
import { INTERCONNECTORS } from './interconnectors.mjs'
import { buildRegionBasemap, REGIONS } from './basemap.mjs'
import { inRing, parseCapacityMW, simplify, smooth } from './pipeline-utils.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ------------------------------------------------------- country registry
const COUNTRIES = {
  gb: {
    plantFiles: ['plants_uk.json'],
    seaFiles: ['wind_sea.json', 'wind_sea2.json'],
    lineFile: /^lines_.*\.json$/,
    /** Drop non-UK offshore plants picked up by the sea bounding boxes. */
    isForeignSea: ([lon, lat]) =>
      lat < 50.2 || // French Channel coast farms
      (lat < 52.1 && lon > 2.25) || // Belgian / Dunkirk zone
      (lat > 52.4 && lat < 53.3 && lon > 3.1) || // Dutch IJmuiden Ver zone
      (lon < -5.6 && lat < 54.2) || // Irish east-coast farms
      (lat > 60.9 && lon > 1.8), // Norwegian Hywind Tampen
    /** Drop foreign line spillover (probes = first/mid/last points). */
    isForeignLine: (probes) =>
      probes.every(([lon, lat]) => lat < 51.15 && lon > 1.35) || // Pas-de-Calais
      probes.every(([lon, lat]) => lat < 50.5 && lon > -0.5) || // Normandy
      probes.every(([lon, lat]) => lat < 53.9 && lon < -6.15), // Republic of Ireland
    /** Voltage (V) → line class (kV tier value stored in `v`). */
    classify: (volts) =>
      volts >= 380000 ? 400 : volts >= 264000 ? 275 : volts >= 110000 ? 132 : null,
  },
  nl: {
    decimalComma: true,
    plantFiles: ['nl_plants.json'],
    seaFiles: ['nl_sea.json'],
    lineFile: /^nl_lines.*\.json$/,
    isForeignSea: ([lon, lat]) =>
      lat < 51.66 || // Belgian zone
      lon > 6.35 || // German Bight (Riffgat and east)
      (lon > 6.0 && lat > 54.2) || // German Borkum-west cluster (He Dreiht etc.)
      lon < 2.9, // UK sector
    isForeignLine: () => false, // admin-area query already clips
    classify: (volts) =>
      volts >= 340000
        ? 380
        : volts >= 200000
          ? 220
          : volts >= 140000
            ? 150
            : volts >= 100000
              ? 110
              : null,
  },
  be: {
    decimalComma: true,
    plantFiles: ['plants_be.json', 'plants_be_pbf.json'],
    seaFiles: ['sea_be.json'],
    lineFile: /^be_lines.*\.json$/,
    isForeignSea: ([lon, lat]) => lat < 51.35 || lon < 2.3 || (lon > 3.02 && lat > 51.66), // FR / UK / NL Borssele
    isForeignLine: () => false,
    classify: (volts) =>
      volts >= 340000 ? 380 : volts >= 200000 ? 220 : volts >= 140000 ? 150 : null,
  },
  ie: {
    // All-island view: Republic + Northern Ireland (the SEM is one market).
    plantFiles: ['plants_ie2.json', 'plants_ie_pbf.json'],
    seaFiles: ['sea_ie.json'],
    lineFile: /^ie_lines.*\.json$/,
    isForeignSea: ([lon]) => lon > -5.45, // GB Irish Sea farms
    isForeignLine: () => false,
    classify: (volts) =>
      volts >= 380000
        ? 400
        : volts >= 264000
          ? 275
          : volts >= 200000
            ? 220
            : volts >= 100000
              ? 110
              : null,
  },
  dk: {
    decimalComma: true,
    plantFiles: ['plants_dk.json', 'plants_dk_pbf.json'],
    seaFiles: ['sea_dk1.json', 'sea_dk2.json'],
    lineFile: /^dk_lines.*\.json$/,
    isForeignSea: ([lon, lat]) =>
      (lat < 55.35 && lon < 8.0) || // German Bight (DanTysk/Butendiek cluster)
      (lat > 55.3 && lon > 12.7) || // Swedish Öresund (Lillgrund)
      lon > 13.05, // German Baltic
    isForeignLine: () => false,
    classify: (volts) =>
      volts >= 380000 ? 400 : volts >= 140000 ? 150 : volts >= 125000 ? 132 : null,
  },
  fr: {
    decimalComma: true,
    // Metropolitan France only (plants query is bbox-bounded).
    plantFiles: ['plants_fr.json', 'plants_fr_pbf.json'],
    seaFiles: ['sea_fr1.json', 'sea_fr2.json', 'sea_fr3.json'],
    lineFile: /^fr_lines.*\.json$/,
    isForeignSea: ([, lat]) => lat > 50.25, // UK Channel farms
    isForeignLine: (probes) => probes.every(([lon, lat]) => lat > 51.35 || lon < -5.5), // extract buffer
    classify: (volts) => (volts >= 380000 ? 400 : volts >= 200000 ? 225 : null),
  },
  de: {
    decimalComma: true,
    plantFiles: ['plants_de.json', 'plants_de_pbf.json'],
    seaFiles: ['sea_de1.json', 'sea_de2.json'],
    lineFile: /^de_lines.*\.json$/,
    isForeignSea: ([lon, lat]) =>
      (lon < 6.2 && lat < 54.2) || // NL Gemini
      lat > 55.35 || // Danish North Sea
      (lat > 54.95 && lon > 12.3), // Danish Baltic (Kriegers Flak)
    isForeignLine: () => false,
    classify: (volts) => (volts >= 340000 ? 380 : volts >= 200000 ? 220 : null),
  },
  ch: {
    decimalComma: true,
    plantFiles: ['plants_ch.json', 'plants_ch_pbf.json'],
    seaFiles: [],
    lineFile: /^ch_lines.*\.json$/,
    isForeignSea: () => false,
    isForeignLine: () => false,
    // Swissgrid's transmission grid is 380/220 only; cantonal 110 kV and the
    // SBB 132 kV 16.7 Hz traction grid are deliberately out (same rule as DE).
    classify: (volts) => (volts >= 340000 ? 380 : volts >= 200000 ? 220 : null),
  },
  at: {
    decimalComma: true,
    plantFiles: ['plants_at.json', 'plants_at_pbf.json'],
    seaFiles: [],
    lineFile: /^at_lines.*\.json$/,
    isForeignSea: () => false,
    isForeignLine: () => false,
    // APG's 380/220 backbone; regional 110 kV and ÖBB's 110 kV 16.7 Hz
    // traction grid are deliberately out (same rule as DE/CH).
    classify: (volts) => (volts >= 340000 ? 380 : volts >= 200000 ? 220 : null),
  },
  cz: {
    decimalComma: true,
    plantFiles: ['plants_cz.json', 'plants_cz_pbf.json'],
    seaFiles: [],
    lineFile: /^cz_lines.*\.json$/,
    isForeignSea: () => false,
    isForeignLine: () => false,
    // ČEPS backbone is 400/220; the 110 kV distribution layer is out (DE rule).
    classify: (volts) => (volts >= 380000 ? 400 : volts >= 200000 ? 220 : null),
  },
  no: {
    decimalComma: true,
    plantFiles: ['plants_no_s.json', 'plants_no_m.json', 'plants_no_n.json', 'plants_no_pbf.json'],
    seaFiles: ['sea_no.json'],
    lineFile: /^no_lines.*\.json$/,
    // Sea box brushes the GB and Danish North Sea sectors.
    isForeignSea: ([lon, lat]) => lon < 1.9 || lat < 56.6,
    isForeignLine: () => false, // admin-area query already clips
    classify: (volts) =>
      volts >= 380000 ? 420 : volts >= 264000 ? 300 : volts >= 110000 ? 132 : null,
  },
  se: {
    decimalComma: true,
    plantFiles: ['plants_se_s.json', 'plants_se_n.json', 'plants_se_pbf.json'],
    seaFiles: ['sea_se.json'],
    lineFile: /^se_lines.*\.json$/,
    // Öresund/Baltic boxes brush Danish and German farms.
    isForeignSea: ([lon, lat]) => lat < 55.25 || (lat < 55.6 && lon < 13.0),
    isForeignLine: () => false,
    classify: (volts) =>
      volts >= 380000 ? 400 : volts >= 200000 ? 220 : volts >= 110000 ? 130 : null,
  },
  pl: {
    decimalComma: true,
    plantFiles: ['plants_pl_w.json', 'plants_pl_e.json', 'plants_pl_pbf.json'],
    seaFiles: ['sea_pl.json'],
    lineFile: /^pl_lines.*\.json$/,
    isForeignSea: () => false,
    isForeignLine: () => false,
    classify: (volts) => (volts >= 380000 ? 400 : volts >= 200000 ? 220 : null),
  },
  es: {
    decimalComma: true,
    plantFiles: ['plants_es.json', 'plants_es_pbf.json'],
    seaFiles: [],
    lineFile: /^es_lines.*\.json$/,
    isForeignSea: () => false,
    isForeignLine: () => false,
    classify: (volts) => (volts >= 380000 ? 400 : volts >= 200000 ? 220 : null),
  },
  it: {
    decimalComma: true,
    plantFiles: ['plants_it_n.json', 'plants_it_m.json', 'plants_it_s.json', 'plants_it_pbf.json'],
    seaFiles: [],
    lineFile: /^it_lines.*\.json$/,
    isForeignSea: () => false,
    isForeignLine: () => false,
    classify: (volts) => (volts >= 340000 ? 380 : volts >= 200000 ? 220 : null),
  },
  pt: {
    decimalComma: true,
    plantFiles: ['plants_pt.json', 'plants_pt_pbf.json'],
    seaFiles: [],
    lineFile: /^pt_lines.*\.json$/,
    // Mainland + Madeira (the eu basemap covers both); the Azores sit west
    // of the shipped coastline, so their handful of plants are excluded.
    keep: ([lon]) => lon >= -18.5,
    isForeignSea: () => false,
    isForeignLine: () => false,
    classify: (volts) =>
      volts >= 380000 ? 400 : volts >= 200000 ? 220 : volts >= 140000 ? 150 : null,
  },
  ee: {
    decimalComma: true,
    plantFiles: ['plants_ee.json', 'plants_ee_pbf.json'],
    seaFiles: [],
    lineFile: /^ee_lines.*\.json$/,
    isForeignSea: () => false,
    isForeignLine: () => false,
    // Baltic backbone is the ex-Soviet 330 kV standard; 110 kV is regional.
    classify: (volts) => (volts >= 300000 ? 330 : volts >= 100000 ? 110 : null),
  },
  lv: {
    decimalComma: true,
    plantFiles: ['plants_lv.json', 'plants_lv_pbf.json'],
    seaFiles: [],
    lineFile: /^lv_lines.*\.json$/,
    isForeignSea: () => false,
    isForeignLine: () => false,
    classify: (volts) => (volts >= 300000 ? 330 : volts >= 100000 ? 110 : null),
  },
  lt: {
    decimalComma: true,
    plantFiles: ['plants_lt.json', 'plants_lt_pbf.json'],
    seaFiles: [],
    lineFile: /^lt_lines.*\.json$/,
    isForeignSea: () => false,
    isForeignLine: () => false,
    classify: (volts) => (volts >= 300000 ? 330 : volts >= 100000 ? 110 : null),
  },
  fi: {
    decimalComma: true,
    plantFiles: ['plants_fi.json', 'plants_fi_pbf.json'],
    seaFiles: [],
    lineFile: /^fi_lines.*\.json$/,
    isForeignSea: () => false,
    isForeignLine: () => false,
    // 110 kV is transmission voltage in Finland (Fingrid), like Scotland's 132.
    classify: (volts) =>
      volts >= 380000 ? 400 : volts >= 200000 ? 220 : volts >= 100000 ? 110 : null,
  },
  ca: {
    region: 'na',
    simplifyEps: 0.0005,
    coordDp: 4,
    plantFiles: ['plants_ca_pbf.json'],
    seaFiles: [],
    lineFile: /^ca_lines.*\.json$/,
    // Populated-grid box: Vancouver Island to St. John's, up to Yellowknife.
    keep: ([lon, lat]) => lat >= 41.7 && lat <= 62.7 && lon >= -139.5 && lon <= -52.0,
    isForeignSea: () => false,
    isForeignLine: () => false,
    // Hydro-Québec's 735 kV is its own class; 240 kV Alberta folds into 230.
    classify: (volts) =>
      volts >= 650000
        ? 735
        : volts >= 440000
          ? 500
          : volts >= 280000
            ? 315
            : volts >= 200000
              ? 230
              : null,
  },
  us: {
    region: 'na',
    simplifyEps: 0.0005,
    coordDp: 4,
    // Continental US only for v1 (Alaska/Hawaii/PR omitted).
    plantFiles: ['plants_us_pbf.json'],
    seaFiles: ['sea_us.json'],
    lineFile: /^us_lines.*\.json$/,
    keep: ([lon, lat]) => lat >= 24.2 && lat <= 49.8 && lon >= -125.5 && lon <= -66.4,
    isForeignSea: () => false,
    isForeignLine: () => false,
    classify: (volts) =>
      volts >= 700000
        ? 765
        : volts >= 450000
          ? 500
          : volts >= 300000
            ? 345
            : volts >= 200000
              ? 230
              : null,
  },
}

const country = process.argv[2] ?? 'gb'
const cfg = COUNTRIES[country]
if (!cfg) {
  console.error(
    `Unknown country "${country}" — expected one of: ${Object.keys(COUNTRIES).join(', ')}`,
  )
  process.exit(1)
}
const RAW_DIR = process.argv[3] ?? join(__dirname, '..', '..', 'data')
const OUT_DIR = join(__dirname, '..', 'src', 'data', country)
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
  lignite: 'coal',
  oil_shale: 'coal',
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
  geothermal: 'geothermal',
}

const PUMPED_NAMES = /dinorwig|ffestiniog|cruachan|foyers|coire glas/i

function fuelGroup(tags, name) {
  const src = (tags['plant:source'] ?? '').toLowerCase()
  const primary = src.split(';')[0].trim()
  let group = FUEL_GROUPS[primary]
  if (!group && name) {
    if (/solar|zonnepark|zonneweide/i.test(name)) group = 'solar'
    else if (/wind/i.test(name)) group = 'wind'
    else if (/hydro/i.test(name)) group = 'hydro'
    else if (/battery|storage/i.test(name)) group = 'storage'
    else if (/biomass|biogas/i.test(name)) group = 'bioenergy'
    else if (/geotherm|geotermic|geotermia|jarðvarma/i.test(name)) group = 'geothermal'
  }
  if (!group) group = 'other'
  if (group === 'hydro') {
    const method = (tags['plant:method'] ?? '').toLowerCase()
    if (method.includes('pumped') || PUMPED_NAMES.test(name ?? '')) group = 'pumped'
  }
  return group
}

// ----------------------------------------------------------------- stations
// Plant files may overlap (Overpass + PBF extracts) — dedupe by osm id.
const seenIds = new Set()
const mainSet = []
for (const f of cfg.plantFiles.filter((f) => existsSync(join(RAW_DIR, f)))) {
  for (const el of readJSON(join(RAW_DIR, f)).elements) {
    const key = `${el.type}/${el.id}`
    if (seenIds.has(key)) continue
    seenIds.add(key)
    mainSet.push(el)
  }
}
if (!mainSet.length) throw new Error(`no plant data found for ${country}`)
const seaSet = cfg.seaFiles
  .filter((f) => existsSync(join(RAW_DIR, f)))
  .flatMap((f) => readJSON(join(RAW_DIR, f)).elements)

const merged = [...mainSet]
for (const el of seaSet) {
  const key = `${el.type}/${el.id}`
  if (seenIds.has(key)) continue
  const c = el.center ?? (el.lat != null ? { lat: el.lat, lon: el.lon } : null)
  if (!c) continue
  if (cfg.isForeignSea([c.lon, c.lat])) continue
  seenIds.add(key)
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
  let capacityMW = parseCapacityMW(tags['plant:output:electricity'], cfg.decimalComma ?? false)
  if (cfg.keep && !cfg.keep(coords)) continue
  const land = onLand(coords)
  // Offshore foreign-zone guard applies to every source: PBF extracts carry
  // a sea buffer that can include neighbours' wind farms (land sites are
  // safe — the coastline test exempts them).
  if (!land && cfg.isForeignSea(coords)) continue
  if (group === 'wind') group = land ? 'wind_onshore' : 'wind_offshore'
  // Physical-plausibility guard: no single solar park / onshore wind farm /
  // bio site / battery on Earth exceeds ~1.5 GW — values above that are
  // almost certainly kW(p) tags without units. Runs AFTER the on/offshore
  // split: multi-GW offshore farms (Dogger Bank…) are real. (#1)
  const SMALL_FUELS = new Set(['solar', 'wind_onshore', 'bioenergy', 'waste', 'storage', 'marine'])
  if (capacityMW != null && capacityMW > 1500 && SMALL_FUELS.has(group)) {
    capacityMW = capacityMW / 1000 >= 0.05 ? Math.round(capacityMW) / 1000 : null
  }

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
function parseVoltClass(v) {
  if (!v) return null
  let best = null
  for (const part of String(v).split(';')) {
    const n = parseInt(part.trim(), 10)
    if (!Number.isFinite(n)) continue
    const cls = cfg.classify(n)
    if (cls != null) best = Math.max(best ?? 0, cls)
  }
  return best
}

const lineFiles = readdirSync(RAW_DIR).filter((f) => cfg.lineFile.test(f))
const seenWays = new Set()
const lineFeatures = []

for (const f of lineFiles) {
  let data
  try {
    data = readJSON(join(RAW_DIR, f))
  } catch {
    continue
  }
  for (const el of data.elements ?? []) {
    if (el.type !== 'way' || seenWays.has(el.id)) continue
    seenWays.add(el.id)
    if (!el.geometry) continue
    const tags = el.tags ?? {}
    const v = parseVoltClass(tags.voltage)
    if (!v) continue
    let pts = el.geometry.map((g) => [g.lon, g.lat])
    const probes = [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]]
    if (cfg.isForeignLine(probes)) continue
    if (cfg.keep && !probes.some((p) => cfg.keep(p))) continue
    const eps = cfg.simplifyEps ?? 0.00025
    const dpm = 10 ** (cfg.coordDp ?? 5)
    pts = simplify(pts, eps).map(([x, y]) => [Math.round(x * dpm) / dpm, Math.round(y * dpm) / dpm])
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

// ------------------------------------------------- merge contiguous ways
// OSM chops long circuits into many small ways; joining same-voltage chains
// at degree-2 junctions collapses tens of thousands of feature envelopes.
function mergeLines(features) {
  const key = ([x, y]) => `${x},${y}`
  const byV = new Map()
  for (const f of features) {
    if (!byV.has(f.properties.v)) byV.set(f.properties.v, [])
    byV.get(f.properties.v).push(f)
  }
  const merged = []
  for (const group of byV.values()) {
    const ends = new Map() // endpoint key -> [{i, end}]
    group.forEach((f, i) => {
      const c = f.geometry.coordinates
      for (const [pt, end] of [
        [c[0], 'a'],
        [c[c.length - 1], 'b'],
      ]) {
        const k = key(pt)
        if (!ends.has(k)) ends.set(k, [])
        ends.get(k).push({ i, end })
      }
    })
    const used = new Array(group.length).fill(false)
    const nextAt = (k, notI) => {
      const list = (ends.get(k) ?? []).filter((e) => !used[e.i] && e.i !== notI)
      return list.length === 1 && (ends.get(k) ?? []).length === 2 ? list[0] : null
    }
    for (let i = 0; i < group.length; i++) {
      if (used[i]) continue
      used[i] = true
      let coords = [...group[i].geometry.coordinates]
      const names = new Set()
      const ops = new Set()
      const collect = (f) => {
        if (f.properties.name) names.add(f.properties.name)
        if (f.properties.operator) ops.add(f.properties.operator)
      }
      collect(group[i])
      // extend forward from tail, then backward from head
      for (const dir of ['tail', 'head']) {
        for (;;) {
          const endPt = dir === 'tail' ? coords[coords.length - 1] : coords[0]
          const nx = nextAt(key(endPt), -1)
          if (!nx) break
          used[nx.i] = true
          collect(group[nx.i])
          let c = [...group[nx.i].geometry.coordinates]
          if (dir === 'tail') {
            if (nx.end === 'b') c.reverse()
            coords = coords.concat(c.slice(1))
          } else {
            if (nx.end === 'a') c.reverse()
            coords = c.slice(0, -1).concat(coords)
          }
        }
      }
      merged.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: {
          v: group[i].properties.v,
          name: names.size === 1 ? [...names][0] : null,
          operator: ops.size === 1 ? [...ops][0] : null,
          circuits: null,
        },
      })
    }
  }
  return merged
}
const mergedLineFeatures = mergeLines(lineFeatures)

// --------------------------------------------------------- interconnectors
const icFeatures = INTERCONNECTORS.filter((ic) => ic.countries.includes(country)).map((ic) => ({
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
// Region coastline: selection + antimeridian-safe clipping live in
// basemap.mjs (regenerate standalone with `npm run data:basemap`).
const REGION = REGIONS[cfg.region ?? 'eu']
const basemap = buildRegionBasemap(landFC, cfg.region ?? 'eu')

// ------------------------------------------------------------------ output
const write = (dir, name, obj) => {
  const s = JSON.stringify(obj)
  writeFileSync(join(dir, name), s)
  console.log(`${country}/${name}: ${(s.length / 1024).toFixed(0)} kB`)
}

// Slim at write time: absent and null mean the same to the app, and
// `osmType` (needed above for dedupe ranking) is already encoded in `id`.
for (const f of stationFeatures) {
  const slim = {}
  for (const [k, v] of Object.entries(f.properties)) {
    if (v === null || v === undefined || k === 'osmType') continue
    slim[k] = v
  }
  f.properties = slim
}
write(OUT_DIR, 'stations.json', { type: 'FeatureCollection', features: stationFeatures })
write(OUT_DIR, 'transmission.json', { type: 'FeatureCollection', features: mergedLineFeatures })
write(OUT_DIR, 'interconnectors.json', { type: 'FeatureCollection', features: icFeatures })
write(OUT_DIR, 'meta.json', {
  generated: new Date().toISOString().slice(0, 10),
  stationCount: stationFeatures.length,
  lineCount: mergedLineFeatures.length,
  attribution: 'Power data © OpenStreetMap contributors (ODbL). Coastline: Natural Earth.',
})
const sharedDir = join(__dirname, '..', 'src', 'data')
writeFileSync(join(sharedDir, REGION.file), JSON.stringify(basemap))

console.log(`stations: ${stationFeatures.length}, lines: ${lineFeatures.length}`)
const byFuel = {}
for (const f of stationFeatures) byFuel[f.properties.fuel] = (byFuel[f.properties.fuel] ?? 0) + 1
console.log(byFuel)
