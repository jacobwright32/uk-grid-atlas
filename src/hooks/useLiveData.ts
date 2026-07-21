import { useEffect, useState } from 'react'
import { loadEntsoeSnapshot, loadLive } from '../lib/live'
import type { BmuMap, LiveData, SnapshotFile } from '../lib/live'
import type { CountryConfig } from '../lib/countries'

import bmuMapUrl from '../data/gb/bmu-map.json?url'
import snapshotUrl from '../data/gb/live-snapshot.json?url'

export type LiveStatus = 'loading' | 'live' | 'snapshot' | 'unavailable'

interface State {
  status: LiveStatus
  live: LiveData | null
  bmuMap: BmuMap | null
}

const IDLE: State = { status: 'unavailable', live: null, bmuMap: null }
const entsoeCache = new Map<string, LiveData | null>()
let elexonCache: State | null = null

/**
 * Country-aware live data:
 *  - 'elexon' (GB): browser calls the Elexon API directly, bundled snapshot fallback.
 *  - 'entsoe' (EU): committed snapshot from public/live/<cc>.json, refreshed
 *    by the scheduled workflow (needs the ENTSOE_TOKEN repo secret).
 *  - 'none': no live layer.
 */
export function useLiveData(country: CountryConfig): State {
  const [state, setState] = useState<State>({ status: 'loading', live: null, bmuMap: null })

  useEffect(() => {
    let cancelled = false
    const kind = country.liveKind

    if (kind === 'none') {
      setState(IDLE)
      return
    }

    if (kind === 'entsoe') {
      const cached = entsoeCache.get(country.id)
      if (cached !== undefined) {
        setState(cached ? { status: 'live', live: cached, bmuMap: null } : IDLE)
        return
      }
      setState({ status: 'loading', live: null, bmuMap: null })
      loadEntsoeSnapshot(country.id).then((live) => {
        entsoeCache.set(country.id, live)
        if (!cancelled) setState(live ? { status: 'live', live, bmuMap: null } : IDLE)
      })
      return () => {
        cancelled = true
      }
    }

    // ---- elexon (GB)
    if (elexonCache) {
      setState(elexonCache)
      return
    }
    setState({ status: 'loading', live: null, bmuMap: null })
    ;(async () => {
      let bmuMap: BmuMap | null = null
      let snapshot: SnapshotFile | null = null
      try {
        bmuMap = (await (await fetch(bmuMapUrl)).json()) as BmuMap
      } catch {
        /* no map → no live layer at all */
      }
      try {
        snapshot = (await (await fetch(snapshotUrl)).json()) as SnapshotFile
      } catch {
        /* snapshot optional */
      }
      if (!bmuMap) {
        elexonCache = IDLE
        if (!cancelled) setState(IDLE)
        return
      }
      try {
        const live = await loadLive(bmuMap, snapshot)
        elexonCache = {
          status: live.source === 'live' ? 'live' : 'snapshot',
          live,
          bmuMap,
        }
        if (!cancelled) setState(elexonCache)
      } catch {
        elexonCache = { status: 'unavailable', live: null, bmuMap }
        if (!cancelled) setState(elexonCache)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [country.id, country.liveKind])

  return state
}
