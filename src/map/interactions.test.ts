// @vitest-environment jsdom
// Keyboard access to stations (#12): the map used to be pointer-only, so every
// station card was unreachable without a mouse. These pin the roving-selection
// model — reading order, wraparound, pin, dismiss and the narration — against a
// fake map, since MapLibre needs WebGL that jsdom doesn't have.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Map as MLMap, MapGeoJSONFeature, Popup } from 'maplibre-gl'
import { wireInteractions } from './interactions'

/** A station feature as the `stations` layer would hand it back. */
function station(
  id: string,
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
  layer = 'stations',
) {
  return {
    id: id.length, // MapLibre's numeric feature id — unrelated to properties.id
    layer: { id: layer },
    geometry: { type: 'Point', coordinates: [x, y] },
    properties: { id, name: id.toUpperCase(), fuel: 'nuclear', ...extra },
  } as unknown as MapGeoJSONFeature
}

/**
 * `project` here is the identity map, so a feature's coordinates *are* its
 * screen position — the tests can lay stations out in pixels directly.
 */
function fakeMap(features: MapGeoJSONFeature[]) {
  const container = document.createElement('div')
  document.body.append(container)
  const canvas = document.createElement('canvas')
  const map = {
    getLayer: (id: string) => (id.startsWith('stations') ? {} : undefined),
    queryRenderedFeatures: vi.fn(() => features),
    project: (c: [number, number]) => ({ x: c[0], y: c[1] }),
    setFeatureState: vi.fn(),
    removeFeatureState: vi.fn(),
    getCanvas: () => canvas,
    getCanvasContainer: () => container,
    on: vi.fn(),
  } as unknown as MLMap
  return { map, container }
}

function fakePopup() {
  const popup = {
    setLngLat: vi.fn(() => popup),
    // Typed arg: the assertions read this call back, and an untyped vi.fn()
    // gives `mock.calls` a zero-length tuple that `tsc -b` rejects at [0].
    setDOMContent: vi.fn((_node: Node) => popup),
    addTo: vi.fn(() => popup),
    remove: vi.fn(() => popup),
  }
  return popup as unknown as Popup & typeof popup
}

