/**
 * Hover / pin / popup wiring (#54). Owns the transient interaction state
 * (hovered feature, pinned card) so GridMap's data-swap and search effects
 * drive it through a small handle instead of shared refs.
 */
import maplibregl, { Map as MLMap, Popup } from 'maplibre-gl'
import { INTERACTIVE_LAYERS } from './layers'
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

export function wireInteractions(
  map: MLMap,
  popup: Popup,
  getCardCtx: () => CardContext,
  onStationPin: (id: string | null) => void,
): Interactions {
  let hoverId: number | string | null = null
  let pinned = false

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

  let raf = 0
  const onMouseMove = (e: maplibregl.MapMouseEvent) => {
    if (pinned) return
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
        if (hoverId !== feature.id) {
          clearHover()
          if (feature.id != null) {
            hoverId = feature.id
            map.setFeatureState({ source: 'stations', id: feature.id }, { hover: true })
          }
        }
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
    if (feature) {
      pinned = true
      popup.setLngLat(e.lngLat).setDOMContent(cardFor(feature, getCardCtx())).addTo(map)
      // Only stations get permalinks (#22) — a pinned line clears the hash.
      const isStation = feature.layer.id === 'stations' || feature.layer.id === 'stations-live'
      const id = (feature.properties as { id?: string }).id ?? null
      onStationPin(isStation ? id : null)
    } else {
      pinned = false
      popup.remove()
      onStationPin(null)
    }
  }

  map.on('mousemove', onMouseMove)
  map.on('mouseout', onMouseOut)
  map.on('click', onClick)

  return {
    clear() {
      pinned = false
      clearHover()
      popup.remove()
      map.removeFeatureState({ source: 'stations' })
    },
    pinStation(coords, feature) {
      pinned = true
      popup.setLngLat(coords).setDOMContent(cardFor(feature, getCardCtx())).addTo(map)
    },
    cleanup() {
      cancelAnimationFrame(raf)
      popup.remove()
    },
  }
}
