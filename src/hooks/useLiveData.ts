import { useEffect, useState } from 'react'
import { fetchMixNow, loadEntsoeSnapshot, loadLive } from '../lib/live'
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
// Failures are cached only briefly so a transient blip retries instead of
// wedging the whole session (#4).
const FAIL_TTL = 60_000
// Successful ENTSO-E snapshots expire too (#4): the workflow re-bakes every
// 6 h, so a session longer than that used to sit on the day it opened with.
// 15 min re-checks pick the new bake up promptly for one cheap request.
const SNAPSHOT_TTL = 15 * 60_000
const MIX_REFRESH = 5 * 60_000
const entsoeCache = new Map<string, { live: LiveData | null; at: number }>()
let elexonCache: { state: State; at: number } | null = null

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
      // Successes and failures both expire, just on very different clocks.
      const ttl = cached?.live ? SNAPSHOT_TTL : FAIL_TTL
      const fresh = cached != null && Date.now() - cached.at < ttl
      // Show the cached snapshot immediately even when it's stale —
      // revalidation happens behind it instead of blanking a working view.
      setState(
        cached?.live
          ? { status: 'live', live: cached.live, bmuMap: null }
          : cached
            ? IDLE
            : { status: 'loading', live: null, bmuMap: null },
      )
      if (fresh) return
      loadEntsoeSnapshot(country.id).then((live) => {
        // A failed re-check keeps the stale snapshot on screen; only its
        // timestamp advances, so the next attempt is another TTL away (#4).
        const next = live ?? cached?.live ?? null
        entsoeCache.set(country.id, { live: next, at: Date.now() })
        if (!cancelled) setState(next ? { status: 'live', live: next, bmuMap: null } : IDLE)
      })
      return () => {
        cancelled = true
      }
    }

    // ---- elexon (GB)
    // Refresh the near-real-time mix periodically while GB stays mounted, so
    // long sessions don't show stale "now" figures (#4).
    let mixTimer: ReturnType<typeof setInterval> | undefined
    const startMixRefresh = () => {
      mixTimer = setInterval(async () => {
        // A blip in the Elexon feed must not surface as an unhandled
        // rejection every five minutes — keep the last good figures instead.
        const mix = await fetchMixNow().catch(() => null)
        if (!mix) return
        setState((prev) => {
          if (!prev.live) return prev
          const next = { ...prev, live: { ...prev.live, mix } }
          if (elexonCache?.state.live) elexonCache = { state: next, at: Date.now() }
          return next
        })
      }, MIX_REFRESH)
    }

    const cachedElexon =
      elexonCache &&
      (elexonCache.state.status !== 'unavailable' || Date.now() - elexonCache.at < FAIL_TTL)
        ? elexonCache.state
        : null
    if (cachedElexon) {
      setState(cachedElexon)
      if (cachedElexon.live) startMixRefresh()
      return () => {
        if (mixTimer) clearInterval(mixTimer)
        cancelled = true
      }
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
        elexonCache = { state: IDLE, at: Date.now() }
        if (!cancelled) setState(IDLE)
        return
      }
      try {
        const live = await loadLive(bmuMap, snapshot)
        elexonCache = {
          state: { status: live.source === 'live' ? 'live' : 'snapshot', live, bmuMap },
          at: Date.now(),
        }
        if (!cancelled) {
          setState(elexonCache.state)
          startMixRefresh()
        }
      } catch {
        elexonCache = { state: { status: 'unavailable', live: null, bmuMap }, at: Date.now() }
        if (!cancelled) setState(elexonCache.state)
      }
    })()
    return () => {
      if (mixTimer) clearInterval(mixTimer)
      cancelled = true
    }
  }, [country.id, country.liveKind])

  return state
}
