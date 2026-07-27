/**
 * build-bmu-map.mjs — map Elexon BMUs to map stations.
 *
 * Reads the BMU registration list (cached in RAW_DIR/bmunits.json, fetched
 * if absent) and src/data/gb/stations.json, fuzzy-matches unit names to
 * stations with fuel-type guards + manual overrides, and writes
 * src/data/gb/bmu-map.json. Prints a QA report of big unmatched units —
 * feed those into OVERRIDES as needed. The same QA pass is persisted next to
 * the map as bmu-map-report.json (scores, ambiguous near-ties, unrecognised
 * fuel codes) so a run is diffable after the terminal is gone (#11).
 *
 *   node scripts/build-bmu-map.mjs [rawDir]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BROAD_MIN_SCORE,
  MIN_SCORE,
  NEAR_TIE_DELTA,
  isNearTie,
  matchUnit,
  tokens,
  unknownFuelCounts,
} from './live-matching.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RAW_DIR = process.argv[2] ?? join(__dirname, '..', '..', 'data')
// BMUs are GB-only, so this reads and writes the GB country dir. Both paths
// pointed at the old pre-multi-country src/data root until now, which has held
// nothing but the two basemaps since 1e608ba moved GB's files into src/data/gb
// — so the script threw on the stations read and could not have run at all.
const GB_DIR = join(__dirname, '..', 'src', 'data', 'gb')
const OUT = join(GB_DIR, 'bmu-map.json')
// Match report sits beside the map, same as the EU side keeps its unit
// registry + unmatchedTop in data/entsoe-maps/<cc>.json (#11).
const REPORT = join(dirname(OUT), 'bmu-map-report.json')

/**
 * Manual BMU-prefix → station-name overrides for units whose registered
 * names don't resemble the site name. Keys are elexonBmUnit prefixes
 * (match = startsWith), **longest match wins**, so a full unit id can sit
 * beside a shorter site-wide prefix; values are exact station names from
 * stations.json.
 *
 * Every way an entry can be wrong is silent — a key no BMU starts with, or a
 * value that isn't a station name, just doesn't fire and the unit drops through
 * to the fuzzy matcher as if the line weren't here. build-bmu-map.test.mjs
 * checks both sides against the registry and stations.json, which is how six
 * long-dead keys (T_SHOS/T_CORB for E_ units, T_SHRSO/T_LARYO/T_OMNDO for the
 * -W wind ids, T_KLYN duplicating E_KLYN) turned up.
 */
