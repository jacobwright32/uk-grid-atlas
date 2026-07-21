import { useEffect, useState } from 'react'
import type { GridData } from '../lib/types'

import stationsUrl from '../data/stations.json?url'
import transmissionUrl from '../data/transmission.json?url'
import interconnectorsUrl from '../data/interconnectors.json?url'
import basemapUrl from '../data/basemap.json?url'
import metaUrl from '../data/meta.json?url'

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`)
  return (await res.json()) as T
}

interface State {
  data: GridData | null
  error: string | null
}

/**
 * Loads the pre-built GeoJSON bundles. Served as hashed static assets in a
 * normal build; inlined as data: URLs in the single-file build — the same
 * fetch() path handles both.
 */
export function useGridData(): State {
  const [state, setState] = useState<State>({ data: null, error: null })

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetchJSON<GridData['stations']>(stationsUrl),
      fetchJSON<GridData['transmission']>(transmissionUrl),
      fetchJSON<GridData['interconnectors']>(interconnectorsUrl),
      fetchJSON<GridData['basemap']>(basemapUrl),
      fetchJSON<GridData['meta']>(metaUrl),
    ])
      .then(([stations, transmission, interconnectors, basemap, meta]) => {
        if (!cancelled) setState({ data: { stations, transmission, interconnectors, basemap, meta }, error: null })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ data: null, error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
