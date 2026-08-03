/**
 * Coverage surface (#96): live/coverage.json is baked by the snapshot
 * workflow from what the published files actually contain — the sidebar's
 * "published data" block reads it here, and the python package reads the
 * same file as weg.coverage(). One fetch per session, shared by reference.
 */
import { useEffect, useState } from 'react'

export interface GridCoverage {
  source: string
  snapshot: boolean
  browserLive: boolean
  generatedAt: string | null
  meteredDate: string | null
  perStationLive: number
  intraday: boolean
  prices: boolean
  demand: boolean
  flows: 'net' | 'hvdc' | 'none'
  links: number
  historyDays: number
  hourlyDays: number
  perStationHistoryDays: number
  priceDays: number
  demandDays: number
  currency: string | null
}

export interface CoverageFile {
  version: number
  generatedAt: string
  grids: Record<string, GridCoverage>
}

// undefined = never fetched · null = fetch failed (or not yet baked)
let cached: CoverageFile | null | undefined
let inflight: Promise<CoverageFile | null> | null = null

function fetchCoverage(): Promise<CoverageFile | null> {
  inflight ??= fetch('live/coverage.json', { signal: AbortSignal.timeout(20_000) })
    .then((r) => (r.ok ? (r.json() as Promise<CoverageFile>) : null))
    .catch(() => null)
    .then((c) => {
      cached = c
      return c
    })
  return inflight
}

/** Test hook: forget the module-level cache. */
export function resetCoverageCache(): void {
  cached = undefined
  inflight = null
}

/**
 * Measured publication coverage for one grid — null while loading, when the
 * file isn't baked yet, or for ids it doesn't carry ('all').
 */
export function useCoverage(countryId: string): GridCoverage | null {
  const [file, setFile] = useState<CoverageFile | null>(cached ?? null)
  useEffect(() => {
    if (cached !== undefined) return
    let on = true
    fetchCoverage().then((c) => {
      if (on) setFile(c)
    })
    return () => {
      on = false
    }
  }, [])
  return file?.grids[countryId] ?? null
}