const OVERRIDES = {
  T_DRAXX: 'Drax Power Station',
  T_HEYM1: 'Heysham Nuclear Power Station',
  T_HEYM2: 'Heysham Nuclear Power Station',
  T_HRTL: 'Hartlepool Nuclear Power Station',
  T_TORN: 'Torness Nuclear Power Station',
  T_SIZB: 'Sizewell B Nuclear Power Station',
  T_PEMB: 'Pembroke Power Station',
  T_PEHE: 'Peterhead Power Station',
  T_STAY: 'Staythorpe C Power Station',
  T_GRAI: 'Grain CHP',
  T_CNQPS: 'Connahs Quay Power Station',
  T_DIDCB: 'Didcot B Power Station',
  T_WBURB: 'West Burton B Power Station',
  T_SHBA: 'South Humber Bank Power Station',
  T_SCCL: 'Saltend Power Station',
  T_MRWD: 'Marchwood Power Station',
  T_SEAB: 'Seabank Power Station',
  T_ROCK: 'Rocksavage Power Station',
  T_CDCL: 'Cottam Development Centre',
  T_SPLN: 'Spalding Power Station',
  T_LAGA: 'Langage Power Station',
  E_SHOS: 'Shoreham Power Station',
  T_COSO: 'Coryton Power Station',
  T_CARR: 'Carrington Power Station',
  T_KEAD: 'Keadby Power Station',
  T_DAMC: 'Damhead Creek Power Station',
  T_HOWAO: 'Hornsea 1 Offshore Wind Farm',
  T_HOWBO: 'Hornsea 2 Offshore Wind Farm',
  T_HOWCO: 'Hornsea 3 Offshore Wind Farm',
  T_DBAWO: 'Dogger Bank A Wind Farm',
  T_DBBWO: 'Dogger Bank B Wind Farm',
  T_SGRWO: 'Seagreen Offshore Wind Farm',
  T_MOWEO: 'Moray East Wind Farm',
  T_MOWWO: 'Moray West Wind Farm',
  T_NNGAO: 'Neart na Gaoithe Wind Farm',
  T_TKNEW: 'Triton Knoll Wind Farm',
  T_TKNWW: 'Triton Knoll Wind Farm',
  T_EAAO: 'East Anglia ONE',
  T_RCBKO: 'Race Bank Wind Farm',
  T_DDGNO: 'Dudgeon Offshore Wind Farm',
  T_SHRSW: 'Sheringham Shoal Offshore Wind Farm',
  T_LARYW: 'London Array Wind Farm',
  T_THNTO: 'Thanet Wind Farm',
  T_GANW: 'Galloper Wind Farm',
  T_GRGBW: 'Greater Gabbard Wind Farm',
  T_GYMR: 'Gwynt y Môr Offshore Wind Farm',
  T_WLNYO: 'Walney Wind Farm',
  T_WLNYW: 'Walney Wind Farm',
  T_BOWLW: 'Barrow Wind Farm',
  E_BURBO: 'Burbo Bank Offshore Wind Farm',
  T_WDNSO: 'West of Duddon Sands Wind Farm',
  T_OMNDW: 'Ormonde Wind Farm',
  T_BRBEO: 'Burbo Bank Offshore Wind Farm',
  T_RMPNO: 'Rampion Wind Farm',
  T_BEATO: 'Beatrice Wind Farm',
  T_WTMSO: 'Westermost Rough Wind Farm',
  T_HMGTO: 'Humber Gateway Wind Farm',
  T_LNCSW: 'Lincs Wind Farm',
  T_DINO: 'Dinorwig Power Station',
  T_FFES: 'Ffestiniog Power Station',
  T_CRUA: 'Cruachan Power Station',
  T_FOYE: 'Foyers Power Station',
  E_MEYGN: 'MeyGen tidal energy project',
  T_HUMR: 'Immingham Power Station',
  T_RYHPS: 'Rye House Power Station',
  T_SUTB: 'Sutton Bridge Power Station',
  T_SOFOW: 'Sofia Wind Farm',
  T_EECL: 'Enfield Power Station',
  T_SVRP: 'Severn Power Station',
  T_KILLPG: 'Killingholme B Power Station',
  T_WHILW: 'Whitelee Wind Farm',
  T_SEEL: 'Spalding Power Station',
  T_TSREP: 'Teesport Renewable Energy Plant',
  E_KLYN: "King's Lynn Power Station",
  T_MEDP: 'Medway Power Station',
  E_CORB: 'Corby Power Station',
  // Elexon registers Keadby 2 as T_KEAD-2 ("Keadby-2 Main", 890 MW), not
  // T_KEAD2-1 — so the T_KEAD2 key this replaces matched nothing, and the
  // T_KEAD prefix above quietly credited Keadby 2's output to the Keadby 1
  // station. Longest-prefix matching is what lets this sit next to T_KEAD.
  'T_KEAD-2': 'Keadby 2 Power Station',
  T_PNYCW: 'Pen y Cymoedd',
  T_KLGLW: 'Kilgallioch Wind Farm',
  T_CLDCW: 'Clyde Wind Farm',
  T_CLDNW: 'Clyde Wind Farm',
  T_CLDSW: 'Clyde Wind Farm',
  T_AKGLW: 'Aikengall II Wind Farm',
  T_BLWNB: 'Thornton Greener Grid Park',
  T_WILCT: 'Wilton Power Station',
  T_THUPG: 'Thurrock Storage',
  E_FAWN: 'Fawley National Power Cogen (NPC) power station',
  T_GLNDO: 'Glendoe Hydro Scheme',
  T_CUMHW: 'Cumberhead Wind Farm',
  T_DUNGW: 'Dunmaglass Wind Farm',
  T_INDQ: 'Indian Queens Power Station',
  T_THURB: 'Thurcroft Battery Storage',
  T_LKSDB: 'Lakeside Energy Park',

  // --- Containment pairs the BROAD_MIN_SCORE gate can't reach (#11) ---
  // Jaccard measures overlap, so it punishes a name that is a strict subset of
  // the other. Elexon drops the descriptor word OSM carries ("Iron Acton" vs
  // "Iron Acton BESS"): 2 shared of 3 total = 0.67, just under the 0.7 broad
  // floor. Because 'battery'/'storage'/'bess' are deliberately NOT stopwords —
  // they're what tells a co-located BESS apart from the wind farm sharing its
  // name — this lands almost entirely on GB's battery fleet. Each of these was
  // checked by hand against stations.json; the near-misses that were *wrong*
  // (ClayTye Farm 2 and Jamesfield 2 both grabbing "Stranoch 2 battery
  // storage", "Little Raith BESS" grabbing the Little Raith wind farm) are
  // left rejected, which is the whole point of the floor.
  //
  // Keys are full unit ids, not prefixes: E_BURWB-1/-2/-3 are three different
  // sites, as are Crystal Rig II/III/IV and Beinn an Tuirc 2/III, so a bare
  // prefix would collapse siblings onto one station.
  'E_ARBRB-1': 'Arbroath Battery',
  'E_BTNHL-1': 'Barton Hill STOR',
  'E_BURWB-3': 'Burwell 2 BESS',
  'E_DOLLB-1': 'Dollymans Battery Storage',
  'E_NEWPB-1': 'Field Newport BESS',
  'T_IRNAB-1': 'Iron Acton BESS',
  'T_NTRVB-1': 'Native River BESS',
  'T_BLPFS-1': 'Bulphan Fen Solar Farm',
  // Two Elexon units on one OSM site; the map is unit -> station, so both point
  // at the same feature.
  'E_RDFRD-1': 'Redfield Road Gas Generation Plant',
  'E_RDFRB-1': 'Redfield Road Gas Generation Plant',
  // Wind phases: these clear their own floor but lose the station to a sibling
  // unit with the same tokens, so pin them explicitly.
  'E_BTUIW-3': 'Beinn an Tuirc III Wind Farm',
  'E_CMSTW-2': 'Camster II Wind Farm',
  'T_CRYRW-2': 'Crystal Rig II',
  'T_CRYRW-3': 'Crystal Rig III wind farm',
}

