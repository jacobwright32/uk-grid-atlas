// @vitest-environment jsdom
// Sidebar dialog semantics (#12): on desktop the panel is docked page furniture
// and must stay that way — the modal behaviour (role, focus-in, Tab trap) is
// only correct on narrow viewports where it floats over the map.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Sidebar from './Sidebar'
import { COUNTRIES } from '../lib/countries'
import type { GridMeta, GroupId, NetworkToggles } from '../lib/types'
import type { StatsByGroup } from '../lib/filter'
import type { GridCoverage } from '../hooks/useCoverage'

// The coverage block reads the workflow-baked file through useCoverage;
// render tests inject rows directly (the fetch/caching is the hook's story).
const mockCoverage = vi.hoisted(() => ({ current: null as GridCoverage | null }))
vi.mock('../hooks/useCoverage', () => ({
  useCoverage: () => mockCoverage.current,
}))

afterEach(cleanup)

const stats: StatsByGroup = new Map([
  ['nuclear', { count: 9, capacityMW: 5900, unknownCapacity: 0 }],
  ['wind_offshore', { count: 40, capacityMW: 14000, unknownCapacity: 2 }],
])

const meta: GridMeta = {
  generated: '2026-07-01',
  stationCount: 1200,
  lineCount: 4000,
  attribution: 'OpenStreetMap',
}

const network: NetworkToggles = {
  t1: true,
  t2: true,
  t3: false,
  hvdc: true,
  construction: false,
}

const base = {
  asDialog: false,
  onClose: () => {},
  country: COUNTRIES.gb,
  stats,
  enabled: new Set<GroupId>(['nuclear']) as ReadonlySet<GroupId>,
  onToggleGroup: () => {},
  onAll: () => {},
  onNone: () => {},
  network,
  onNetwork: () => {},
  tiles: false,
  onTiles: () => {},
  meta,
  liveStatus: 'live' as const,
  live: null,
  liveMode: false,
  onLiveMode: () => {},
}

/** Every element the trap considers, in DOM order. */
const focusables = (panel: Element) =>
  [
    ...panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ] as HTMLElement[]

