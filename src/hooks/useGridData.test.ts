// Progressive ALL loader race tests (#60): the shipped bug was merges being
// dropped around load timing — these pin the ordering/failure semantics with
// an injected per-country loader (no fetch mocking needed; the race logic
// lives in loadAllProgressive itself).
import { describe, expect, it } from 'vitest'
import { loadAllProgressive } from './useGridData'
import { REAL_COUNTRY_IDS } from '../lib/countries'
import type { RealCountryId } from '../lib/countries'
import type { GridData } from '../lib/types'

/** Minimal-but-valid one-station bundle for country `id`. */
function bundle(id: string): GridData {
  const fc = (features: unknown[]) => ({ type: 'FeatureCollection', features })
  return {
    stations: fc([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: { id: `${id}/station`, name: id, fuel: 'wind_onshore' },
      },
    ]),
    transmission: fc([]),
    interconnectors: fc([]),
    basemap: fc([]),
    meta: { generatedAt: '', counts: {} },
  } as unknown as GridData
}

/** A loader whose per-country resolution the test controls explicitly. */
function controlledLoader(failIds: Set<string> = new Set()) {
  const resolvers = new Map<string, () => void>()
  const load = (id: RealCountryId) =>
    new Promise<GridData>((resolve, reject) => {
      resolvers.set(id, () =>
        failIds.has(id) ? reject(new Error(`${id} down`)) : resolve(bundle(id)),
      )
    })
  const settle = (id: string) => {
    resolvers.get(id)?.()
    // let the loader's then-chain run
    return new Promise((r) => setTimeout(r, 0))
  }
  return { load, settle }
}

const ids = [...REAL_COUNTRY_IDS]

describe('loadAllProgressive (#60)', () => {
  it('fires onUpdate per arrival with a growing merge, in any order', async () => {
    const { load, settle } = controlledLoader()
    const sizes: number[] = []
    const cache = new Map<string, GridData>()
    const run = loadAllProgressive(
      (d) => sizes.push(d.stations.features.length),
      () => {},
      {
        load,
        cache,
        concurrency: 99,
      },
    )
    // resolve in reverse order — the shipped bug was order-sensitivity
    for (const id of [...ids].reverse()) await settle(id)
    await run
    expect(sizes).toHaveLength(ids.length)
    expect(sizes).toEqual(ids.map((_, i) => i + 1)) // strictly growing merges
    expect(cache.get('all')?.stations.features).toHaveLength(ids.length)
  })

  it('skips a failed country, renders the rest, and never caches the partial', async () => {
    const { load, settle } = controlledLoader(new Set(['de']))
    const sizes: number[] = []
    const counts: number[] = []
    let errored = false
    const cache = new Map<string, GridData>()
    const run = loadAllProgressive(
      (d, failures) => {
        sizes.push(d.stations.features.length)
        counts.push(failures)
      },
      () => {
        errored = true
      },
      { load, cache, concurrency: 99 },
    )
    for (const id of ids) await settle(id)
    await run
    expect(sizes).toHaveLength(ids.length - 1)
    expect(Math.max(...sizes)).toBe(ids.length - 1)
    expect(errored).toBe(false) // partial success is success (#3)
    // …but the UI has to be told, so it can own up to a partial map (#3).
    expect(counts.at(-1)).toBe(1)
    expect(cache.has('all')).toBe(false) // transient failure must heal next visit
  })

  it('re-announces the settled count when the failure lands after the last arrival (#3)', async () => {
    const { load, settle } = controlledLoader(new Set(['de']))
    const counts: number[] = []
    const cache = new Map<string, GridData>()
    const run = loadAllProgressive(
      (_d, failures) => counts.push(failures),
      () => {},
      { load, cache, concurrency: 99 },
    )
    // Every success first, the failure last: without the post-settle
    // re-announce, every onUpdate would have carried failures = 0 and the
    // notice would never appear.
    for (const id of ids.filter((i) => i !== 'de')) await settle(id)
    await settle('de')
    await run
    expect(counts).toHaveLength(ids.length) // 21 arrivals + 1 re-announce
    expect(counts.slice(0, -1).every((c) => c === 0)).toBe(true)
    expect(counts.at(-1)).toBe(1)
  })

  it('reports zero failures on a clean load, so the notice stays hidden (#3)', async () => {
    const { load, settle } = controlledLoader()
    const counts: number[] = []
    const cache = new Map<string, GridData>()
    const run = loadAllProgressive(
      (_d, failures) => counts.push(failures),
      () => {},
      { load, cache, concurrency: 99 },
    )
    for (const id of ids) await settle(id)
    await run
    expect(counts).toHaveLength(ids.length)
    expect(counts.every((c) => c === 0)).toBe(true)
  })

  it('reports the first error when every bundle fails', async () => {
    const { load, settle } = controlledLoader(new Set(ids))
    let err: unknown = null
    const cache = new Map<string, GridData>()
    const run = loadAllProgressive(
      () => {
        throw new Error('onUpdate must never fire with zero bundles')
      },
      (e) => {
        err = e
      },
      { load, cache, concurrency: 99 },
    )
    for (const id of ids) await settle(id)
    await run
    expect(err).toBeInstanceOf(Error)
    expect(cache.has('all')).toBe(false)
  })

  it('serves a cached ALL merge without touching the loader', async () => {
    const cache = new Map<string, GridData>()
    cache.set('all', bundle('cached'))
    let loads = 0
    const updates: GridData[] = []
    await loadAllProgressive(
      (d) => updates.push(d),
      () => {},
      {
        load: async () => {
          loads++
          return bundle('x')
        },
        cache,
      },
    )
    expect(updates).toHaveLength(1)
    expect(loads).toBe(0)
  })
})
