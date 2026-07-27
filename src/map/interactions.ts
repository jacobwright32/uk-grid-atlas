/**
 * Hover / pin / popup wiring (#54). Owns the transient interaction state
 * (hovered feature, pinned card) so GridMap's data-swap and search effects
 * drive it through a small handle instead of shared refs.
 */
import maplibregl, { Map as MLMap, Popup } from 'maplibre-gl'
import { INTERACTIVE_LAYERS } from './layers'
import { FUEL_LABEL } from '../lib/fuels'
import { fmtMW } from '../lib/format'
import type { FuelId } from '../lib/types'
import { cardFor } from './popup'
import type { CardContext } from './popup'

export interface Interactions {
  /** Unpin + unhover + drop the popup (country/data swap). */
  clear(): void
  /** Pin a station card programmatically (search fly-to, deep links). */
  pinStation(coords: [number, number], feature: maplibregl.MapGeoJSONFeature): void
  /** Detach listeners' pending work (component unmount). */
  cleanup(): void
}

const isStationLayer = (id: string) => id === 'stations' || id === 'stations-live'

/**
 * Layers the keyboard roving selection walks (#12). Stations only: a viewport
 * of overlapping polylines has no meaningful reading order, and lines carry
 * far less than a station card does.
 */
const STATION_LAYERS = INTERACTIVE_LAYERS.filter(isStationLayer)

/**
 * Rows are quantised to this many pixels before sorting, so a couple of
 * pixels of latitude jitter can't scramble a visually straight row (#12).
 */
const ROW_BAND_PX = 28

interface Roving {
  feature: maplibregl.MapGeoJSONFeature
  coords: [number, number]
  id: string
}

