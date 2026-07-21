import { useEffect, useState } from 'react'
import type { CountryId } from '../lib/countries'
import type { GridData } from '../lib/types'

import gbStations from '../data/gb/stations.json?url'
import gbTransmission from '../data/gb/transmission.json?url'
import gbInterconnectors from '../data/gb/interconnectors.json?url'
import gbMeta from '../data/gb/meta.json?url'
import nlStations from '../data/nl/stations.json?url'
import nlTransmission from '../data/nl/transmission.json?url'
import nlInterconnectors from '../data/nl/interconnectors.json?url'
import nlMeta from '../data/nl/meta.json?url'
import basemapUrl from '../data/basemap.json?url'

const URLS: Record<CountryId, { stations: string; transmission: string; interconnectors: string; meta: string }> = {
  gb: { stations: gbStations, transmission: gbTransmission, interconnectors: gbInterconnectors, meta: gbMeta },
  nl: { stations: nlStations, transmission: nlTransmission, interconnectors: nlInterconnectors, meta: nlMeta },
}

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`)
  return (await res.json()) as T
}

interface State {
  data: GridData | null
  error: string | null
}

const cache = new Map<CountryId, GridData>()
let basemapCache: GridData['basemap'] | null = null

/** Loads a country's GeoJSON bundles (cached per country after first load). */
export function useGridData(country: CountryId): State {
  const [state, setState] = useState<State>({ data: cache.get(country) ?? null, error: null })

  useEffect(() => {
    const cached = cache.get(country)
    if (cached) {
      setState({ data: cached, error: null })
      return
    }
    let cancelled = false
    const urls = URLS[country]
    Promise.all([
      fetchJSON<GridData['stations']>(urls.stations),
      fetchJSON<GridData['transmission']>(urls.transmission),
      fetchJSON<GridData['interconnectors']>(urls.interconnectors),
      basemapCache ? Promise.resolve(basemapCache) : fetchJSON<GridData['basemap']>(basemapUrl),
      fetchJSON<GridData['meta']>(urls.meta),
    ])
      .then(([stations, transmission, interconnectors, basemap, meta]) => {
        basemapCache = basemap
        const data: GridData = { stations, transmission, interconnectors, basemap, meta }
        cache.set(country, data)
        if (!cancelled) setState({ data, error: null })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({ data: null, error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [country])

  return state
}