async function loadBmunits() {
  const cache = join(RAW_DIR, 'bmunits.json')
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'))
  const res = await fetch('https://data.elexon.co.uk/bmrs/api/v1/reference/bmunits/all', {
    headers: { 'User-Agent': 'ukgrid-dashboard/1.0' },
  })
  if (!res.ok) throw new Error(`bmunits fetch failed: ${res.status}`)
  const text = await res.text()
  writeFileSync(cache, text)
  return JSON.parse(text)
}

const stations = JSON.parse(readFileSync(join(GB_DIR, 'stations.json'), 'utf8'))

const stationByName = new Map()
const stationIndex = []
for (const f of stations.features) {
  const p = f.properties
  if (p.name === 'Unnamed site') continue
  stationByName.set(p.name, p.id)
  stationIndex.push({ id: p.id, fuel: p.fuel, toks: tokens(p.name), name: p.name })
}

const all = await loadBmunits()

/** Generation-capable, directly-connected or embedded BM units. */
const candidates = all.filter(
  (u) =>
    (u.bmUnitType === 'T' || u.bmUnitType === 'E') &&
    !u.interconnectorId &&
    u.fuelType !== 'INTFR' &&
    Number(u.generationCapacity) >= 5 &&
    u.elexonBmUnit,
)

const stationNameById = new Map(stationIndex.map((s) => [s.id, s.name]))
const round3 = (n) => Math.round(n * 1000) / 1000
const unitRow = (bmu) => ({
  b: bmu.elexonBmUnit,
  name: bmu.bmUnitName ?? bmu.elexonBmUnit,
  fuel: bmu.fuelType ?? null,
  mw: Math.round(Number(bmu.generationCapacity)),
})
const stationRef = (hit) => ({
  station: hit.stationId,
  name: stationNameById.get(hit.stationId) ?? null,
  score: round3(hit.score),
})

const byUnit = {}
const stationsOut = {}
const matches = []
const nearTies = []
let overridden = 0
let matched = 0
const unmatched = []

function assign(bmu, stationId, how, hit = null) {
  byUnit[bmu.elexonBmUnit] = stationId
  const s = (stationsOut[stationId] ??= { units: [] })
  s.units.push({
    b: bmu.elexonBmUnit,
    name: bmu.bmUnitName ?? bmu.elexonBmUnit,
    cap: Math.round(Number(bmu.generationCapacity)),
  })
  matches.push({
    ...unitRow(bmu),
    station: stationId,
    stationName: stationNameById.get(stationId) ?? null,
    how,
    score: hit ? round3(hit.score) : null, // overrides are authoritative, unscored
  })
  if (how === 'override') overridden++
  else matched++
}

