// @vitest-environment jsdom
// Embed mode (#97): one grid's strip, a backlink, and honest empty states.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import Embed from './Embed'
import type { LiveData } from './lib/live'

const mockLive = vi.hoisted(() => ({
  current: { status: 'loading', live: null as LiveData | null, bmuMap: null },
}))
vi.mock('./hooks/useLiveData', () => ({
  useLiveData: () => mockLive.current,
}))

const track = vi.hoisted(() => vi.fn())
vi.mock('./lib/analytics', () => ({ track }))

afterEach(() => {
  cleanup()
  track.mockClear()
  mockLive.current = { status: 'loading', live: null, bmuMap: null }
})

const bakedLive = (): LiveData =>
  ({
    basis: 'entsoe',
    meteredDate: '2026-08-02',
    generatedAt: '2026-08-03T12:00:00Z',
    perStationDay: new Map(),
    perStationNow: null,
    mix: {
      time: '2026-08-02T12:00:00Z',
      fuels: [],
      interconnectors: {},
      totalMW: 1200,
      importMW: -100,
    },
    mixRows: [
      { key: 'hydro', label: 'Hydro & pumped', color: '#1899ac', nowMW: 1200, capMW: 0 },
      { key: 'imports', label: 'Net exports', color: '#777', nowMW: 100, capMW: 0 },
    ],
    mixSeries: null,
    importSeries: null,
    flowSeries: null,
    prices: null,
    demandSeries: null,
    sourceLabel: null,
    today: null,
    source: 'live',
  }) as LiveData

describe('Embed', () => {
  it('renders the strip with a backlink into the full atlas', () => {
    mockLive.current = { status: 'live', live: bakedLive(), bmuMap: null }
    render(<Embed countryId="si" />)
    expect(screen.getByText(/Slovenia generation mix/)).toBeTruthy()
    const brand = screen.getByText(/Grid Atlas/).closest('a')
    expect(brand?.getAttribute('href')).toBe('./#si')
    expect(brand?.getAttribute('target')).toBe('_blank')
    expect(track).toHaveBeenCalledWith('embed', 'si')
  })

  it('says loading, then says unavailable — never a blank iframe', () => {
    render(<Embed countryId="si" />)
    expect(screen.getByText(/Loading live data/)).toBeTruthy()
    cleanup()
    mockLive.current = { status: 'unavailable', live: null, bmuMap: null }
    render(<Embed countryId="si" />)
    expect(screen.getByText(/No live data available/)).toBeTruthy()
  })
})
