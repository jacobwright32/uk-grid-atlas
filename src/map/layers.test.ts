// Map layer-spec tests (#62): these builders are pure data → MapLibre specs,
// and a broken expression fails silently on the map (dots vanish, flows stop
// colouring). Pin the encoding decisions instead.
import { describe, expect, it } from 'vitest'
import {
  INTERACTIVE_LAYERS,
  interconnectorLayers,
  liveStationLayer,
  stationLayers,
  transmissionLayers,
} from './layers'

/** Depth-first search for a sub-expression inside a MapLibre expression. */
function contains(expr: unknown, needle: unknown[]): boolean {
  if (Array.isArray(expr)) {
    if (JSON.stringify(expr) === JSON.stringify(needle)) return true
    return expr.some((e) => contains(e, needle))
  }
  return false
}

/** LayerSpecification is a wide union — tests read specs as plain data. */
interface AnyLayer {
  id: string
  filter?: unknown
  layout?: Record<string, unknown>
  paint: Record<string, unknown>
  'source-layer'?: string
}
const spec = (l: unknown): AnyLayer => l as AnyLayer

describe('stationLayers', () => {
  const [stations] = stationLayers('stations')
  it('sizes circles by sqrt capacity across zoom stops', () => {
    const radius = spec(stations).paint['circle-radius'] as unknown[]
    expect(radius[0]).toBe('interpolate')
    expect(contains(radius, ['coalesce', ['get', 'capacityMW'], 4])).toBe(true)
    expect(JSON.stringify(radius)).toContain('"sqrt"')
  })
  it('gives pumped storage its white identity ring', () => {
    const stroke = spec(stations).paint['circle-stroke-color'] as unknown[]
    expect(contains(stroke, ['==', ['get', 'fuel'], 'pumped'])).toBe(true)
    expect(JSON.stringify(stroke)).toContain('#ffffff')
  })
  it('hover state brightens and outlines', () => {
    const opacity = spec(stations).paint['circle-opacity'] as unknown[]
    expect(contains(opacity, ['boolean', ['feature-state', 'hover'], false])).toBe(true)
  })
})

describe('liveStationLayer', () => {
  const live = liveStationLayer('stations')
  it('starts hidden and reads liveMW feature-state, never capacity', () => {
    expect(spec(live).layout?.visibility).toBe('none')
    const radius = spec(live).paint['circle-radius'] as unknown[]
    expect(contains(radius, ['feature-state', 'liveMW'])).toBe(true)
    expect(JSON.stringify(radius)).not.toContain('capacityMW')
  })
})

describe('transmissionLayers', () => {
  const tiers = transmissionLayers('transmission')
  it('draws t3 under t2 under t1 (backbone on top)', () => {
    expect(tiers.map((t) => t.id)).toEqual(['lines-t3', 'lines-t2', 'lines-t1'])
  })
  it('ships empty filters for GridMap to fill per country', () => {
    for (const t of tiers) {
      expect(JSON.stringify(spec(t).filter)).toBe(JSON.stringify(['in', ['get', 'v'], ['literal', []]]))
    }
  })
  it('backbone lines render wider than regional ones', () => {
    const width = (t: (typeof tiers)[number]) => (spec(t).paint['line-width'] as unknown[])[4] as number // first zoom stop value
    expect(width(tiers[2]!)).toBeGreaterThan(width(tiers[0]!))
  })
  it('forwards the vector source-layer only when tiled', () => {
    expect(spec(transmissionLayers('t', 'lines')[0])['source-layer']).toBe('lines')
    expect(spec(transmissionLayers('t')[0])['source-layer']).toBeUndefined()
  })
})

describe('interconnectorLayers', () => {
  const [base, flow] = interconnectorLayers('interconnectors')
  it('dashed base + flow overlay gated on flowMW', () => {
    expect(spec(base).paint['line-dasharray']).toEqual([2.4, 1.8])
    expect(spec(flow).filter).toEqual(['has', 'flowMW'])
  })
  it('flow overlay colours by direction: teal in, amber out (#43)', () => {
    const color = spec(flow).paint['line-color'] as unknown[]
    expect(color[0]).toBe('match')
    expect(contains(color, ['get', 'flowDir'])).toBe(true)
    expect(JSON.stringify(color)).toContain('#2dd4bf')
    expect(JSON.stringify(color)).toContain('#e5a53a')
  })
  it('flow width scales with utilisation', () => {
    expect(contains(spec(flow).paint['line-width'], ['get', 'flowUtil'])).toBe(true)
  })
  it('under-construction links render dimmer', () => {
    const opacity = spec(base).paint['line-opacity'] as unknown[]
    expect(contains(opacity, ['==', ['get', 'status'], 'construction'])).toBe(true)
  })
})

describe('INTERACTIVE_LAYERS', () => {
  it('lists live dots first (topmost hit-target) and only real layer ids', () => {
    expect(INTERACTIVE_LAYERS[0]).toBe('stations-live')
    const built = new Set(
      [
        ...stationLayers('s'),
        liveStationLayer('s'),
        ...transmissionLayers('t'),
        ...interconnectorLayers('i'),
      ].map((l) => l.id),
    )
    for (const id of INTERACTIVE_LAYERS) {
      if (id !== 'hvdc') expect(built.has(id), id).toBe(true)
    }
    expect(built.has('hvdc')).toBe(true) // and hvdc too — belt and braces
  })
})
