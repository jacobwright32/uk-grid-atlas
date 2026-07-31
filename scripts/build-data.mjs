/**
 * build-data.mjs — turn raw Overpass extracts into per-country GeoJSON bundles.
 *
 *   node scripts/build-data.mjs <country> [rawDir]     country: any COUNTRIES key below
 *
 * Inputs  (RAW_DIR): country-specific raw extracts (see COUNTRIES below)
 * Outputs (src/data/<country>/): stations.json, transmission.json,
 *          interconnectors.json, meta.json  — plus shared src/data/basemap.json
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as topojson from 'topojson-client'
import { INTERCONNECTORS } from './interconnectors.mjs'
import { buildRegionBasemap, REGIONS } from './basemap.mjs'
import { inRing, parseCapacityMW, parseVoltClassWith, simplify, smooth } from './pipeline-utils.mjs'
import { tokens } from './live-matching.mjs'
import { stripUnit } from './cluster-wind.mjs'

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
    plantFiles: ['plants_at.json', 'plants_at_pbf.json', 'plants_at_wind_clusters.json'],
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
  si: {
    decimalComma: true,
    plantFiles: ['plants_si_pbf.json'],
    seaFiles: [],
    lineFile: /^si_lines.*\.json$/,
    // Geofabrik extract clips at the border; the 46 km of coast has no offshore wind.
    isForeignSea: () => false,
    isForeignLine: () => false,
    // ELES backbone is 400/220; 110 kV is a real transmission layer here (FI rule).
    classify: (volts) =>
      volts >= 380000 ? 400 : volts >= 200000 ? 220 : volts >= 100000 ? 110 : null,
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
    plantFiles: ['plants_ee.json', 'plants_ee_pbf.json', 'plants_ee_wind_clusters.json'],
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
    plantFiles: ['plants_fi.json', 'plants_fi_pbf.json', 'plants_fi_wind_clusters.json'],
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
    plantFiles: ['plants_ca_pbf.json', 'plants_ca_wind_clusters.json'],
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

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'))

// ---------------------------------------------------------------- land mask
// Built on demand (the 10m land file is expensive) so importing this module
// for its exported helpers stays free.
function landMask() {
  const landTopo = readJSON(join(__dirname, '..', 'node_modules', 'world-atlas', 'land-10m.json'))
  const landFC = topojson.feature(landTopo, landTopo.objects.land)

  // Use the region-clipped basemap rings, not the raw world-atlas polygons:
  // the raw Eurasia ring wraps the antimeridian, which breaks point-in-ring
  // north of ~63°N (Lapland read as sea — northern wind farms went
  // "offshore"). The basemap pipeline unwraps and clips, so its rings are
  // safe at every latitude.
  const landMaskFC = {
    features: ['eu', 'na'].flatMap((r) => buildRegionBasemap(landFC, r).features),
  }
  const landRings = []
  for (const f of landMaskFC.features) {
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

  return { landFC, onLand }
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

// ------------------------------------------------- station name de-dup (#6)
// OSM carries some farms several times over: an umbrella site plus per-phase
// entries spelled differently ("Hornsea One" / "Hornsea 1" / "Hornsea
// Project One", "Walney" + "Walney Extension"). Exact-name folding keeps them
// all, inflating both site counts and recorded capacity.

/**
 * stripUnit peels a trailing unit/phase designator; normalise the roman forms
 * it recognises onto digits so "Race Bank II" and "Race Bank 2" agree.
 * tokens()'s WORD_NUMBERS already covers the spelled-out forms ("One" → 1).
 */
const ROMAN_PHASE = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8' }

/** Words that only label a phase/variant, dropped from the folded key. */
const PHASE_NOISE = new Set(['phase', 'phases', 'stage', 'extension', 'extensions', 'ext'])

/**
 * …of which 'extension' is the one that marks a physically separate build, so
 * it stays as a capacity signature (see mergedCapacity below). STOPWORDS
 * deliberately keeps 'extension' for live matching — hence the local set.
 */
const VARIANT_WORDS = new Set(['extension', 'extensions', 'ext'])

/** Trailing designator ("Phase 2", "II", "WTG 7", "#12") → "2" / "7" / "12". */
function phaseMarker(tail) {
  const t = tail.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!t) return ''
  const digits = t.match(/\d{1,2}/)
  if (digits) return String(parseInt(digits[0], 10))
  return ROMAN_PHASE[t] ?? t
}

/**
 * Phase-folded name key, or null when the name has nothing distinctive left
 * to fold on ("Wind Farm 2" reduces to a bare number — two of those are not
 * the same site).
 *
 * The phase *number* is kept in the key on purpose: this fold makes different
 * spellings of one phase agree, it does not merge different phases (Hornsea 1
 * stays separate from Hornsea 2, and an umbrella "Race Bank" stays separate
 * from "Race Bank Phase 2" — a missed merge only leaves today's duplicate,
 * a wrong merge destroys a real site).
 */
