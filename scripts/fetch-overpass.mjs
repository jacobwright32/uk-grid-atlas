/**
 * fetch-overpass.mjs — reproducible raw-data download.
 *
 * Downloads the Overpass extracts the pipeline needs into RAW_DIR
 * (default ../../data). Results are cached — re-run to fill in whatever
 * previously failed.
 *
 *   node scripts/fetch-overpass.mjs [country|all] [rawDir]
 *
 * GB is split into modest regional boxes so busy public Overpass servers
 * accept them; other countries use ISO3166 area queries (their power grids
 * are lighter than GB's 132 kV layer, so one query per voltage group works).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ?? 'gb'
const RAW_DIR = process.argv[3] ?? join(__dirname, '..', '..', 'data')
mkdirSync(RAW_DIR, { recursive: true })

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]
const UA = 'ukgrid-dashboard/1.0 (open-data pipeline)'
const HV = '400000|275000'

const box = (b, filter) =>
  `[out:json][timeout:240][maxsize:805306368];\n( way["power"="line"]["voltage"~"${filter}"](${b}); );\nout tags geom;`

/**
 * All power=plant elements inside a country's admin area, optionally
 * restricted to a bbox chunk — busy public servers accept several small
 * area∩bbox queries where one whole-country query times out. Chunks may
 * overlap; build-data de-duplicates by element id.
 */
const plantsArea = (iso, bbox) => {
  const b = bbox ? `(${bbox})` : ''
  return `[out:json][timeout:480][maxsize:1073741824];
area["ISO3166-1"="${iso}"][admin_level=2]->.cc;
( node["power"="plant"](area.cc)${b}; way["power"="plant"](area.cc)${b}; relation["power"="plant"](area.cc)${b}; );
out tags center;`
}

/** power=line ways of the given voltage classes inside a country (∩ bbox). */
const linesArea = (iso, filter, bbox) => {
  const b = bbox ? `(${bbox})` : ''
  return `[out:json][timeout:480][maxsize:1073741824];
area["ISO3166-1"="${iso}"][admin_level=2]->.cc;
( way["power"="line"]["voltage"~"${filter}"](area.cc)${b}; );
out tags geom;`
}

/** Offshore wind plants in explicit sea boxes (outside admin areas). */
const seaWind = (boxes) => `[out:json][timeout:300][maxsize:1073741824];
(
${boxes.map((b) => `  way["power"="plant"]["plant:source"~"wind"](${b});\n  relation["power"="plant"]["plant:source"~"wind"](${b});`).join('\n')}
);
out tags center;`