/** Wire up, returning the handle plus the spies the assertions read. */
function harness(features: MapGeoJSONFeature[]) {
  const { map, container } = fakeMap(features)
  const popup = fakePopup()
  const onPin = vi.fn()
  const said: string[] = []
  const handle = wireInteractions(
    map,
    popup,
    () => ({ live: null, bmuMap: null }),
    onPin,
    (t) => said.push(t),
  )
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    container.dispatchEvent(e)
    return e
  }
  return { handle, map, container, popup, onPin, said, press }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('keyboard roving selection (#12)', () => {
  it('walks the visible stations in reading order — rows top-down, then left-right', () => {
    // Deliberately out of order, and `b` sits 6px below `a`: within one row
    // band, so it must still read as the same row.
    const { said, press } = harness([
      station('c', 10, 200),
      station('b', 300, 6),
      station('a', 20, 0),
    ])
    press(']')
    press(']')
    press(']')
    expect(said.map((s) => s.split(',')[0])).toEqual(['A', 'B', 'C'])
  })

  it('reports the position in the list and how to pin', () => {
    const { said, press } = harness([station('a', 0, 0), station('b', 100, 0)])
    press(']')
    expect(said[0]).toBe('A, Nuclear. 1 of 2. Enter to pin.')
  })

  it('includes capacity in the announcement when the site has one', () => {
    const { said, press } = harness([station('a', 0, 0, { capacityMW: 1200 })])
    press(']')
    expect(said[0]).toMatch(/^A, Nuclear, 1,200 MW\. 1 of 1\./)
  })

  it('wraps forwards off the end and backwards off the start', () => {
    const { said, press } = harness([station('a', 0, 0), station('b', 100, 0)])
    press(']')
    press(']')
    press(']') // past the end
    expect(said.at(-1)).toContain('1 of 2')
    press('[') // back off the start
    expect(said.at(-1)).toContain('2 of 2')
  })

  it('starts at the last station when the first keypress is backwards', () => {
    const { said, press } = harness([station('a', 0, 0), station('b', 100, 0)])
    press('[')
    expect(said[0]).toContain('B')
  })

  it('dedupes the same station painted by both stations layers', () => {
    // `stations` and `stations-live` render the same source, so a live grid
    // returns every feature twice.
    const { said, press } = harness([
      station('a', 0, 0),
      station('a', 0, 0, {}, 'stations-live'),
      station('b', 100, 0),
    ])
    press(']')
    expect(said[0]).toContain('1 of 2')
  })

  it('skips non-point features, which have no single place to sit', () => {
    const line = {
      id: 9,
      layer: { id: 'stations' },
      geometry: { type: 'LineString', coordinates: [] },
      properties: { id: 'l1', name: 'A LINE' },
    } as unknown as MapGeoJSONFeature
    const { said, press } = harness([line, station('a', 0, 0)])
    press(']')
    expect(said[0]).toContain('1 of 1')
    expect(said[0]).toContain('A')
  })

  it('says so instead of failing silently when nothing is in view', () => {
    const { said, press, onPin } = harness([])
    press(']')
    expect(said).toEqual(['No sites in view — pan or zoom the map.'])
    expect(onPin).not.toHaveBeenCalled()
  })

  it('renders the same hover card the pointer would', () => {
    const { popup, press } = harness([station('a', 12, 34)])
    press(']')
    expect(popup.setLngLat).toHaveBeenCalledWith([12, 34])
    expect(popup.addTo).toHaveBeenCalled()
    const node = popup.setDOMContent.mock.calls[0]?.[0] as HTMLElement | undefined
    expect(node?.className).toBe('hovercard')
    expect(node?.textContent).toContain('A')
  })

  it('highlights the roved station with the pointer’s hover feature state', () => {
    const { map, press } = harness([station('abc', 0, 0)])
    press(']')
    expect(map.setFeatureState).toHaveBeenCalledWith({ source: 'stations', id: 3 }, { hover: true })
  })

  it('pins on Enter, which is what drives the permalink', () => {
    const { onPin, said, press } = harness([station('a', 0, 0)])
    press(']')
    press('Enter')
    expect(onPin).toHaveBeenCalledWith('a')
    expect(said.at(-1)).toBe('Pinned A.')
  })

  it('ignores Enter when nothing is selected', () => {
    const { onPin, press } = harness([station('a', 0, 0)])
    press('Enter')
    expect(onPin).not.toHaveBeenCalled()
  })

  it('clears the pin, the card and the highlight on Escape', () => {
    const { onPin, popup, said, press } = harness([station('a', 0, 0)])
    press(']')
    press('Enter')
    onPin.mockClear()
    press('Escape')
    expect(onPin).toHaveBeenCalledWith(null)
    expect(popup.remove).toHaveBeenCalled()
    expect(said.at(-1)).toBe('Selection cleared.')
  })

  it('drops an unpinned selection on Escape without touching the permalink', () => {
    const { onPin, press } = harness([station('a', 0, 0)])
    press(']')
    press('Escape')
    expect(onPin).not.toHaveBeenCalled()
  })

  it('lets Escape bubble when there is nothing to dismiss, so the drawer can use it', () => {
    const { press } = harness([station('a', 0, 0)])
    expect(press('Escape').defaultPrevented).toBe(false)
    // …but swallows it once a selection exists, or the drawer would close too.
    press(']')
    expect(press('Escape').defaultPrevented).toBe(true)
  })

  it('swallows its own keys so MapLibre and the page do not double-handle them', () => {
    const { press } = harness([station('a', 0, 0)])
    expect(press(']').defaultPrevented).toBe(true)
    expect(press('[').defaultPrevented).toBe(true)
    // The arrows stay MapLibre's — it pans with them.
    expect(press('ArrowRight').defaultPrevented).toBe(false)
  })

  it('leaves modified keys to the browser', () => {
    const { said, press } = harness([station('a', 0, 0)])
    expect(press(']', { metaKey: true }).defaultPrevented).toBe(false)
    expect(said).toEqual([])
  })

  it('stops listening after cleanup, so an unmounted map cannot narrate', () => {
    const { handle, said, press } = harness([station('a', 0, 0)])
    handle.cleanup()
    press(']')
    expect(said).toEqual([])
  })

  it('forgets the selection on clear, so a country swap cannot pin a stale station', () => {
    const { handle, onPin, press } = harness([station('a', 0, 0)])
    press(']')
    handle.clear()
    press('Enter')
    expect(onPin).not.toHaveBeenCalled()
  })
})
