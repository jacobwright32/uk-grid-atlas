/**
 * Static checks on build-bmu-map.mjs's OVERRIDES table.
 *
 * The table is the designed escape hatch for units the name matcher can't
 * reach, and every way it can be wrong is *silent*: a key that matches no real
 * BMU id, or a value that isn't a station name, simply doesn't fire and the
 * unit falls through to the matcher as if the entry were never written. That is
 * how `T_KEAD2` sat in the table doing nothing while Keadby 2's 890 MW was
 * credited to Keadby 1 (Elexon registers it as `T_KEAD-2`).
 *
 * Parsed out of the source rather than imported: the script does its work at
 * module top level, so importing it would rebuild the map as a side effect.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = readFileSync(join(HERE, 'build-bmu-map.mjs'), 'utf8')

/** key -> station name, read straight out of the literal. */
const overrides = (() => {
  const start = SRC.indexOf('const OVERRIDES = {')
  const end = SRC.indexOf('\n}', start)
  expect(start, 'OVERRIDES table not found — did it get renamed?').toBeGreaterThan(-1)
  const body = SRC.slice(start, end)
  const out = {}
  for (const m of body.matchAll(/^\s*'?([A-Z0-9_-]+)'?:\s*(['"])(.*?)\2,?$/gm)) out[m[1]] = m[3]
  return out
})()

const stationNames = (() => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'gb', 'stations.json'), 'utf8'))
  const feats = raw.features ?? raw
  return new Set(feats.map((f) => (f.properties ? f.properties.name : f.name)))
})()

describe('build-bmu-map OVERRIDES', () => {
  it('parses a plausible number of entries', () => {
    // Guard against the regex silently matching nothing after a reformat.
    expect(Object.keys(overrides).length).toBeGreaterThan(90)
  })

  it('points every entry at a station name that exists in stations.json', () => {
    const dangling = Object.entries(overrides)
      .filter(([, name]) => !stationNames.has(name))
      .map(([key, name]) => `${key} -> ${name}`)
    expect(dangling, 'override targets no longer in stations.json').toEqual([])
  })

  it('resolves each unit by longest matching prefix, not declaration order', () => {
    // Mirrors the lookup in build-bmu-map.mjs. `T_KEAD` and `T_KEAD-2` both
    // prefix `T_KEAD-2`; the specific one has to win regardless of where it
    // sits in the table.
    const keys = Object.keys(overrides).sort((a, b) => b.length - a.length)
    const resolve = (unit) => keys.find((prefix) => unit.startsWith(prefix))
    expect(resolve('T_KEAD-2')).toBe('T_KEAD-2')
    expect(resolve('T_KEAD-1')).toBe('T_KEAD')
    expect(resolve('T_KEADGT-3')).toBe('T_KEAD')
    expect(overrides['T_KEAD-2']).toBe('Keadby 2 Power Station')
    expect(overrides['T_KEAD']).toBe('Keadby Power Station')
  })

  it('has no key that can never fire because a shorter key resolves it first', () => {
    // With the longest-prefix sort this should be impossible, so a failure here
    // means the lookup in build-bmu-map.mjs stopped sorting.
    const keys = Object.keys(overrides).sort((a, b) => b.length - a.length)
    const dead = keys.filter((k) => keys.find((p) => k.startsWith(p)) !== k)
    expect(dead, 'unreachable override keys').toEqual([])
  })

  /**
   * Keys with no BMU today for a reason, not a typo. Both stations are real and
   * on the map; only their Elexon registration is missing, so the entry is
   * waiting rather than broken. Anything else absent from the registry is a
   * silent no-op and should fail.
   */
  const UNREGISTERED = new Set([
    'T_HOWCO', // Hornsea 3 — under construction, no BMU registered yet
    'E_MEYGN', // MeyGen tidal — no longer in the registration list
  ])

  const cache = join(ROOT, '..', 'data', 'bmunits.json')
  it.skipIf(!existsSync(cache))('matches at least one registered BMU per key', () => {
    const raw = JSON.parse(readFileSync(cache, 'utf8'))
    const ids = (Array.isArray(raw) ? raw : (raw.data ?? [])).map((u) => u.elexonBmUnit ?? '')
    const dead = Object.keys(overrides)
      .filter((k) => !UNREGISTERED.has(k))
      .filter((k) => !ids.some((id) => id.startsWith(k)))
    // A dead key is a no-op that reads like a fix — exactly the T_KEAD2 trap.
    expect(dead, 'override keys matching no BMU in the Elexon registry').toEqual([])
  })

  it.skipIf(!existsSync(cache))('keeps the UNREGISTERED allowlist honest', () => {
    const raw = JSON.parse(readFileSync(cache, 'utf8'))
    const ids = (Array.isArray(raw) ? raw : (raw.data ?? [])).map((u) => u.elexonBmUnit ?? '')
    // Once Elexon registers one of these, drop it from the list so the strict
    // check covers it again.
    const nowLive = [...UNREGISTERED].filter((k) => ids.some((id) => id.startsWith(k)))
    expect(nowLive, 'allowlisted keys that now have a BMU — remove them').toEqual([])
    const stale = [...UNREGISTERED].filter((k) => !(k in overrides))
    expect(stale, 'allowlisted keys no longer in OVERRIDES').toEqual([])
  })
})