const QUERIES = {
  gb: {
    'plants_uk.json': plantsArea('GB'),
    'wind_sea.json': seaWind(['52.0,0.8,56.5,3.4', '55.9,-3.5,61.3,2.6', '52.9,-5.6,55.2,-2.7']),
    'wind_sea2.json': seaWind(['51.6,0.2,53.4,1.0', '51.7,1.0,52.1,2.1']),
    // ------------------------------------ 400/275 kV overhead transmission
    'lines_1.json': box('49.9,-6.5,52.2,1.8', HV),
    'lines_2.json': box('52.2,-5.4,54.0,1.8', HV),
    'lines_3.json': box('54.0,-3.7,55.9,-0.9', HV),
    'lines_4a1.json': box('54.6,-6.7,55.9,-4.4', HV),
    'lines_4a2.json': box('54.6,-4.4,55.9,-2.9', HV),
    'lines_4a3.json': box('54.6,-2.9,55.9,-1.5', HV),
    'lines_ni.json': box('54.0,-8.2,54.65,-5.4', HV),
    'lines_4b1w.json': box('55.9,-6.7,56.4,-4.0', HV),
    'lines_4b1e.json': box('55.9,-4.0,56.4,-1.5', HV),
    'lines_4b2.json': box('56.4,-6.7,57.2,-1.5', HV),
    'lines_5.json': box('57.2,-8.0,59.2,-1.4', HV),
    // -------------------------- 132 kV (transmission-voltage in Scotland)
    'lines_sct132.json': `[out:json][timeout:300][maxsize:1073741824];
area["ISO3166-2"="GB-SCT"][admin_level=4]->.sct;
( way["power"="line"]["voltage"~"132000"](area.sct); );
out tags geom;`,
  },
  no: {
    'plants_no_s.json': plantsArea('NO', '57.7,4.0,63.5,13.5'),
    'plants_no_m.json': plantsArea('NO', '63.5,7.0,67.5,18.0'),
    'plants_no_n.json': plantsArea('NO', '67.5,11.0,71.5,31.5'),
    'sea_no.json': seaWind(['56.5,2.0,63.0,7.5']),
    'no_lines_hv_s.json': linesArea('NO', '420000|400000|380000|300000', '57.7,4.0,63.5,13.5'),
    'no_lines_hv_m.json': linesArea('NO', '420000|400000|380000|300000', '63.5,7.0,67.5,18.0'),
    'no_lines_hv_n.json': linesArea('NO', '420000|400000|380000|300000', '67.5,11.0,71.5,31.5'),
    'no_lines_132_s.json': linesArea('NO', '132000', '57.7,4.0,63.5,13.5'),
    'no_lines_132_m.json': linesArea('NO', '132000', '63.5,7.0,67.5,18.0'),
    'no_lines_132_n.json': linesArea('NO', '132000', '67.5,11.0,71.5,31.5'),
  },
  se: {
    'plants_se_s.json': plantsArea('SE', '55.0,10.5,60.5,19.7'),
    'plants_se_n.json': plantsArea('SE', '60.5,11.5,69.3,24.4'),
    'sea_se.json': seaWind(['54.9,12.0,58.0,19.5', '58.0,16.5,61.0,19.5']),
    'se_lines_hv_s.json': linesArea('SE', '400000|380000|220000', '55.0,10.5,60.5,19.7'),
    'se_lines_hv_n.json': linesArea('SE', '400000|380000|220000', '60.5,11.5,69.3,24.4'),
    'se_lines_130_s.json': linesArea('SE', '130000|132000', '55.0,10.5,60.5,19.7'),
    'se_lines_130_n.json': linesArea('SE', '130000|132000', '60.5,11.5,69.3,24.4'),
  },
  pl: {
    'plants_pl_w.json': plantsArea('PL', '48.9,14.0,55.0,19.2'),
    'plants_pl_e.json': plantsArea('PL', '48.9,19.2,55.0,24.2'),
    'sea_pl.json': seaWind(['54.7,16.3,55.3,18.2']),
    'pl_lines_hv_w.json': linesArea('PL', '400000|380000|220000', '48.9,14.0,55.0,19.2'),
    'pl_lines_hv_e.json': linesArea('PL', '400000|380000|220000', '48.9,19.2,55.0,24.2'),
  },
  pt: {
    'plants_pt.json': plantsArea('PT'),
    'pt_lines_hv.json': linesArea('PT', '400000|380000|220000|150000'),
  },
  es: {
    'plants_es.json': plantsArea('ES'),
    'es_lines_hv_n.json': linesArea('ES', '400000|380000|220000', '39.5,-9.9,43.9,4.6'),
    'es_lines_hv_s.json': linesArea('ES', '400000|380000|220000', '35.7,-9.9,39.6,4.6'),
  },
  it: {
    'plants_it_n.json': plantsArea('IT', '44.0,6.5,47.2,14.1'),
    'plants_it_m.json': plantsArea('IT', '41.0,7.0,44.0,16.0'),
    'plants_it_s.json': plantsArea('IT', '36.4,8.0,41.3,18.7'),
    'it_lines_hv_n.json': linesArea('IT', '380000|400000|220000', '44.0,6.5,47.2,14.1'),
    'it_lines_hv_m.json': linesArea('IT', '380000|400000|220000', '41.0,7.0,44.0,16.0'),
    'it_lines_hv_s.json': linesArea('IT', '380000|400000|220000', '36.4,8.0,41.3,18.7'),
  },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cached(path) {
  if (!existsSync(path)) return false
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed.elements) && parsed.elements.length > 0
  } catch {
    return false
  }
}

async function fetchOne(name, query) {
  const path = join(RAW_DIR, name)
  if (cached(path)) {
    console.log(`✓ ${name} (cached)`)
    return true
  }
  for (let attempt = 1; attempt <= 8; attempt++) {
    for (const url of MIRRORS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(620_000),
        })
        if (res.ok) {
          const text = await res.text()
          const parsed = JSON.parse(text)
          if (Array.isArray(parsed.elements)) {
            writeFileSync(path, text)
            console.log(
              `✓ ${name} — ${(text.length / 1024).toFixed(0)} kB via ${new URL(url).host}`,
            )
            return true
          }
        }
        console.warn(`… ${name} HTTP ${res.status} via ${new URL(url).host} (attempt ${attempt})`)
      } catch (err) {
        console.warn(`… ${name} ${err.message} via ${new URL(url).host} (attempt ${attempt})`)
      }
      await sleep(15_000)
    }
    await sleep(30_000)
  }
  console.error(`✗ ${name} — all attempts failed`)
  return false
}

const countryIds = target === 'all' ? Object.keys(QUERIES) : [target]
let allOk = true
for (const cc of countryIds) {
  const queries = QUERIES[cc]
  if (!queries) {
    console.error(
      `Unknown country "${cc}" — expected one of: ${Object.keys(QUERIES).join(', ')}, all`,
    )
    process.exit(1)
  }
  for (const [name, query] of Object.entries(queries)) {
    const ok = await fetchOne(name, query)
    allOk &&= ok
    await sleep(5_000)
  }
}
process.exit(allOk ? 0 : 1)