export function wireInteractions(
  map: MLMap,
  popup: Popup,
  getCardCtx: () => CardContext,
  onStationPin: (id: string | null) => void,
  /** Screen-reader narration for the keyboard model — GridMap renders it into
   *  a polite live region (#12). */
  onAnnounce: (text: string) => void = () => {},
): Interactions {
  let hoverId: number | string | null = null
  let pinned = false
  /** Keyboard roving cursor; independent of `hoverId`, which is a feature-state
   *  key and says nothing about which station the keys are "on". */
  let roving: Roving | null = null

  const clearHover = () => {
    if (hoverId != null) {
      map.setFeatureState({ source: 'stations', id: hoverId }, { hover: false })
      hoverId = null
    }
  }

  const pick = (point: maplibregl.Point) => {
    const pad = 6
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [point.x - pad, point.y - pad],
      [point.x + pad, point.y + pad],
    ]
    const layers = INTERACTIVE_LAYERS.filter((l) => map.getLayer(l))
    return map.queryRenderedFeatures(box, { layers })[0]
  }

  const setHover = (id: number | string | null | undefined) => {
    clearHover()
    if (id != null) {
      hoverId = id
      map.setFeatureState({ source: 'stations', id }, { hover: true })
    }
  }

  let raf = 0
  const onMouseMove = (e: maplibregl.MapMouseEvent) => {
    if (pinned) return
    // The pointer takes over the card, so the keys shouldn't still think they
    // own a station — Enter would otherwise pin whatever was roved to last.
    roving = null
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      const feature = pick(e.point)
      map.getCanvas().style.cursor = feature ? 'pointer' : ''
      if (!feature) {
        clearHover()
        popup.remove()
        return
      }
      if (isStationLayer(feature.layer.id)) {
        if (hoverId !== feature.id) setHover(feature.id)
      } else {
        clearHover()
      }
      popup.setLngLat(e.lngLat).setDOMContent(cardFor(feature, getCardCtx())).addTo(map)
    })
  }

  const onMouseOut = () => {
    if (pinned) return
    clearHover()
    popup.remove()
  }

  const onClick = (e: maplibregl.MapMouseEvent) => {
    const feature = pick(e.point)
    roving = null
    if (feature) {
      pinned = true
      popup.setLngLat(e.lngLat).setDOMContent(cardFor(feature, getCardCtx())).addTo(map)
      // Only stations get permalinks (#22) — a pinned line clears the hash.
      const id = (feature.properties as { id?: string }).id ?? null
      onStationPin(isStationLayer(feature.layer.id) ? id : null)
    } else {
      pinned = false
      popup.remove()
      onStationPin(null)
    }
  }

  // ------------------------------------------------------------- keyboard
  /**
   * Stations painted in the current viewport, in reading order. Recomputed on
   * every keypress rather than cached: pan, zoom and the fuel filters all
   * change what's on screen, and a stale list would rove over ghosts (#12).
   */
  const visibleStations = (): Roving[] => {
    const layers = STATION_LAYERS.filter((l) => map.getLayer(l))
    if (!layers.length) return []
    const seen = new Set<string>()
    const placed: { station: Roving; x: number; y: number }[] = []
    for (const feature of map.queryRenderedFeatures({ layers })) {
      const id = (feature.properties as { id?: string }).id
      // 'stations' and 'stations-live' paint the same source, so most features
      // come back twice; the station id is what dedupes them.
      if (id == null || seen.has(id) || feature.geometry.type !== 'Point') continue
      seen.add(id)
      const coords = feature.geometry.coordinates as [number, number]
      const p = map.project(coords)
      placed.push({ station: { feature, coords, id }, x: p.x, y: p.y })
    }
    placed.sort(
      (a, b) => Math.floor(a.y / ROW_BAND_PX) - Math.floor(b.y / ROW_BAND_PX) || a.x - b.x,
    )
    return placed.map((p) => p.station)
  }

  /** Hover-card rendering, verbatim — the keys drive the pointer's code path
   *  so the two can't drift apart. */
  const showRoving = (station: Roving, position: string) => {
    roving = station
    setHover(station.feature.id)
    popup.setLngLat(station.coords).setDOMContent(cardFor(station.feature, getCardCtx())).addTo(map)
    const p = station.feature.properties as { name?: string; capacityMW?: number; fuel?: string }
    const parts = [
      p.name || 'Unnamed site',
      FUEL_LABEL[p.fuel as FuelId],
      p.capacityMW != null ? fmtMW(p.capacityMW) : null,
    ].filter(Boolean)
    onAnnounce(`${parts.join(', ')}. ${position}. Enter to pin.`)
  }

  const step = (delta: number) => {
    const list = visibleStations()
    if (!list.length) {
      onAnnounce('No sites in view — pan or zoom the map.')
      return
    }
    // Resume by station id, not by index: the list can have been re-ordered or
    // re-sized by a pan between keypresses.
    const at = roving ? list.findIndex((s) => s.id === roving?.id) : -1
    const next =
      at >= 0 ? (at + delta + list.length) % list.length : delta > 0 ? 0 : list.length - 1
    const station = list[next]
    if (station) showRoving(station, `${next + 1} of ${list.length}`)
  }

  const pinRoving = () => {
    if (!roving) return
    pinned = true
    onStationPin(roving.id)
    onAnnounce(`Pinned ${(roving.feature.properties as { name?: string }).name ?? roving.id}.`)
  }

  const dismiss = () => {
    const wasPinned = pinned
    pinned = false
    roving = null
    clearHover()
    popup.remove()
    if (wasPinned) onStationPin(null)
    onAnnounce('Selection cleared.')
  }

  /**
   * `keydown` isn't in MapLibre's event map, so this listens on the DOM node
   * that owns focus (MapLibre puts `tabindex="0"` on the canvas inside it).
   * The keys are `]` / `[` because MapLibre's own KeyboardHandler already
   * binds the arrows to panning and +/- to zoom — rebinding those would trade
   * one missing keyboard affordance for another (#12).
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === ']') step(1)
    else if (e.key === '[') step(-1)
    else if (e.key === 'Enter') pinRoving()
    else if (e.key === 'Escape') {
      // Nothing selected: let Escape bubble on to whatever else wants it.
      if (!pinned && !roving) return
      dismiss()
    } else return
    e.preventDefault()
    e.stopPropagation()
  }
  const canvasContainer = map.getCanvasContainer()
  canvasContainer.addEventListener('keydown', onKeyDown)

  map.on('mousemove', onMouseMove)
  map.on('mouseout', onMouseOut)
  map.on('click', onClick)

  return {
    clear() {
      pinned = false
      roving = null
      clearHover()
      popup.remove()
      map.removeFeatureState({ source: 'stations' })
    },
    pinStation(coords, feature) {
      pinned = true
      popup.setLngLat(coords).setDOMContent(cardFor(feature, getCardCtx())).addTo(map)
      const name = (feature.properties as { name?: string }).name
      if (name) onAnnounce(`Pinned ${name}.`)
    },
    cleanup() {
      cancelAnimationFrame(raf)
      canvasContainer.removeEventListener('keydown', onKeyDown)
      popup.remove()
    },
  }
}
