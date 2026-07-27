// @vitest-environment jsdom
// Drawer modality at the one true breakpoint (#12, #13) and the partial-load
// notice (#3). The sidebar is a permanent panel on desktop and a modal drawer
// on phones, and three disagreeing breakpoints used to leave 640–760px wide
// with an overlaying panel, no scrim and no Escape — these tests drive the
// viewport width directly, so that gap can't reopen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { GridData } from './lib/types'

const mocks = vi.hoisted(() => ({
  grid: {
    data: null as unknown,
    error: null as string | null,
    failures: 0,
    total: 22,
    retry: vi.fn(),
  },
  live: { status: 'unavailable' as const, live: null, bmuMap: null },
}))

vi.mock('./hooks/useGridData', () => ({ useGridData: () => mocks.grid }))
vi.mock('./hooks/useLiveData', () => ({ useLiveData: () => mocks.live }))
// MapLibre needs WebGL, which jsdom has none of; the map pane's own attributes
// are App's, not the map's, so a stub is enough here.
vi.mock('./components/GridMap', () => ({ default: () => null }))

const App = (await import('./App')).default

const data = {
  stations: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-1, 52] },
        properties: { id: 'gb/sizewell', name: 'Sizewell B', fuel: 'nuclear', capacityMW: 1200 },
      },
    ],
  },
  transmission: { type: 'FeatureCollection', features: [] },
  interconnectors: { type: 'FeatureCollection', features: [] },
  basemap: { type: 'FeatureCollection', features: [] },
  meta: { generated: '2026-07-01', stationCount: 1, lineCount: 0, attribution: 'OSM' },
} as unknown as GridData

// ---------------------------------------------------------------- viewport
interface Stub {
  media: string
  matches: boolean
  listeners: Set<() => void>
}
let width = 1200
const stubs: Stub[] = []

const evaluate = (media: string): boolean => {
  const min = /min-width:\s*([\d.]+)px/.exec(media)
  if (min?.[1]) return width >= Number(min[1])
  const max = /max-width:\s*([\d.]+)px/.exec(media)
  if (max?.[1]) return width <= Number(max[1])
  return false // prefers-reduced-motion et al
}

/** Resize the "viewport", firing `change` exactly like a real MediaQueryList. */
function setWidth(next: number) {
  width = next
  act(() => {
    for (const s of stubs) {
      const now = evaluate(s.media)
      if (now === s.matches) continue
      s.matches = now
      for (const fn of s.listeners) fn()
    }
  })
}

beforeEach(() => {
  width = 1200
  stubs.length = 0
  mocks.grid = { data, error: null, failures: 0, total: 22, retry: vi.fn() }
  window.location.hash = ''
  // jsdom implements neither of these.
  Element.prototype.scrollIntoView = vi.fn()
  window.matchMedia = ((media: string) => {
    const stub: Stub = { media, matches: evaluate(media), listeners: new Set() }
    stubs.push(stub)
    return {
      media,
      get matches() {
        return stub.matches
      },
      addEventListener: (_type: string, fn: () => void) => stub.listeners.add(fn),
      removeEventListener: (_type: string, fn: () => void) => stub.listeners.delete(fn),
      addListener: (fn: () => void) => stub.listeners.add(fn),
      removeListener: (fn: () => void) => stub.listeners.delete(fn),
      dispatchEvent: () => true,
      onchange: null,
    } as unknown as MediaQueryList
  }) as typeof window.matchMedia
})

afterEach(cleanup)

const panel = () => document.querySelector('.sidebar')!
const scrim = () => document.querySelector('.sidebar-scrim')
const burger = () => screen.getByRole('button', { name: /legend$/ })

/** Render at `w` px wide, opening the drawer if the layout starts it closed. */
function renderAt(w: number, { open = true } = {}) {
  width = w
  const view = render(<App />)
  if (open && !panel().getAttribute('role') && w <= 760) fireEvent.click(burger())
  return view
}

