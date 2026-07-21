import { describe, expect, it } from 'vitest'
import { computeMixRows, fleetCapacity, interconnectorCapacity } from './fleet'
import type { BmuMap } from './live'
import type { MixSnapshot } from './live-core.mjs'
import type { InterconnectorsFC, StationsFC } from './types'

const stations = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 52] }, properties: { id: 'way/1', fuel: 'wind_offshore' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 53] }, properties: { id: 'way/2', fuel: 'gas' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 54] }, properties: { id: 'way/3', fuel: 'pumped' } },
  ],
} as unknown as StationsFC

const bmuMap: BmuMap = {
  byUnit: {},
  sentinels: [],
  stations: {
    'way/1': { units: [{ b: 'T_W-1', name: 'w1', cap: 400 }, { b: 'T_W-2', name: 'w2', cap: 350 }] },
    'way/2': { units: [{ b: 'T_G-1', name: 'g1', cap: 800 }] },
    'way/3': { units: [{ b: 'T_P-1', name: 'p1', cap: 300 }] },
  },
}

const ics = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { kind: 'interconnector', status: 'operational', capMW: 1000 } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { kind: 'interconnector', status: 'construction', capMW: 1400 } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { kind: 'reinforcement', status: 'operational', capMW: 2250 } },
  ],
} as unknown as InterconnectorsFC

const mix: MixSnapshot = {
  time: '2026-07-21T09:00:00Z',
  fuels: [
    { key: 'WIND', label: 'Wind', mw: 500 },
    { key: 'CCGT', label: 'Gas', mw: 600 },
    { key: 'OCGT', label: 'Gas (OCGT)', mw: 50 },
    { key: 'PS', label: 'Pumped', mw: 100 },
  ],
  interconnectors: {},
  totalMW: 1250,
  importMW: 700,
}

describe('fleetCapacity', () => {
  it('sums unit capacities into buckets by station fuel', () => {
    const cap = fleetCapacity(bmuMap, stations)
    expect(cap.get('wind')).toBe(750)
    expect(cap.get('gas')).toBe(800)
    expect(cap.get('hydro')).toBe(300)
  })
})

describe('interconnectorCapacity', () => {
  it('counts only operational external links', () => {
    expect(interconnectorCapacity(ics)).toBe(1000)
  })
})

describe('computeMixRows', () => {
  const rows = computeMixRows(mix, fleetCapacity(bmuMap, stations), interconnectorCapacity(ics))

  it('merges CCGT+OCGT into gas and sorts by capacity', () => {
    const gas = rows.find((r) => r.key === 'gas')!
    expect(gas.nowMW).toBe(650)
    expect(rows[0]!.key).toBe('gas') // 800 > 750 > 300
  })

  it('appends imports row with interconnector capacity', () => {
    const imports = rows[rows.length - 1]!
    expect(imports.key).toBe('imports')
    expect(imports.label).toBe('Imports')
    expect(imports.nowMW).toBe(700)
    expect(imports.capMW).toBe(1000)
  })

  it('labels net export when import flow is negative', () => {
    const exportRows = computeMixRows({ ...mix, importMW: -300 }, new Map(), 1000)
    const last = exportRows[exportRows.length - 1]!
    expect(last.label).toBe('Net export')
    expect(last.nowMW).toBe(300)
  })
})
