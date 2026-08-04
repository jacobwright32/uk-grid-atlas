import { useEffect, useId, useRef, useState } from 'react'
import maplibregl, { Map as MLMap, Popup } from 'maplibre-gl'
// maplibre's own stylesheet comes in through skin.css, which @imports it above
// our overrides. Importing 'maplibre-gl/dist/maplibre-gl.css' here instead lets
// the bundler emit it as a separate file that can load *after* ours and blank
// the map (#100) — so don't. Skin also stays off the ?embed= path this way.
import '../map/skin.css'
import type { GridData, GroupId, NetworkToggles } from '../lib/types'
import type { BmuMap, LiveData } from '../lib/live'
import type { CountryConfig } from '../lib/countries'
import { createAtlasMap, installSourcesAndLayers, setAllSourceData } from '../map/setup'
import { wireInteractions } from '../map/interactions'
import type { Interactions } from '../map/interactions'
import { applyViewState } from '../map/viewState'
import { applyLiveView } from '../map/liveView'
import type { WeekScrubData } from '../map/liveView'
import type { CardContext } from '../map/popup'
import type { SearchTarget } from './SearchBox'

interface Props {
  data: GridData
  country: CountryConfig
  enabledGroups: ReadonlySet<GroupId>
  network: NetworkToggles
  tiles: boolean
  live: LiveData | null
  bmuMap: BmuMap | null
  /** Size dots by live output instead of capacity. */
  liveMode: boolean
  /** Bump to force a map.resize() (sidebar collapse etc.). */
  resizeSignal: number
  /** Fly to + pin a station picked in the search box (#19). */
  searchTarget: SearchTarget | null
  /** Metered-day interval to display, or null for live/day-average (#17). */
  timeIndex: number | null
  /**
   * Week-scrub override (#65): when set, timeIndex indexes these week-long
   * series instead of the metered day's. Null members mean that layer has
   * no weekly data (GB/US) — dots fall back to day-average, flows hide.
   */
  weekScrub: WeekScrubData | null
  /**
   * Pin permalinks (#22): fires with the station id when a station card is
   * pinned, and null when unpinned (or a non-station feature is pinned) —
   * App mirrors it into the URL hash.
   */
  onStationPin?: (id: string | null) => void
}

/**
 * The map orchestrator (#54): owns the MapLibre lifecycle and effect wiring;
 * everything with substance lives in src/map/ (setup, interactions,
 * viewState, liveView, layers, popup, style) where it's testable.
 */
