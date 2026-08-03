import { describe, expect, it } from 'vitest'
import { mergeGridData } from './merge'
import type { GridData } from './types'

const bundle = (station: string, icIds: string[]): GridData =>
  ({
    stations: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 50] },
          properties: { id: station },
        },
      ],
    },
    transmission: { type: 'FeatureCollection', features: [] },
    interconnectors: {
      type: 'FeatureCollection',
      features: icIds.map((id) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [] },
        properties: { id },
      })),
    },
    basemap: { type: 'FeatureCollection', features: [] },
    meta: { generated: '2026-07-21', stationCount: 1, lineCount: 0, attribution: 'x' },
  }) as unknown as GridData

describe('mergeGridData', () => {
  it('concatenates stations and dedupes shared interconnectors by id', () => {
    const merged = mergeGridData([
      bundle('way/1', ['britned', 'nsl']),
      bundle('way/2', ['britned', 'norned']),
    ])
    expect(merged.stations.features).toHaveLength(2)
    expect(merged.interconnectors.features.map((f) => f.properties.id)).toEqual([
      'britned',
      'nsl',
      'norned',
    ])
    expect(merged.meta.stationCount).toBe(2)
  })

  it('dedupes cross-border stations by id and counts the deduped set', () => {
    // Iron Gates I lives in both ro's and rs's bundles as the same relation —
    // the ALL view must show one pin, not two stacked ones.
    const merged = mergeGridData([
      bundle('relation/10245510', ['britned']),
      bundle('relation/10245510', ['norned']),
      bundle('way/9', []),
    ])
    expect(merged.stations.features.map((f) => f.properties.id)).toEqual([
      'relation/10245510',
      'way/9',
    ])
    expect(merged.meta.stationCount).toBe(2)
  })

  it('throws on empty input', () => {
    expect(() => mergeGridData([])).toThrow()
  })
})
