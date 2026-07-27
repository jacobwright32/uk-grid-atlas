/**
 * Guard: every fully-literal src/data path a script *reads* must exist.
 *
 * 1e608ba moved GB's data files from src/data into src/data/gb and left
 * build-bmu-map.mjs and fetch-live-snapshot.mjs reading the old root. Both
 * threw on their first read, so neither could run for six days — and nothing
 * noticed, because a build script that is never invoked in CI has no failing
 * test to point at. The bakers are only exercised by hand, so this is a static
 * check instead: scan the sources for read paths and confirm they resolve.
 *
 * Deliberately narrow. It only inspects `readFileSync(join(...))` where every
 * segment is a string literal (after resolving one level of `const X =
 * join(...)`), which is the shape a file move breaks. Country-parameterised
 * reads — `join(ROOT, 'src', 'data', cc, 'stations.json')` — are skipped
 * rather than guessed at; they take their directory from argv and so can't be
 * checked without running the script.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** String-literal args of a join(...) call, or null if any arg is an expression. */
function literalArgs(argText) {
  const parts = argText.split(',').map((s) => s.trim())
  const out = []
  for (const p of parts) {
    // The two roots every script derives from __dirname, plus '..' hops.
    if (p === '__dirname' || p === 'ROOT' || p === 'HERE') {
      out.push('@root')
      continue
    }
    const m = /^'([^']*)'$/.exec(p)
    if (!m) return null
    out.push(m[1])
  }
  return out
}

/** Resolve literal join() segments against the repo root. */
function resolveParts(parts, constMap) {
  const first = parts[0]
  let base
  if (first === '@root') base = ROOT
  else if (constMap.has(first)) base = constMap.get(first)
  else return null
  // '..' hops are relative to scripts/, not the repo root, so drop one level
  // per hop from a scripts-relative start.
  const rest = parts.slice(1).filter((p) => p !== '..')
  return join(base, ...rest)
}

const scripts = readdirSync(HERE).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))

describe('script data paths', () => {
  it.each(scripts)('%s reads only paths that exist', (file) => {
    const src = readFileSync(join(HERE, file), 'utf8')

    // Pass 1: `const NAME = join(<literals>)` — one level of indirection is
    // enough, and it is what both GB scripts use (GB_DIR / DATA_DIR).
    const constMap = new Map()
    for (const m of src.matchAll(/const (\w+) = join\(([^)]*)\)/g)) {
      const parts = literalArgs(m[2])
      if (!parts) continue
      const resolved = resolveParts(parts, constMap)
      if (resolved) constMap.set(m[1], resolved)
    }

    // Pass 2: reads. Only src/data paths — a script may legitimately read a
    // cache under RAW_DIR that is fetched on demand.
    const missing = []
    for (const m of src.matchAll(/readFileSync\(\s*join\(([^)]*)\)/g)) {
      const parts = literalArgs(m[1])
      if (!parts) continue
      const resolved = resolveParts(parts, constMap)
      if (!resolved || !resolved.includes(join('src', 'data'))) continue
      if (!existsSync(resolved)) missing.push(resolved.slice(ROOT.length + 1))
    }
    expect(missing, `${file} reads paths that no longer exist`).toEqual([])
  })

  it('still finds the GB reads it was written for', () => {
    // Belt and braces: if a refactor renames GB_DIR/DATA_DIR out of the shape
    // the regex understands, the loop above silently checks nothing. These are
    // the two files the original break hid behind.
    for (const p of ['src/data/gb/stations.json', 'src/data/gb/bmu-map.json'])
      expect(existsSync(join(ROOT, p)), p).toBe(true)
  })
})
