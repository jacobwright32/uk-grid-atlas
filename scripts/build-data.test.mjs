// Pipeline unit tests (vitest picks up *.test.mjs too).
import { describe, expect, it } from 'vitest'
import { parseCapacityMW, parseVoltClass, simplify } from './pipeline-utils.mjs'

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
