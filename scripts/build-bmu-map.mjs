/**
 * build-bmu-map.mjs — map Elexon BMUs to map stations.
 *
 * Reads the BMU registration list (cached in RAW_DIR/bmunits.json, fetched
 * if absent) and src/data/stations.json, fuzzy-matches unit names to
 * stations with fuel-type guards + manual overrides, and writes
 * src/data/bmu-map.json. Prints a QA report of big unmatched units —
 * feed those into OVERRIDES as needed.
 *
 *   node scripts/build-bmu-map.mjs [rawDir]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matchUnit, tokens } from './live-matching.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RAW_DIR = process.argv[2] ?? join(__dirname, '..', '..', 'data')
const OUT = join(__dirname, '..', 'src', 'data', 'bmu-map.json')

/**
 * Manual BMU-prefix → station-name overrides for units whose registered
 * names don't resemble the site name. Keys are elexonBmUnit prefixes
 * (match = startsWith); values are exact station names from stations.json.
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
  T_SHOS: 'Shoreham Power Station',
  T_COSO: 'Coryton Power Station',
  T_KLYN: "King's Lynn Power Station",
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
  T_SHRSO: 'Sheringham Shoal Offshore Wind Farm',
  T_LARYO: 'London Array Wind Farm',
  T_THNTO: 'Thanet Offshore Wind Farm',
  T_GANW: 'Galloper Wind Farm',
  T_GRGBW: 'Greater Gabbard Wind Farm',
  T_GYMR: 'Gwynt y Môr Offshore Wind Farm',
  T_WLNYO: 'Walney Wind Farm',
  T_WLNYW: 'Walney Wind Farm',
  T_BOWLW: 'Barrow Wind Farm',
  E_BURBO: 'Burbo Bank Offshore Wind Farm',
  T_WDNSO: 'West of Duddon Sands Wind Farm',
  T_OMNDO: 'Ormonde Wind Farm',
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
  E_MEYGN: 'MeyGen Tidal Array',
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
  T_CORB: 'Corby Power Station',
  T_KEAD2: 'Keadby 2 Power Station',
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

const stations = JSON.parse(
  readFileSync(join(__dirname, '..', 'src', 'data', 'stations.json'), 'utf8'),
)

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

const byUnit = {}
const stationsOut = {}
let overridden = 0
let matched = 0
const unmatched = []

function assign(bmu, stationId, how) {
  byUnit[bmu.elexonBmUnit] = stationId
  const s = (stationsOut[stationId] ??= { units: [] })
  s.units.push({
    b: bmu.elexonBmUnit,
    name: bmu.bmUnitName ?? bmu.elexonBmUnit,
    cap: Math.round(Number(bmu.generationCapacity)),
  })
  if (how === 'override') overridden++
  else matched++
}

for (const bmu of candidates) {
  const ovKey = Object.keys(OVERRIDES).find((prefix) => bmu.elexonBmUnit.startsWith(prefix))
  if (ovKey) {
    const stationId = stationByName.get(OVERRIDES[ovKey])
    if (stationId) {
      assign(bmu, stationId, 'override')
      continue
    }
  }
  const hit = matchUnit(bmu, stationIndex)
  if (hit) assign(bmu, hit.stationId, 'fuzzy')
  else unmatched.push(bmu)
}

// Sentinel units for latest-metered-day discovery: prefer always-on baseload.
const sentinels = ['T_TORN-1', 'T_HEYM11', 'T_HRTL-1', 'T_DRAXX-2'].filter((b) => byUnit[b])

writeFileSync(
  OUT,
  JSON.stringify({ byUnit, stations: stationsOut, sentinels }),
)

const mappedStations = Object.keys(stationsOut).length
const mappedCap = candidates
  .filter((u) => byUnit[u.elexonBmUnit])
  .reduce((a, u) => a + Number(u.generationCapacity), 0)
const totalCap = candidates.reduce((a, u) => a + Number(u.generationCapacity), 0)

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
