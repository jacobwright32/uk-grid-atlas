/**
 * build-tiles.mjs — bake every country's transmission lines into one
 * PMTiles vector archive (#8 payload endgame).
 *
 *   node scripts/build-tiles.mjs [tippecanoe-path]
 *
 * Reads src/data/<cc>/transmission.json (all countries), tags each feature
 * with its country code, and runs tippecanoe → public/tiles/transmission.pmtiles.
 * The archive is committed like public/live so deploys stay a static copy.
 * Rendering fetches only the tiles in view (HTTP range requests — GitHub
 * Pages supports them), so the ALL view stops paying for 20 MB of lines.
 *
 * Requires tippecanoe ≥ 2.17 (native PMTiles output): github.com/felt/tippecanoe
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DATA_DIR = join(ROOT, 'src', 'data')
const OUT_DIR = join(ROOT, 'public', 'tiles')
mkdirSync(OUT_DIR, { recursive: true })

const tippecanoe = process.argv[2] ?? 'tippecanoe'

// ------------------------------------------------ merge, tagged per country
const features = []
for (const cc of readdirSync(DATA_DIR)) {
  const path = join(DATA_DIR, cc, 'transmission.json')
  try {
    statSync(path)
  } catch {
    continue
  }
  const fc = JSON.parse(readFileSync(path, 'utf8'))
  for (const f of fc.features) {
    f.properties.cc = cc
    features.push(f)
  }
  console.log(`${cc}: ${fc.features.length} segments`)
}

const merged = join(OUT_DIR, '_merged.geojson')
writeFileSync(merged, JSON.stringify({ type: 'FeatureCollection', features }))
console.log(`merged: ${features.length} segments`)

// ------------------------------------------------------------- tippecanoe
const out = join(OUT_DIR, 'transmission.pmtiles')
execFileSync(
  tippecanoe,
  [
    '-o',
    out,
    '--force',
    '-l',
    'transmission',
    '-Z2', // the ALL view sits near z2.4 — sources don't underzoom
    '-z11',
    '--drop-densest-as-needed',
    '--simplification=6',
    '-y',
    'v',
    '-y',
    'cc',
    '-y',
    'name',
    '-y',
    'operator',
    '-y',
    'circuits',
    merged,
  ],
  { stdio: 'inherit' },
)
execFileSync('rm', ['-f', merged])
const kb = Math.round(statSync(out).size / 1024)
console.log(`\npublic/tiles/transmission.pmtiles — ${kb} kB`)
