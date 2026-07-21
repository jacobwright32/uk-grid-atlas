import { useEffect, useState } from 'react'
import { loadLive } from '../lib/live'
import type { BmuMap, LiveData, SnapshotFile } from '../lib/live'

import bmuMapUrl from '../data/bmu-map.json?url'
import snapshotUrl from '../data/live-snapshot.json?url'

export type LiveStatus = 'loading' | 'live' | 'snapshot' | 'unavailable'

interface State {
  status: LiveStatus
  live: LiveData | null
  bmuMap: BmuMap | null
}

/**
 * Loads the BMU→station map, then live Elexon data (metered day, scheduled
 * now, national mix) with the bundled snapshot as offline fallback.
 */
export function useLiveData(): State {
  const [state, setState] = useState<State>({ status: 'loading', live: null, bmuMap: null })

  useEffect(() => {
    let cancelled = false
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
        if (!cancelled) setState({ status: 'unavailable', live: null, bmuMap: null })
        return
      }
      try {
        const live = await loadLive(bmuMap, snapshot)
        if (!cancelled)
          setState({ status: live.source === 'live' ? 'live' : 'snapshot', live, bmuMap })
      } catch {
        if (!cancelled) setState({ status: 'unavailable', live: null, bmuMap })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
