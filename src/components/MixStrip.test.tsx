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
  meteredDate: null,
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
    // Toggle buttons, not tabs — a tab without a tabpanel or arrow-key
    // movement is a broken ARIA promise, so these carry aria-pressed.
    const group = screen.getByRole('group', { name: 'Mix time range' })
    const btns = [...group.querySelectorAll('button')]
    expect(btns.map((t) => t.textContent)).toEqual(['day', '7d', '31d'])
    expect(btns.map((t) => t.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
  })
})

// Scrub labels (#5): slot → label used to be `i * 30 min` off midnight, which
// only holds on the 46 days a year that have 48 half-hours, and the half-hourly
// test itself was an exact `=== 48` so the two clock-change days fell back to
// hourly labels. These pin all three cases to real London wall-clock.
describe('MixStrip (scrub labels, #5)', () => {
  /** A half-hourly metered day of `len` settlement periods. */
  const halfHourly = (len: number) => ({
    nuclear: new Array(len).fill(3800),
    wind: new Array(len).fill(2500),
  })

  it('labels a 48-period day in London wall-clock', () => {
    render(
      <MixStrip
        {...baseProps}
        mixSeries={halfHourly(48)}
        meteredDate="2026-07-24"
        timeIndex={25}
      />,
    )
    expect(screen.getByText(/Finland generation mix · 12:30/)).toBeTruthy()
    expect(screen.getByText('bars = generation at 12:30')).toBeTruthy()
    expect(screen.getByText(/Day-ahead · 42 €\/MWh at 12:30/)).toBeTruthy()
  })

  it('keeps the 50-period October day half-hourly and on the right side of the fold', () => {
    render(
      <MixStrip {...baseProps} mixSeries={halfHourly(50)} meteredDate="2026-10-25" timeIndex={4} />,
    )
    // 4 × 30 min past a *nominal* midnight says 02:00; the clock goes back at
    // 02:00 BST, so the fifth period of that day is really 01:00 GMT.
    expect(screen.getByText('bars = generation at 01:00')).toBeTruthy()
    expect(screen.queryByText('bars = generation at 02:00')).toBeNull()
  })

  it('keeps the 46-period March day half-hourly and past the spring gap', () => {
    render(
      <MixStrip {...baseProps} mixSeries={halfHourly(46)} meteredDate="2026-03-29" timeIndex={3} />,
    )
    // Naive arithmetic says 01:30 — an hour that does not exist that day. A 46
    // that fell back to hourly labels would have said 03:00.
    expect(screen.getByText('bars = generation at 02:30')).toBeTruthy()
  })

  it('labels hourly EU snapshots by index, since those are already local hours', () => {
    render(
      <MixStrip
        {...baseProps}
        mixSeries={{ nuclear: new Array(24).fill(3800) }}
        meteredDate="2026-10-25"
        timeIndex={5}
      />,
    )
    expect(screen.getByText('bars = generation at 05:00')).toBeTruthy()
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
