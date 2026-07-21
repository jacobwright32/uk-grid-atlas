/**
 * build-basemap.mjs — regenerate src/data/basemap*.json from Natural Earth
 * (the world-atlas package). Needs no raw Overpass extracts, so it can run
 * anywhere `npm ci` has run:
 *
 *   npm run data:basemap
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as topojson from 'topojson-client'
import { buildRegionBasemap, REGIONS } from './basemap.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const landTopo = JSON.parse(
  readFileSync(join(__dirname, '..', 'node_modules', 'world-atlas', 'land-10m.json'), 'utf8'),
)
const landFC = topojson.feature(landTopo, landTopo.objects.land)

for (const region of Object.keys(REGIONS)) {
  const fc = buildRegionBasemap(landFC, region)
  const s = JSON.stringify(fc)
  writeFileSync(join(__dirname, '..', 'src', 'data', REGIONS[region].file), s)
  console.log(
    `${REGIONS[region].file}: ${fc.features.length} features, ${(s.length / 1024).toFixed(0)} kB`,
  )
}
