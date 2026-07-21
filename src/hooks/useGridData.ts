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

const URLS: Record<CountryId, Bundle> = {
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
