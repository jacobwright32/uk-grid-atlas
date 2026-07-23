/**
 * slim-bundles.mjs — shrink the shipped GeoJSON without changing what the
 * map shows (#8). Idempotent; run any time after data builds:
 *
 *   node scripts/slim-bundles.mjs [--us-eps 0.001]
 *
 *  - drops null-valued properties (the app treats absent and null the same)
 *  - drops the redundant `osmType` (already encoded in `id`)
 *  - rounds line coordinates to 4 dp (~11 m — far below line width on screen)
 *  - re-simplifies US transmission geometry (RDP) — its 36k segments carry
 *    far more vertices than any zoom level can show
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { simplify } from './pipeline-utils.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '..', 'src', 'data')
const usEpsArg = process.argv.indexOf('--us-eps')
const US_EPS = usEpsArg > 0 ? parseFloat(process.argv[usEpsArg + 1]) : 0.001

const r4 = (x) => Math.round(x * 1e4) / 1e4

function slimProps(props) {
  const out = {}
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue
    if (k === 'osmType') continue
    out[k] = v
  }
  return out
}

let before = 0
let after = 0
for (const cc of readdirSync(DATA)) {
  const dir = join(DATA, cc)
  if (!statSync(dir).isDirectory()) continue
  for (const kind of ['stations', 'transmission', 'interconnectors']) {
    const p = join(dir, `${kind}.json`)
    let raw
    try {
      raw = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    before += raw.length
    const fc = JSON.parse(raw)
    for (const f of fc.features) {
      f.properties = slimProps(f.properties)
      if (kind !== 'stations' && f.geometry.type === 'LineString') {
        let pts = f.geometry.coordinates
        if (cc === 'us' && kind === 'transmission' && US_EPS > 0) {
          pts = simplify(pts, US_EPS)
        }
        pts = pts.map(([x, y]) => [r4(x), r4(y)])
        // collapse consecutive duplicates created by rounding
        const out = [pts[0]]
        for (let i = 1; i < pts.length; i++) {
          const prev = out[out.length - 1]
          if (pts[i][0] !== prev[0] || pts[i][1] !== prev[1]) out.push(pts[i])
        }
        f.geometry.coordinates = out.length >= 2 ? out : pts.slice(0, 2)
      }
    }
    const slim = JSON.stringify(fc)
    after += slim.length
    writeFileSync(p, slim)
  }
}
console.log(
  `slimmed: ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB (${Math.round((1 - after / before) * 100)}% smaller)`,
)
