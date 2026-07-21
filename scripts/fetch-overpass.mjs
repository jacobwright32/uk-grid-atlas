/**
 * fetch-overpass.mjs — reproducible raw-data download.
 *
 * Downloads every Overpass extract the pipeline needs into RAW_DIR
 * (default ../../data). Queries are split into modest regional boxes so
 * busy public Overpass servers accept them; results are cached — re-run
 * to fill in whatever previously failed.
 *
 *   node scripts/fetch-overpass.mjs [rawDir]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RAW_DIR = process.argv[2] ?? join(__dirname, '..', '..', 'data')
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

const QUERIES = {
  // ------------------------------------------------- generation stations
  'plants_uk.json': `[out:json][timeout:300][maxsize:1073741824];
area["ISO3166-1"="GB"][admin_level=2]->.uk;
( node["power"="plant"](area.uk); way["power"="plant"](area.uk); relation["power"="plant"](area.uk); );
out tags center;`,
  'wind_sea.json': `[out:json][timeout:300][maxsize:1073741824];
(
  way["power"="plant"]["plant:source"~"wind"](52.0,0.8,56.5,3.4);
  relation["power"="plant"]["plant:source"~"wind"](52.0,0.8,56.5,3.4);
  way["power"="plant"]["plant:source"~"wind"](55.9,-3.5,61.3,2.6);
  relation["power"="plant"]["plant:source"~"wind"](55.9,-3.5,61.3,2.6);
  way["power"="plant"]["plant:source"~"wind"](52.9,-5.6,55.2,-2.7);
  relation["power"="plant"]["plant:source"~"wind"](52.9,-5.6,55.2,-2.7);
);
out tags center;`,
  'wind_sea2.json': `[out:json][timeout:180][maxsize:536870912];
(
  way["power"="plant"]["plant:source"~"wind"](51.6,0.2,53.4,1.0);
  relation["power"="plant"]["plant:source"~"wind"](51.6,0.2,53.4,1.0);
  way["power"="plant"]["plant:source"~"wind"](51.7,1.0,52.1,2.1);
  relation["power"="plant"]["plant:source"~"wind"](51.7,1.0,52.1,2.1);
);
out tags center;`,
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
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cached(path) {
  if (!existsSync(path)) return false
  try {
    return Array.isArray(JSON.parse(readFileSync(path, 'utf8')).elements)
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
          signal: AbortSignal.timeout(280_000),
        })
        if (res.ok) {
          const text = await res.text()
          const parsed = JSON.parse(text)
          if (Array.isArray(parsed.elements)) {
            writeFileSync(path, text)
            console.log(`✓ ${name} — ${(text.length / 1024).toFixed(0)} kB via ${new URL(url).host}`)
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

let allOk = true
for (const [name, query] of Object.entries(QUERIES)) {
  const ok = await fetchOne(name, query)
  allOk &&= ok
  await sleep(5_000)
}
process.exit(allOk ? 0 : 1)