// Longest prefix wins. Plain declaration order silently mismapped Keadby 2:
// `T_KEAD` sits above `T_KEAD2` in the table, so `T_KEAD2-1` — a separate
// 893 MW CCGT with its own OSM feature — matched the Keadby 1 entry first and
// its output was attributed to the wrong station. Sorting by length makes the
// table order-independent, so a future pair like this can't regress.
const OVERRIDE_KEYS = Object.keys(OVERRIDES).sort((a, b) => b.length - a.length)

for (const bmu of candidates) {
  const ovKey = OVERRIDE_KEYS.find((prefix) => bmu.elexonBmUnit.startsWith(prefix))
  if (ovKey) {
    const stationId = stationByName.get(OVERRIDES[ovKey])
    if (stationId) {
      assign(bmu, stationId, 'override')
      continue
    }
  }
  const hit = matchUnit(bmu, stationIndex)
  if (!hit) {
    unmatched.push(bmu)
    continue
  }
  assign(bmu, hit.stationId, 'fuzzy', hit)
  // A runner-up this close means the name alone can't tell the two apart —
  // these are the matches that are silently wrong (#11).
  if (isNearTie(hit)) {
    nearTies.push({
      ...unitRow(bmu),
      won: stationRef(hit),
      runnerUp: stationRef(hit.runnerUp),
      delta: round3(hit.score - hit.runnerUp.score),
    })
  }
}

// Sentinel units for latest-metered-day discovery: prefer always-on baseload.
const sentinels = ['T_TORN-1', 'T_HEYM11', 'T_HRTL-1', 'T_DRAXX-2'].filter((b) => byUnit[b])

writeFileSync(OUT, JSON.stringify({ byUnit, stations: stationsOut, sentinels }))

const mappedStations = Object.keys(stationsOut).length
const mappedCap = candidates
  .filter((u) => byUnit[u.elexonBmUnit])
  .reduce((a, u) => a + Number(u.generationCapacity), 0)
const totalCap = candidates.reduce((a, u) => a + Number(u.generationCapacity), 0)

// Unlike the 20-country EU registry (which caps at unmatchedTop: 20), GB is one
// country, so the whole unmatched list fits and stays diffable.
unmatched.sort((a, b) => Number(b.generationCapacity) - Number(a.generationCapacity))
const unknownFuelTypes = unknownFuelCounts()
writeFileSync(
  REPORT,
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      unitCount: candidates.length,
      matchedCount: matched + overridden,
      fuzzyCount: matched,
      overrideCount: overridden,
      unmatchedCount: unmatched.length,
      matchRatio: round3((matched + overridden) / candidates.length),
      stationCount: mappedStations,
      capacityMW: { mapped: Math.round(mappedCap), total: Math.round(totalCap) },
      thresholds: {
        minScore: MIN_SCORE,
        broadMinScore: BROAD_MIN_SCORE,
        nearTieDelta: NEAR_TIE_DELTA,
      },
      unknownFuelTypes,
      nearTies: nearTies.sort((a, b) => a.delta - b.delta || a.b.localeCompare(b.b)),
      matches: matches.sort((a, b) => a.b.localeCompare(b.b)),
      unmatched: unmatched.map(unitRow),
    },
    null,
    1,
  ),
)

console.log(
  `bmu-map: ${matched} fuzzy + ${overridden} override = ${matched + overridden}/${candidates.length} units → ${mappedStations} stations`,
)
console.log(
  `capacity coverage: ${Math.round(mappedCap / 1000)} GW of ${Math.round(totalCap / 1000)} GW BM-registered (${Math.round((100 * mappedCap) / totalCap)}%)`,
)
console.log('\nTop unmatched units (add OVERRIDES for any that matter):')
for (const u of unmatched
  .sort((a, b) => Number(b.generationCapacity) - Number(a.generationCapacity))
  .slice(0, 25)) {
  console.log(
    `  ${u.elexonBmUnit.padEnd(14)} ${String(u.fuelType).padEnd(8)} ${String(
      Math.round(Number(u.generationCapacity)),
    ).padStart(5)} MW  ${u.bmUnitName}`,
  )
}

console.log(
  `\nambiguous matches (runner-up within ${NEAR_TIE_DELTA}): ${nearTies.length}; unrecognised fuelTypes: ${
    Object.keys(unknownFuelTypes).length
  }`,
)
console.log(`match report: ${REPORT}`)