describe('sidebar on desktop (> 760px)', () => {
  it('is a docked panel, not a dialog, and nothing goes inert', () => {
    renderAt(1200)
    expect(panel().getAttribute('role')).toBeNull()
    expect(scrim()).toBeNull()
    expect(document.querySelector('.topbar')?.hasAttribute('inert')).toBe(false)
    expect(document.querySelector('.map-pane')?.hasAttribute('inert')).toBe(false)
  })

  it('ignores Escape — there is nothing overlaying the map to dismiss', () => {
    renderAt(1200)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.shell--collapsed')).toBeNull()
  })
})

describe('sidebar as a drawer (≤ 760px)', () => {
  it('starts collapsed on phones and the burger reports it', () => {
    renderAt(420, { open: false })
    expect(document.querySelector('.shell--collapsed')).toBeTruthy()
    expect(burger().getAttribute('aria-expanded')).toBe('false')
  })

  it('opens as a modal dialog over an inert page', () => {
    renderAt(420)
    expect(panel().getAttribute('role')).toBe('dialog')
    expect(panel().getAttribute('aria-modal')).toBe('true')
    expect(scrim()).toBeTruthy()
    expect(document.querySelector('.topbar')?.hasAttribute('inert')).toBe(true)
    expect(document.querySelector('.map-pane')?.hasAttribute('inert')).toBe(true)
  })

  it('exposes exactly one way out to assistive tech, not the scrim as well', () => {
    renderAt(420)
    // The scrim duplicates the drawer's ✕, so it is a pointer affordance only.
    expect(screen.getAllByRole('button', { name: 'Close the legend' })).toHaveLength(1)
    expect(scrim()?.getAttribute('aria-hidden')).toBe('true')
    expect(scrim()?.getAttribute('tabindex')).toBe('-1')
  })

  it('closes on Escape', () => {
    renderAt(420)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(panel().getAttribute('role')).toBeNull()
    expect(scrim()).toBeNull()
  })

  it('closes on the scrim', () => {
    renderAt(420)
    fireEvent.click(scrim()!)
    expect(document.querySelector('.shell--collapsed')).toBeTruthy()
  })

  it('hands focus back to the burger on close', () => {
    renderAt(420)
    // The trap put focus on the drawer's close button, which is about to
    // unmount — without the restore, focus would fall to <body>.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close the legend' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(burger())
  })

  it('is still a drawer at 700px, the width the old 640px cutoff mishandled (#13)', () => {
    renderAt(700)
    expect(panel().getAttribute('role')).toBe('dialog')
    expect(scrim()).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(scrim()).toBeNull()
  })

  it('is a docked panel again at 761px, the far side of the same cutoff', () => {
    renderAt(761)
    expect(panel().getAttribute('role')).toBeNull()
    expect(scrim()).toBeNull()
  })
})

describe('sidebar across a resize', () => {
  it('drops modality without closing when the window grows to desktop', () => {
    renderAt(420)
    expect(panel().getAttribute('role')).toBe('dialog')
    setWidth(1200)
    expect(panel().getAttribute('role')).toBeNull()
    expect(scrim()).toBeNull()
    expect(document.querySelector('.map-pane')?.hasAttribute('inert')).toBe(false)
    // The panel is still open — it just docked.
    expect(document.querySelector('.shell--collapsed')).toBeNull()
  })

  it('becomes modal when an open panel is squeezed onto a phone width', () => {
    renderAt(1200)
    setWidth(420)
    expect(panel().getAttribute('role')).toBe('dialog')
    expect(scrim()).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(panel().getAttribute('role')).toBeNull()
  })
})

describe('partial-load notice (#3)', () => {
  it('owns up to the grids that failed and offers a retry', () => {
    const retry = vi.fn()
    mocks.grid = { data, error: null, failures: 2, total: 22, retry }
    render(<App />)
    const notice = screen.getByRole('status')
    expect(notice.textContent).toMatch(/2 of 22 grids didn.t load — showing the rest/)
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('stays out of the way on a clean load', () => {
    render(<App />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('button', { name: 'retry' })).toBeNull()
  })
})