export default function GridMap({
  data,
  country,
  enabledGroups,
  network,
  tiles,
  live,
  bmuMap,
  liveMode,
  resizeSignal,
  searchTarget,
  timeIndex,
  weekScrub,
  onStationPin,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const readyRef = useRef(false)
  const hintId = useId()
  // Narration for the keyboard roving selection (#12). `setState` identity is
  // stable, so the once-only interaction wiring can close over it directly.
  const [announcement, setAnnouncement] = useState('')
  // Latest data prop — progressive ALL loading can swap `data` several times
  // before the map's `load` event; the swap effect below bails until ready,
  // so `load` must replay the newest snapshot or those merges are lost.
  const dataRef = useRef(data)
  dataRef.current = data
  const interactionsRef = useRef<Interactions | null>(null)
  // Fresh callback for the once-only map handlers (App's writeHash closes
  // over the current country).
  const onPinRef = useRef(onStationPin)
  onPinRef.current = onStationPin
  const popupRef = useRef<Popup | null>(null)
  const cardCtxRef = useRef<CardContext>({ live: null, bmuMap: null })
  const tierKvs = country.tiers.map((t) => t.kvs) as [number[], number[], number[]]
  cardCtxRef.current = country.hasLive
    ? { live, bmuMap, countryName: country.name, tierKvs }
    : { live: null, bmuMap: null, tierKvs }

  /** Current props, bundled for the pure map-mutation helpers. */
  const viewArgs = () => ({ country, enabledGroups, network, tiles })
  const liveArgs = () => ({ data, country, live, liveMode, timeIndex, weekScrub })

  // ------------------------------------------------------------------ init
  useEffect(() => {
    const container = containerRef.current
    if (!container || mapRef.current) return

    const map = createAtlasMap(container, data, country.bounds)

    map.on('load', () => {
      installSourcesAndLayers(map, data)
      readyRef.current = true
      if (dataRef.current !== data) {
        // Data advanced while the style was loading — push the latest merge.
        setAllSourceData(map, dataRef.current)
      }
      applyViewState(map, viewArgs())
      applyLiveView(map, liveArgs())
    })

    const popup = new Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: '340px',
      offset: 14,
      className: 'grid-popup',
    })
    popupRef.current = popup

    const interactions = wireInteractions(
      map,
      popup,
      () => cardCtxRef.current,
      (id) => onPinRef.current?.(id),
      setAnnouncement,
    )
    interactionsRef.current = interactions

    mapRef.current = map
    // Debug/E2E handle (also handy in the browser console).
    ;(window as unknown as Record<string, unknown>).__ukgridMap = map
    return () => {
      interactions.cleanup()
      map.remove()
      mapRef.current = null
      interactionsRef.current = null
      readyRef.current = false
      delete (window as unknown as Record<string, unknown>).__ukgridMap
    }
    // The dataset is immutable for the lifetime of the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // MapLibre puts tabindex, role and aria-label on the <canvas> it creates, so
  // that — not our wrapper — is the element focus lands on and the element that
  // has to name the map and point at the key hints (#12).
  useEffect(() => {
    const canvas = mapRef.current?.getCanvas()
    if (!canvas) return
    canvas.setAttribute('aria-label', `Map of ${country.name} energy infrastructure`)
    canvas.setAttribute('aria-describedby', hintId)
  }, [country.name, hintId])

  // ------------------------------------------------------- state → style
  useEffect(() => {
    const map = mapRef.current
    if (map && readyRef.current) applyViewState(map, viewArgs())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledGroups, network, tiles])

  useEffect(() => {
    const map = mapRef.current
    if (map && readyRef.current) applyLiveView(map, liveArgs())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, liveMode, country, timeIndex, weekScrub])

  // ----------------------------------------------------- country data swap
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    interactionsRef.current?.clear()
    // The basemap differs per region (eu / na / merged for ALL) — without
    // this, switching e.g. GB → ALL leaves the US floating on open sea.
    setAllSourceData(map, data)
    applyViewState(map, viewArgs())
    applyLiveView(map, liveArgs())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    mapRef.current?.fitBounds(country.bounds, { padding: 24, duration: reduceMotion ? 0 : 900 })
  }, [country.id, country.bounds])

  useEffect(() => {
    if (resizeSignal === 0) return
    const t = setTimeout(() => mapRef.current?.resize(), 220)
    return () => clearTimeout(t)
  }, [resizeSignal])

  // ------------------------------------------------------- search → fly+pin
  useEffect(() => {
    const map = mapRef.current
    if (!map || !searchTarget) return
    const feature = data.stations.features.find((f) => f.properties.id === searchTarget.id)
    if (!feature) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    map.flyTo({
      center: searchTarget.coords,
      zoom: Math.max(map.getZoom(), 9.5),
      duration: reduceMotion ? 0 : 1200,
    })
    const fake = {
      properties: feature.properties,
      layer: { id: 'stations' },
    } as unknown as maplibregl.MapGeoJSONFeature
    interactionsRef.current?.pinStation(searchTarget.coords, fake)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTarget])

  return (
    <>
      {/* `role="application"` earns its keep now that the map has a real
          keyboard model (#12): without it, screen readers in browse mode
          swallow ] / [ / Enter before the canvas ever sees them. */}
      <div
        ref={containerRef}
        className="map-container"
        role="application"
        aria-label={`Map of ${country.name} energy infrastructure`}
      />
      <p id={hintId} className="sr-only">
        Press the right bracket and left bracket keys to step through the power stations currently
        in view, Enter to pin the selected station, Escape to release it. Arrow keys pan the map;
        plus and minus zoom.
      </p>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </>
  )
}
