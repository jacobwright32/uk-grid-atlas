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