export function phaseKey(name) {
  if (!name) return null
  const raw = String(name).trim()
  const base = stripUnit(raw)
  const marker = phaseMarker(raw.slice(base.length))
  const toks = tokens(base).filter((t) => !PHASE_NOISE.has(t))
  if (marker) toks.push(marker)
  if (!toks.some((t) => /^[a-z]{3,}$/.test(t))) return null
  return toks.join(' ')
}

/** '' for a plain name, 'ext' for an "… Extension" build. */
export function variantSig(name) {
  return tokens(name).some((t) => VARIANT_WORDS.has(t)) ? 'ext' : ''
}

/**
 * Does the name carry a phase/variant marker at all? tokens() has already
 * turned "One"/"II" into digits by this point.
 *
 * The fuzzy pass insists that at least one side of a merge has one, because
 * tokens() also strips generic industry words in several languages — Italy
 * alone has fifteen sites called "Impianto fotovoltaico" ("PV plant"), which
 * fold to the same key while being fifteen different solar parks. Requiring a
 * marker keeps the pass to what #6 is about: two spellings of one phase.
 */
export function hasPhaseMark(name) {
  return tokens(name).some((t) => PHASE_NOISE.has(t) || /^\d{1,2}$/.test(t))
}

/** Equirectangular km — good enough at the scale of one wind farm. */
function distKm([lon1, lat1], [lon2, lat2]) {
  const dx = (lon1 - lon2) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180) * 111.32
  const dy = (lat1 - lat2) * 111.32
  return Math.hypot(dx, dy)
}

const RANK = { relation: 3, way: 2, node: 1 }
// Phase blocks of one farm sit within a few km of each other; two unrelated
// "Mill Farm"s generally do not. Generous enough for adjacent offshore
// blocks, far short of "different region".
const PHASE_MERGE_KM = 25
// An identical name is much stronger evidence, and the node/way/relation
// copies of one huge offshore site can put their centroids ~10 km apart, so
// that pass gets a wider radius — but still a radius: GB alone has several
// unrelated "Hill Farm" solar parks, and merging two of them would delete a
// real station's MW.
const SAME_NAME_MERGE_KM = 60

/**
 * Label the station loop gives a nameless plant. It is a placeholder, not an
 * identity, so it never takes part in the fold — the old exact-name pass
 * likewise only ran for elements that carried a real name.
 */
export const UNNAMED = 'Unnamed site'

/**
 * Collapse duplicate station features, in two passes:
 *
 *  1. exact folded name (lowercase + whitespace collapse) — one site mapped
 *     twice as node/way/relation.
 *  2. phase-folded name (#6) — same phaseKey, same fuel group and a
 *     phase/variant marker on at least one side, e.g. "Hornsea One" /
 *     "Hornsea 1" / "Hornsea Project One", or "Walney" + "Walney Extension".
 *
 * Both passes require the two features to be near each other, so same-named
 * sites in different parts of the country never collapse; the fuzzy pass gets
 * the tighter radius of the two. Which feature survives is the pre-existing
 * rule: higher OSM element rank wins, then a known capacity beats an unknown
 * one.
 *
 * Capacity of a merged station is the sum over *distinct variants* of the
 * best value known for that variant. Aliases of one phase therefore count
 * once (no tripling Hornsea One/1/Project One) while a separate build
 * ("Walney" + "Walney Extension") contributes its own MW instead of being
 * silently dropped — merging without that turns a count fix into a capacity
 * regression.
 */
export function dedupeStations(features) {
  const out = []
  const byName = new Map() // folded name → indices in out
  const byPhase = new Map() // phase key → indices in out
  const variants = new Map() // index in out → Map(variant signature → MW)

  const remember = (map, key, idx) => {
    const at = map.get(key)
    if (at) {
      if (!at.includes(idx)) at.push(idx)
    } else {
      map.set(key, [idx])
    }
  }

  // Nearest candidate within maxKm, or null. Only the fuzzy pass insists on
  // the fuel group: an identically-named node often lacks the plant:source of
  // its relation and would otherwise stop de-duplicating.
  const nearest = (idxs, feature, maxKm, opts = {}) => {
    const { sameFuel = false, needMark = false } = opts
    let best = null
    let bestKm = Infinity
    for (const i of idxs ?? []) {
      if (sameFuel && out[i].properties.fuel !== feature.properties.fuel) continue
      if (needMark && !hasPhaseMark(out[i].properties.name)) continue
      const km = distKm(out[i].geometry.coordinates, feature.geometry.coordinates)
      if (km <= maxKm && km < bestKm) {
        best = i
        bestKm = km
      }
    }
    return best
  }

  const mergedCapacity = (idx) => {
    const mw = variants.get(idx)
    if (!mw?.size) return null
    return [...mw.values()].reduce((a, v) => a + v, 0)
  }

  const absorb = (idx, feature) => {
    const prev = out[idx]
    const mw = feature.properties.capacityMW
    const sig = variantSig(feature.properties.name)
    const known = variants.get(idx)
    if (mw != null) known.set(sig, Math.max(known.get(sig) ?? 0, mw))
    const better =
      RANK[feature.properties.osmType] > RANK[prev.properties.osmType] ||
      (RANK[feature.properties.osmType] === RANK[prev.properties.osmType] &&
        mw != null &&
        prev.properties.capacityMW == null)
    // Copy rather than edit in place: the input features stay as they were, so
    // a caller can compare before and after (and the raw count stays honest).
    const keep = better ? feature : prev
    out[idx] = { ...keep, properties: { ...keep.properties, capacityMW: mergedCapacity(idx) } }
  }

  for (const feature of features) {
    const { name, capacityMW } = feature.properties
    if (!name || name === UNNAMED) {
      out.push(feature)
      continue
    }
    const norm = name.toLowerCase().replace(/\s+/g, ' ').trim()
    const key = phaseKey(name)
    const fuzzy = { sameFuel: true, needMark: !hasPhaseMark(name) }
    const hit =
      nearest(byName.get(norm), feature, SAME_NAME_MERGE_KM) ??
      (key == null ? null : nearest(byPhase.get(key), feature, PHASE_MERGE_KM, fuzzy))
    const idx = hit ?? out.length
    if (hit != null) {
      absorb(hit, feature)
    } else {
      out.push(feature)
      variants.set(idx, new Map(capacityMW != null ? [[variantSig(name), capacityMW]] : []))
    }
    // Both spellings now point at the group, so a third copy of either lands
    // on it too.
    remember(byName, norm, idx)
    if (key != null) remember(byPhase, key, idx)
  }
  return out
}

