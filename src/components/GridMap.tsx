import { useEffect, useRef } from 'react'
import maplibregl, { Map as MLMap, Popup } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { GridData, GroupId, NetworkToggles } from '../lib/types'
import type { BmuMap, LiveData } from '../lib/live'
import type { CountryConfig } from '../lib/countries'
import { stationFilter } from '../lib/filter'
import { buildBaseStyle, CARTO_SOURCE } from '../map/style'
import {
  INTERACTIVE_LAYERS,
  interconnectorLayers,
  liveStationLayer,
  stationLayers,
  transmissionLayers,
} from '../map/layers'
import { cardFor } from '../map/popup'
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
}

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
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const readyRef = useRef(false)
  // Latest data prop — progressive ALL loading can swap `data` several times
  // before the map's `load` event; the swap effect below bails until ready,
  // so `load` must replay the newest snapshot or those merges are lost.
  const dataRef = useRef(data)
  dataRef.current = data
  const hoverIdRef = useRef<number | string | null>(null)
  const pinnedRef = useRef(false)
  const popupRef = useRef<Popup | null>(null)
  const cardCtxRef = useRef<CardContext>({ live: null, bmuMap: null })
  const tierKvs = country.tiers.map((t) => t.kvs) as [number[], number[], number[]]
  cardCtxRef.current = country.hasLive
    ? { live, bmuMap, countryName: country.name, tierKvs }
    : { live: null, bmuMap: null, tierKvs }

  // ------------------------------------------------------------------ init
  useEffect(() => {
    const container = containerRef.current
    if (!container || mapRef.current) return

    const map = new maplibregl.Map({
      container,
      style: buildBaseStyle(data.basemap),
      bounds: country.bounds,
      fitBoundsOptions: { padding: 24 },
      minZoom: 2,
      maxZoom: 15,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    })
    map.touchZoomRotate.disableRotation()
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution:
          'Power data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL) · Coastline: Natural Earth',
      }),
      'bottom-right',
    )
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')

    map.on('load', () => {
      // Optional raster underlay slot (kept hidden until toggled).
      map.addSource('carto', CARTO_SOURCE)
      map.addLayer(
        {
          id: 'carto',
          type: 'raster',
          source: 'carto',
          layout: { visibility: 'none' },
          paint: { 'raster-opacity': 0.85 },
        },
        'land',
      )

      map.addSource('transmission', { type: 'geojson', data: data.transmission })
      map.addSource('interconnectors', { type: 'geojson', data: data.interconnectors })
      map.addSource('stations', { type: 'geojson', data: data.stations, generateId: true })

      for (const layer of transmissionLayers('transmission')) map.addLayer(layer)
      for (const layer of interconnectorLayers('interconnectors')) map.addLayer(layer)
      for (const layer of stationLayers('stations')) map.addLayer(layer)
      map.addLayer(liveStationLayer('stations'))

      readyRef.current = true
      if (dataRef.current !== data) {
        // Data advanced while the style was loading — push the latest merge.
        const src = (id: string) => map.getSource(id) as maplibregl.GeoJSONSource | undefined
        src('land')?.setData(dataRef.current.basemap as never)
        src('stations')?.setData(dataRef.current.stations as never)
        src('transmission')?.setData(dataRef.current.transmission as never)
        src('interconnectors')?.setData(dataRef.current.interconnectors as never)
      }
      applyState(map)
      applyLiveState(map)
    })

    const popup = new Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: '340px',
      offset: 14,
      className: 'grid-popup',
    })
    popupRef.current = popup

    const clearHover = () => {
      if (hoverIdRef.current != null) {
        map.setFeatureState({ source: 'stations', id: hoverIdRef.current }, { hover: false })
        hoverIdRef.current = null
      }
    }

    const pick = (point: maplibregl.PointLike & { x: number; y: number }) => {
      const pad = 5
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [point.x - pad, point.y - pad],
        [point.x + pad, point.y + pad],
      ]
      const layers = INTERACTIVE_LAYERS.filter((l) => map.getLayer(l))
      return map.queryRenderedFeatures(box, { layers })[0]
    }

    let raf = 0
    map.on('mousemove', (e) => {
      if (!readyRef.current || pinnedRef.current) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const feature = pick(e.point)
        map.getCanvas().style.cursor = feature ? 'pointer' : ''
        if (!feature) {
          clearHover()
          popup.remove()
          return
        }
        if (feature.layer.id === 'stations' || feature.layer.id === 'stations-live') {
          if (hoverIdRef.current !== feature.id) {
            clearHover()
            if (feature.id != null) {
              hoverIdRef.current = feature.id
              map.setFeatureState({ source: 'stations', id: feature.id }, { hover: true })
            }
          }
        } else {
          clearHover()
        }
        popup.setLngLat(e.lngLat).setDOMContent(cardFor(feature, cardCtxRef.current)).addTo(map)
      })
    })

    map.on('mouseout', () => {
      if (pinnedRef.current) return
      clearHover()
      popup.remove()
    })

    map.on('click', (e) => {
      const feature = pick(e.point)
      if (feature) {
        pinnedRef.current = true
        popup.setLngLat(e.lngLat).setDOMContent(cardFor(feature, cardCtxRef.current)).addTo(map)
      } else {
        pinnedRef.current = false
        popup.remove()
      }
    })

    mapRef.current = map
    // Debug/E2E handle (also handy in the browser console).
    ;(window as unknown as Record<string, unknown>).__ukgridMap = map
    return () => {
      cancelAnimationFrame(raf)
      popup.remove()
      map.remove()
      mapRef.current = null
      readyRef.current = false
      delete (window as unknown as Record<string, unknown>).__ukgridMap
    }
    // The dataset is immutable for the lifetime of the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --------------------------------------------------------- state → style
  const applyState = (map: MLMap) => {
    if (!readyRef.current) return
    map.setFilter('stations', stationFilter(enabledGroups) as never)
    if (map.getLayer('stations-live'))
      map.setFilter('stations-live', stationFilter(enabledGroups) as never)

    const vis = (id: string, on: boolean) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
    }
    const tierIds = ['lines-t1', 'lines-t2', 'lines-t3'] as const
    const tierOn = [network.t1, network.t2, network.t3] as const
    country.tiers.forEach((tier, i) => {
      const id = tierIds[i]!
      if (!map.getLayer(id)) return
      map.setFilter(id, ['in', ['get', 'v'], ['literal', tier.kvs]] as never)
      vis(id, tierOn[i]! && tier.kvs.length > 0)
    })
    vis('hvdc', network.hvdc)
    if (map.getLayer('hvdc')) {
      map.setFilter(
        'hvdc',
        network.construction ? null : (['==', ['get', 'status'], 'operational'] as never),
      )
    }
    vis('carto', tiles)
    if (map.getLayer('land')) {
      map.setPaintProperty('land', 'fill-opacity', tiles ? 0 : 1)
      map.setPaintProperty('coast', 'line-opacity', tiles ? 0.25 : 1)
    }
  }

  // ------------------------------------------------------ live → map state
  const applyLiveState = (map: MLMap) => {
    if (!readyRef.current) return
    // Mix-only snapshots (Nordics: no per-unit ENTSO-E feed) must not ghost
    // the station dots — live sizing needs actual per-station figures.
    const hasStationData =
      live != null && ((live.perStationNow?.size ?? 0) > 0 || live.perStationDay.size > 0)
    const showLive = liveMode && country.hasLive && hasStationData
    if (map.getLayer('stations-live')) {
      map.setLayoutProperty('stations-live', 'visibility', showLive ? 'visible' : 'none')
    }
    if (map.getLayer('stations')) {
      map.setPaintProperty(
        'stations',
        'circle-opacity',
        showLive
          ? 0.22
          : (['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.85] as never),
      )
    }
    if (!live || !showLive) return
    // Feature ids from generateId are the feature's index in source order.
    data.stations.features.forEach((f, index) => {
      const id = f.properties.id
      let mw: number
      if (timeIndex != null) {
        // Scrub mode (#17): show the selected interval of the metered day.
        mw = live.perStationDay.get(id)?.series[timeIndex] ?? 0
      } else {
        mw = live.perStationNow?.get(id) ?? live.perStationDay.get(id)?.avgMW ?? 0
      }
      map.setFeatureState({ source: 'stations', id: index }, { liveMW: Math.max(0, mw) })
    })
  }

  useEffect(() => {
    const map = mapRef.current
    if (map && readyRef.current) applyState(map)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledGroups, network, tiles])

  useEffect(() => {
    const map = mapRef.current
    if (map && readyRef.current) applyLiveState(map)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, liveMode, country, timeIndex])

  // ----------------------------------------------------- country data swap
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    const src = (id: string) => map.getSource(id) as maplibregl.GeoJSONSource | undefined
    popupRef.current?.remove()
    pinnedRef.current = false
    hoverIdRef.current = null
    map.removeFeatureState({ source: 'stations' })
    // The basemap differs per region (eu / na / merged for ALL) — without
    // this, switching e.g. GB → ALL leaves the US floating on open sea.
    src('land')?.setData(data.basemap as never)
    src('stations')?.setData(data.stations as never)
    src('transmission')?.setData(data.transmission as never)
    src('interconnectors')?.setData(data.interconnectors as never)
    applyState(map)
    applyLiveState(map)
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
    pinnedRef.current = true
    popupRef.current
      ?.setLngLat(searchTarget.coords)
      .setDOMContent(cardFor(fake, cardCtxRef.current))
      .addTo(map)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTarget])

  return (
    <div
      ref={containerRef}
      className="map-container"
      role="application"
      aria-label={`Map of ${country.name} energy infrastructure`}
    />
  )
}
