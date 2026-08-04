// Cascade invariants (#100). The atlas shipped blank because of a pure ordering
// accident: MapLibre's stylesheet and ours collide on single-class selectors of
// equal specificity — `.maplibregl-map` vs `.map-container`, plus the
// ctrl-group / attribution / scale chrome — so whichever emitted file loads last
// wins. Making App a dynamic chunk (#97) split maplibre's CSS into its own file
// that loaded *after* App.css; `position: relative` beat
// `position: absolute; inset: 0`, the map container collapsed to 0 px tall and
// the canvas drew into nothing. Every other signal stayed green: the map
// reported loaded(), rendered its features and threw no errors.
//
// The rule that keeps this from recurring: everything that can collide with
// maplibre's sheet lives in src/map/skin.css, below the @import that pulls that
// sheet in. One file, one order, no bundler in the loop.
//
// e2e-smoke.mjs measures rendered geometry in a real browser and catches the
// symptom; these three catch the cause in a millisecond and name it.
//
// Lives in scripts/ (not src/) because vitest stubs `.css` imports to an empty
// module unless `css: true`, so a `?raw` import of a stylesheet reads as ''.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('..', import.meta.url).pathname
const MAPLIBRE_CSS = "@import 'maplibre-gl/dist/maplibre-gl.css';"
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const read = (p) => strip(readFileSync(join(ROOT, p), 'utf8'))

const skin = read('src/map/skin.css')

function sourceFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

/** Selectors, one per comma-separated part, in source order. */
function selectors(css) {
  return [...css.matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1].trim())
    .filter((s) => s && !s.startsWith('@'))
    .flatMap((s) => s.split(',').map((p) => p.trim()))
}

describe('CSS cascade invariants (#100)', () => {
  it('skin.css pulls in maplibre ahead of every rule of ours', () => {
    const importAt = skin.indexOf(MAPLIBRE_CSS)
    expect(importAt, 'maplibre @import missing from src/map/skin.css').toBeGreaterThanOrEqual(0)
    const firstRuleAt = skin.indexOf('{')
    expect(firstRuleAt, 'skin.css has no rules?').toBeGreaterThan(0)
    expect(importAt, 'maplibre must be imported before our own rules').toBeLessThan(firstRuleAt)
  })

  it('every maplibre-colliding rule lives in skin.css, not in a sheet that loads separately', () => {
    for (const sheet of ['src/App.css', 'src/index.css']) {
      const strays = selectors(read(sheet)).filter(
        (s) => s.includes('maplibregl') || /\.map-container\b/.test(s),
      )
      expect(strays, `${sheet} must not restyle maplibre — move it to src/map/skin.css`).toEqual([])
    }
  })

  it('no module imports the maplibre stylesheet from JS', () => {
    // An import statement, not a mention — GridMap.tsx names the path in a
    // comment explaining precisely why it must not import it.
    const jsImport =
      /^\s*import\s+(?:[\w*{},\s]+from\s+)?['"]maplibre-gl\/dist\/maplibre-gl\.css['"]/m
    const offenders = sourceFiles(join(ROOT, 'src'))
      .filter((p) => jsImport.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(ROOT.length))
    expect(offenders, 'a JS-side import splits maplibre CSS into its own chunk file').toEqual([])
  })

  it('keeps the two-class hardening rule on the map container', () => {
    expect(skin).toMatch(/\.map-container\.maplibregl-map\s*\{[^}]*position:\s*absolute[^}]*\}/)
  })
})