describe('Sidebar docked (desktop)', () => {
  it('is a plain labelled region, not a dialog', () => {
    const { container } = render(<Sidebar {...base} />)
    const panel = container.querySelector('.sidebar')!
    expect(panel.getAttribute('role')).toBeNull()
    expect(panel.getAttribute('aria-modal')).toBeNull()
    expect(panel.getAttribute('aria-label')).toBe('Legend and filters')
  })

  it('has no close button, since the burger is not hidden behind a scrim', () => {
    render(<Sidebar {...base} />)
    expect(screen.queryByRole('button', { name: 'Close the legend' })).toBeNull()
  })

  it('leaves focus alone — the panel is always on screen, so it never "opens"', () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    render(<Sidebar {...base} />)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('does not trap Tab', () => {
    const { container } = render(<Sidebar {...base} />)
    const panel = container.querySelector('.sidebar')!
    const last = focusables(panel).at(-1)!
    last.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
  })
})

describe('Sidebar as dialog (narrow)', () => {
  it('announces itself as a modal dialog', () => {
    const { container } = render(<Sidebar {...base} asDialog />)
    const panel = container.querySelector('.sidebar')!
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('true')
  })

  it('moves focus to the close button on open', () => {
    render(<Sidebar {...base} asDialog />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close the legend' }))
  })

  it('closes on the close button', () => {
    const onClose = vi.fn()
    render(<Sidebar {...base} asDialog onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close the legend' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('wraps Tab from the last control back to the first', () => {
    const { container } = render(<Sidebar {...base} asDialog />)
    const panel = container.querySelector('.sidebar')!
    const items = focusables(panel)
    items.at(-1)!.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(items[0])
  })

  it('wraps Shift+Tab from the first control back to the last', () => {
    const { container } = render(<Sidebar {...base} asDialog />)
    const panel = container.querySelector('.sidebar')!
    const items = focusables(panel)
    items[0]!.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(items.at(-1))
  })

  it('pulls focus back in when it starts outside the drawer', () => {
    const { container } = render(<Sidebar {...base} asDialog />)
    const panel = container.querySelector('.sidebar')!
    // Nothing behind the scrim is focusable, but focus can still be on <body>.
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(panel.contains(document.activeElement)).toBe(true)
  })

  it('skips the disabled live checkbox, so Tab cannot land on nothing', () => {
    // `live: null` disables "size dots by output" — a disabled input is not a
    // tab stop, so treating it as the drawer's first focusable would send the
    // Shift+Tab wrap into a dead end.
    const { container } = render(<Sidebar {...base} asDialog />)
    const panel = container.querySelector('.sidebar')!
    expect(panel.querySelector('input[type="checkbox"]:disabled')).toBeTruthy()
    expect(focusables(panel).some((el) => (el as HTMLInputElement).disabled)).toBe(false)
  })

  it('stops trapping and drops dialog semantics when it docks again', () => {
    const { container, rerender } = render(<Sidebar {...base} asDialog />)
    const panel = container.querySelector('.sidebar')!
    rerender(<Sidebar {...base} asDialog={false} />)
    expect(panel.getAttribute('role')).toBeNull()
    const items = focusables(panel)
    items.at(-1)!.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
  })
})

describe('per-grid honesty (gaps audit)', () => {
  const bakedLive = (generatedAt: string) =>
    ({
      basis: 'entsoe',
      meteredDate: '2026-08-02',
      generatedAt,
      perStationNow: null,
      sourceLabel: undefined,
    }) as never

  it('renders the authored liveNote for an ENTSO-E grid, not the generic footnote', () => {
    render(<Sidebar {...base} country={COUNTRIES.ba} live={bakedLive(new Date().toISOString())} />)
    // ba's note is the no-prices disclosure — previously authored but never shown.
    expect(screen.getByText(/no day-ahead prices/i)).toBeTruthy()
  })

  it('reports measured snapshot age instead of a hard-coded cadence claim', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString()
    render(<Sidebar {...base} country={COUNTRIES.si} live={bakedLive(threeHoursAgo)} />)
    expect(screen.getByText(/updated 3 h ago/)).toBeTruthy()
    expect(screen.queryByText(/refreshed every 6 h/)).toBeNull()
  })

  it('flags a snapshot older than two refresh cycles as possibly stale', () => {
    const dayOld = new Date(Date.now() - 26 * 3_600_000).toISOString()
    render(<Sidebar {...base} country={COUNTRIES.si} live={bakedLive(dayOld)} />)
    expect(screen.getByText(/refresh workflow may be down/)).toBeTruthy()
  })
})

describe('coverage block (#96)', () => {
  const bakedLive = () =>
    ({
      basis: 'entsoe',
      meteredDate: '2026-08-02',
      generatedAt: new Date().toISOString(),
      perStationNow: null,
      sourceLabel: undefined,
    }) as never
  const full: GridCoverage = {
    source: 'ENTSO-E',
    snapshot: true,
    browserLive: false,
    generatedAt: '2026-08-03T12:00:00Z',
    meteredDate: '2026-08-02',
    perStationLive: 8,
    intraday: true,
    prices: false,
    demand: true,
    flows: 'net',
    links: 0,
    historyDays: 31,
    hourlyDays: 7,
    perStationHistoryDays: 7,
    priceDays: 0,
    demandDays: 31,
    currency: null,
  }
  afterEach(() => {
    mockCoverage.current = null
  })

  it('states measured coverage, absences included', () => {
    mockCoverage.current = full
    render(<Sidebar {...base} country={COUNTRIES.ba} live={bakedLive()} />)
    expect(screen.getByText('What this grid publishes')).toBeTruthy()
    expect(screen.getByText('8 stations')).toBeTruthy()
    expect(screen.getByText('every border')).toBeTruthy()
    expect(screen.getByText('not published')).toBeTruthy() // ba's prices, honestly
    expect(screen.getByText(/31 days · 7 hourly · 7 per-station/)).toBeTruthy()
  })

  it('says HVDC-only when that is all that is measured', () => {
    mockCoverage.current = { ...full, flows: 'hvdc', links: 4 }
    render(<Sidebar {...base} country={COUNTRIES.de} live={bakedLive()} />)
    expect(screen.getByText('HVDC links only')).toBeTruthy()
  })

  it('renders nothing before the file loads (or if it never bakes)', () => {
    mockCoverage.current = null
    render(<Sidebar {...base} country={COUNTRIES.si} live={bakedLive()} />)
    expect(screen.queryByText('What this grid publishes')).toBeNull()
  })
})
