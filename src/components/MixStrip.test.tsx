// @vitest-environment jsdom
// Component smoke tests (#63): the mix strip is the app's most-wired widget
// — day bars, range toggle, history states, price + carbon lines.
import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach } from 'vitest'
import MixStrip from './MixStrip'
import type { HistoryFile } from '../lib/history'

afterEach(cleanup)

const rows = [
  { key: 'nuclear', label: 'Nuclear', color: '#9085e9', nowMW: 3800, capMW: 0 },
  { key: 'wind', label: 'Wind', color: '#199e70', nowMW: 2500, capMW: 0 },
  { key: 'imports', label: 'Imports (HVDC)', color: '#2dd4bf', nowMW: 800, capMW: 0 },
]

const baseProps = {
  mix: {
    time: '2026-07-24T12:00:00Z',
    fuels: [],
    interconnectors: {},
    totalMW: 6300,
    importMW: 800,
  },
  rows,
  mode: 'daily' as const,
  title: 'Finland generation mix',
  timeIndex: null,
  mixSeries: null,
  importSeries: null,
  today: null,
  prices: { currency: 'EUR', series: new Array(24).fill(42), zones: 1 },
  demandSeries: new Array(24).fill(7100),
  sourceLabel: null,
  range: 'day' as const,
  onRange: () => {},
  history: null,
  historyState: 'idle' as const,
}

const history: HistoryFile = {
  version: 2,
  updatedAt: '',
  currency: 'EUR',
  sourceLabel: null,
  days: [
    {
      date: '2026-07-23',
      mix: { nuclear: 3700, wind: 900 },
      importMW: 500,
      totalMW: 4600,
      price: 30,
    },
    {
      date: '2026-07-24',
      mix: { nuclear: 3800, wind: 2500 },
      importMW: 800,
      totalMW: 6300,
      price: 12,
    },
  ],
  hourly: [
    {
      date: '2026-07-24',
      mixSeries: { nuclear: new Array(24).fill(3800), wind: new Array(24).fill(2500) },
      importSeries: null,
      prices: new Array(24).fill(12),
      demand: new Array(24).fill(7100),
    },
  ],
}

describe('MixStrip (day view)', () => {
  it('renders fuel rows, total, price and derived carbon intensity', () => {
    render(<MixStrip {...baseProps} />)
    expect(screen.getByText('Nuclear')).toBeTruthy()
    expect(screen.getByText('Wind')).toBeTruthy()
    expect(screen.getByText(/Finland generation mix/)).toBeTruthy()
    expect(screen.getByText(/Day-ahead · 42 €\/MWh/)).toBeTruthy()
    expect(screen.getByText(/demand 7.1 GW avg/)).toBeTruthy()
    // 3800×12 + 2500×12 → 12 g/kWh (imports excluded)
    expect(screen.getByText(/12 g\/kWh CO₂/)).toBeTruthy()
  })
  it('exposes the range toggle with day selected', () => {
    render(<MixStrip {...baseProps} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['day', '7d', '31d'])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
  })
})

describe('MixStrip (history views)', () => {
  it('shows the loading state before the history file lands', () => {
    render(<MixStrip {...baseProps} range="week" historyState="loading" />)
    expect(screen.getByText(/loading history/)).toBeTruthy()
  })
  it('shows the missing state for grids without baked history', () => {
    render(<MixStrip {...baseProps} range="week" historyState="missing" />)
    expect(screen.getByText(/no history baked/)).toBeTruthy()
  })
  it('renders the week chart with readout, dates and price legend', () => {
    const { container } = render(
      <MixStrip {...baseProps} range="week" historyState="ready" history={history} />,
    )
    expect(container.querySelector('.mixhistory-svg')).toBeTruthy()
    expect(container.querySelectorAll('.mixhistory-svg polygon').length).toBeGreaterThan(0)
    expect(screen.getByText(/past week/)).toBeTruthy()
    expect(screen.getByText(/price \(EUR\)/)).toBeTruthy()
    expect(screen.getByText('demand')).toBeTruthy() // the overlay line's chip
  })
  it('renders month bars from daily records', () => {
    const { container } = render(
      <MixStrip {...baseProps} range="month" historyState="ready" history={history} />,
    )
    expect(container.querySelectorAll('.mixhistory-svg rect').length).toBeGreaterThan(0)
    expect(screen.getByText(/past month/)).toBeTruthy()
  })
})