/**
 * Read one raw line extract. A truncated file used to be skipped in silence,
 * dropping a whole region from the transmission layer while the run still
 * reported a confident count (#15).
 */
export function readLineFile(dir, name) {
  try {
    return { data: readJSON(join(dir, name)) }
  } catch (err) {
    console.warn(`✗ ${name} unreadable — ${err.message} (#15)`)
    return { error: err }
  }
}

// ------------------------------------------------- merge contiguous ways
// OSM chops long circuits into many small ways; joining same-voltage chains
// at degree-2 junctions collapses tens of thousands of feature envelopes.
export function mergeLines(features) {
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
      const circuits = new Set()
      const collect = (f) => {
        if (f.properties.name) names.add(f.properties.name)
        if (f.properties.operator) ops.add(f.properties.operator)
        if (f.properties.circuits != null) circuits.add(f.properties.circuits)
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
          // Was hardcoded null, which quietly discarded every circuits tag
          // parsed upstream — the property shipped but was never once set.
          // Same rule as name/operator: keep it only when the whole chain agrees.
          circuits: circuits.size === 1 ? [...circuits][0] : null,
        },
      })
    }
  }
  return merged
}

function main() {
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
  const { landFC, onLand } = landMask()

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

  const rawStations = []

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
    const SMALL_FUELS = new Set([
      'solar',
      'wind_onshore',
      'bioenergy',
      'waste',
      'storage',
      'marine',
    ])
    if (capacityMW != null && capacityMW > 1500 && SMALL_FUELS.has(group)) {
      capacityMW = capacityMW / 1000 >= 0.05 ? Math.round(capacityMW) / 1000 : null
    }

    const feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coords },
      properties: {
        id: `${el.type}/${el.id}`,
        name: name ?? UNNAMED,
        fuel: group,
        source: tags['plant:source'] ?? null,
        method: tags['plant:method'] ?? null,
        capacityMW,
        operator: tags.operator ?? null,
        start: tags.start_date ?? null,
        osmType: el.type,
      },
    }

    rawStations.push(feature)
  }

  // Exact-name de-dup plus the phase/variant fold (#6).
  const stationFeatures = dedupeStations(rawStations)

  // ------------------------------------------------------------------- lines
  const parseVoltClass = (v) => parseVoltClassWith(cfg.classify, v)

  const lineFiles = readdirSync(RAW_DIR).filter((f) => cfg.lineFile.test(f))
  const seenWays = new Set()
  const lineFeatures = []
  // A region's worth of transmission going missing must not pass for a clean
  // run: the plant path above throws, so this one counts, warns and exits
  // non-zero rather than dropping the file in silence (#15).
  let lineFailures = 0

  for (const f of lineFiles) {
    const { data, error } = readLineFile(RAW_DIR, f)
    if (error) {
      lineFailures++
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
      pts = simplify(pts, eps).map(([x, y]) => [
        Math.round(x * dpm) / dpm,
        Math.round(y * dpm) / dpm,
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

  const dropped = rawStations.length - stationFeatures.length
  console.log(
    `stations: ${stationFeatures.length} (${dropped} name-duplicate/phase merges), ` +
      `lines: ${lineFeatures.length}` +
      (lineFailures ? `, UNREADABLE LINE FILES: ${lineFailures} of ${lineFiles.length}` : ''),
  )
  const byFuel = {}
  for (const f of stationFeatures) byFuel[f.properties.fuel] = (byFuel[f.properties.fuel] ?? 0) + 1
  console.log(byFuel)
  // Outputs are written first (they are still useful) but the run is a
  // failure: whoever ran it must re-fetch the broken extracts (#15).
  if (lineFailures) {
    console.error(
      `✗ ${country}: ${lineFailures} line file(s) could not be read — transmission layer is incomplete`,
    )
    process.exitCode = 1
  }
}

// Import-safe for tests: only run when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
