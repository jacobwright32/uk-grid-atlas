// Pipeline unit tests (vitest picks up *.test.mjs too).
import { describe, expect, it } from 'vitest'
import {
  clipRingToBox,
  parseCapacityMW,
  parseVoltClass,
  simplify,
  unwrapRing,
} from './pipeline-utils.mjs'
import { buildRegionBasemap } from './basemap.mjs'

describe('parseCapacityMW', () => {
  it('parses plain MW', () => {
    expect(parseCapacityMW('460 MW')).toBe(460)
    expect(parseCapacityMW('49.9MW')).toBeCloseTo(49.9)
  })
  it('parses separators and GW/kW/W', () => {
    expect(parseCapacityMW('1,218 MW')).toBe(1218)
    expect(parseCapacityMW('2 GW')).toBe(2000)
    expect(parseCapacityMW('750 kW')).toBeCloseTo(0.75)
    expect(parseCapacityMW('500000 W')).toBeCloseTo(0.5)
  })
  it('bare numbers: MW when plausible, kW when large, watts when huge', () => {
    expect(parseCapacityMW('420')).toBe(420)
    expect(parseCapacityMW('12870')).toBeCloseTo(12.87) // bare kWp (common on DE solar)
    expect(parseCapacityMW('24000000')).toBe(24)
  })
  it('European decimal commas vs thousands separators', () => {
    expect(parseCapacityMW('1,2 MW')).toBeCloseTo(1.2)
    expect(parseCapacityMW('12,87 MWp')).toBeCloseTo(12.87)
    expect(parseCapacityMW('1,218 MW')).toBe(1218)
    expect(parseCapacityMW('1,218.5 MW')).toBeCloseTo(1218.5)
  })
  it('rejects junk', () => {
    expect(parseCapacityMW('yes')).toBeNull()
    expect(parseCapacityMW(null)).toBeNull()
    expect(parseCapacityMW('')).toBeNull()
  })
})

describe('parseVoltClass', () => {
  it('classifies single voltages', () => {
    expect(parseVoltClass('400000')).toBe(400)
    expect(parseVoltClass('275000')).toBe(275)
    expect(parseVoltClass('132000')).toBe(132)
  })
  it('takes the highest of multi-voltage ways', () => {
    expect(parseVoltClass('275000;132000')).toBe(275)
    expect(parseVoltClass('132000;400000')).toBe(400)
  })
  it('ignores sub-transmission and junk', () => {
    expect(parseVoltClass('33000')).toBeNull()
    expect(parseVoltClass(null)).toBeNull()
    expect(parseVoltClass('abc')).toBeNull()
  })
})

describe('simplify', () => {
  it('keeps endpoints and collapses collinear points', () => {
    const line = [
      [0, 0],
      [1, 0.00001],
      [2, 0],
      [3, 0.00002],
      [4, 0],
    ]
    const out = simplify(line, 0.001)
    expect(out[0]).toEqual([0, 0])
    expect(out[out.length - 1]).toEqual([4, 0])
    expect(out.length).toBe(2)
  })
  it('preserves genuine corners', () => {
    const corner = [
      [0, 0],
      [1, 0],
      [1, 1],
    ]
    expect(simplify(corner, 0.001)).toHaveLength(3)
  })
})

describe('unwrapRing', () => {
  it('leaves ordinary rings alone', () => {
    const ring = [
      [10, 50],
      [11, 50],
      [11, 51],
      [10, 50],
    ]
    expect(unwrapRing(ring)).toEqual(ring)
  })
  it('makes antimeridian crossings continuous', () => {
    const ring = [
      [179, 65],
      [-179.5, 65], // crosses 180 eastward
      [-179.5, 66],
      [179, 66],
      [179, 65],
    ]
    const out = unwrapRing(ring)
    expect(out.map(([x]) => x)).toEqual([179, 180.5, 180.5, 179, 179])
    // closed ring stays closed
    expect(out[0]).toEqual(out[out.length - 1])
  })
})

describe('clipRingToBox', () => {
  const box = [0, 0, 10, 10]
  it('keeps a fully-inside ring, closed', () => {
    const ring = [
      [2, 2],
      [8, 2],
      [8, 8],
      [2, 8],
      [2, 2],
    ]
    const out = clipRingToBox(ring, box)
    expect(out[0]).toEqual(out[out.length - 1])
    expect(out.slice(0, -1)).toHaveLength(4)
  })
  it('clips a straddling ring to the box edge', () => {
    const ring = [
      [-5, 2],
      [5, 2],
      [5, 8],
      [-5, 8],
      [-5, 2],
    ]
    const out = clipRingToBox(ring, box)
    expect(out).not.toBeNull()
    for (const [x, y] of out) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(10)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(10)
    }
    // area is halved: the kept part spans x 0..5, y 2..8
    expect(Math.max(...out.map(([x]) => x))).toBe(5)
    expect(Math.min(...out.map(([x]) => x))).toBe(0)
  })
  it('returns null when nothing remains', () => {
    const ring = [
      [20, 20],
      [30, 20],
      [30, 30],
      [20, 20],
    ]
    expect(clipRingToBox(ring, box)).toBeNull()
  })
})

describe('buildRegionBasemap', () => {
  // A toy "Eurasia": crosses the antimeridian like Chukotka does, with a
  // vertex inside the EU select box.
  const eurasia = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-179, 66], // beyond 180 (unwraps to 181)
          [-179, 70],
          [100, 70],
          [10, 55], // inside the eu select box
          [100, 40],
          [-179, 66],
        ],
      ],
    },
  }
  it('ships antimeridian-crossing land without wrap jumps', () => {
    const fc = buildRegionBasemap({ features: [eurasia] }, 'eu')
    expect(fc.features).toHaveLength(1)
    for (const ring of fc.features[0].geometry.coordinates) {
      for (let i = 1; i < ring.length; i++) {
        expect(Math.abs(ring[i][0] - ring[i - 1][0])).toBeLessThanOrEqual(180)
      }
      for (const [x] of ring) {
        expect(x).toBeLessThanOrEqual(180)
        expect(x).toBeGreaterThanOrEqual(-35)
      }
    }
  })
  it('drops polygons outside the select box', () => {
    const antarctica = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-60, -75],
            [60, -75],
            [0, -85],
            [-60, -75],
          ],
        ],
      },
    }
    const fc = buildRegionBasemap({ features: [antarctica] }, 'eu')
    expect(fc.features).toHaveLength(0)
  })
})
