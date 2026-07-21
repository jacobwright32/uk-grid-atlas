import { useEffect, useState } from 'react'
import { REAL_COUNTRY_IDS } from '../lib/countries'
import type { CountryId, RealCountryId } from '../lib/countries'
import { mergeGridData } from '../lib/merge'
import type { GridData } from '../lib/types'

import gbStations from '../data/gb/stations.json?url'
import gbTransmission from '../data/gb/transmission.json?url'
import gbInterconnectors from '../data/gb/interconnectors.json?url'
import gbMeta from '../data/gb/meta.json?url'
import nlStations from '../data/nl/stations.json?url'
import nlTransmission from '../data/nl/transmission.json?url'
import nlInterconnectors from '../data/nl/interconnectors.json?url'
import nlMeta from '../data/nl/meta.json?url'
import beStations from '../data/be/stations.json?url'
import beTransmission from '../data/be/transmission.json?url'
import beInterconnectors from '../data/be/interconnectors.json?url'
import beMeta from '../data/be/meta.json?url'
import ieStations from '../data/ie/stations.json?url'
import ieTransmission from '../data/ie/transmission.json?url'
import ieInterconnectors from '../data/ie/interconnectors.json?url'
import ieMeta from '../data/ie/meta.json?url'
import dkStations from '../data/dk/stations.json?url'
import dkTransmission from '../data/dk/transmission.json?url'
import dkInterconnectors from '../data/dk/interconnectors.json?url'
import dkMeta from '../data/dk/meta.json?url'
import frStations from '../data/fr/stations.json?url'
import frTransmission from '../data/fr/transmission.json?url'
import frInterconnectors from '../data/fr/interconnectors.json?url'
import frMeta from '../data/fr/meta.json?url'
import deStations from '../data/de/stations.json?url'
import deTransmission from '../data/de/transmission.json?url'
import deInterconnectors from '../data/de/interconnectors.json?url'
import deMeta from '../data/de/meta.json?url'
import basemapUrl from '../data/basemap.json?url'

type Bundle = { stations: string; transmission: string; interconnectors: string; meta: string }

const URLS: Record<RealCountryId, Bundle> = {
  gb: { stations: gbStations, transmission: gbTransmission, interconnectors: gbInterconnectors, meta: gbMeta },
  nl: { stations: nlStations, transmission: nlTransmission, interconnectors: nlInterconnectors, meta: nlMeta },
  be: { stations: beStations, transmission: beTransmission, interconnectors: beInterconnectors, meta: beMeta },
  ie: { stations: ieStations, transmission: ieTransmission, interconnectors: ieInterconnectors, meta: ieMeta },
  dk: { stations: dkStations, transmission: dkTransmission, interconnectors: dkInterconnectors, meta: dkMeta },
  fr: { stations: frStations, transmission: frTransmission, interconnectors: frInterconnectors, meta: frMeta },
  de: { stations: deStations, transmission: deTransmission, interconnectors: deInterconnectors, meta: deMeta },
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

async function loadCountry(id: RealCountryId): Promise<GridData> {
  const cached = cache.get(id)
  if (cached) return cached
  const urls = URLS[id]
  const [stations, transmission, interconnectors, basemap, meta] = await Promise.all([
    fetchJSON<GridData['stations']>(urls.stations),
    fetchJSON<GridData['transmission']>(urls.transmission),
    fetchJSON<GridData['interconnectors']>(urls.interconnectors),
    basemapCache ? Promise.resolve(basemapCache) : fetchJSON<GridData['basemap']>(basemapUrl),
    fetchJSON<GridData['meta']>(urls.meta),
  ])
  basemapCache = basemap
  const data: GridData = { stations, transmission, interconnectors, basemap, meta }
  cache.set(id, data)
  return data
}

async function loadAll(): Promise<GridData> {
  const cached = cache.get('all')
  if (cached) return cached
  const bundles = await Promise.all(REAL_COUNTRY_IDS.map((id) => loadCountry(id)))
  const merged = mergeGridData(bundles)
  cache.set('all', merged)
  return merged
}

/** Loads a country's GeoJSON bundles ('all' merges every country, cached). */
export function useGridData(country: CountryId): State {
  const [state, setState] = useState<State>({ data: cache.get(country) ?? null, error: null })

  useEffect(() => {
    const cached = cache.get(country)
    if (cached) {
      setState({ data: cached, error: null })
      return
    }
    let cancelled = false
    ;(country === 'all' ? loadAll() : loadCountry(country))
      .then((data) => {
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
