// @vitest-environment jsdom
// Compare view (#95): table semantics — sortable headers, row click-through,
// Escape, and the "no data" row treatment.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ComparePanel from './ComparePanel'
import { emptyRow } from '../lib/compare'
import type { CompareRow } from '../lib/compare'

const ROWS: CompareRow[] = [
  {
    ...emptyRow('si'),
    state: 'ok',
    totalMW: 1200,
    slices: [{ key: 'nuclear', label: 'Nuclear', color: '#9085e9', mw: 1200 }],
    renewShare: 0.1,
    carbonEst: 60,
    price: 80,
    currency: 'EUR',
    netMW: -300,
    netMeasured: true,
    ageH: 2,
  },
  {
    ...emptyRow('hr'),
    state: 'ok',
    totalMW: 2400,
    slices: [{ key: 'hydro', label: 'Hydro & pumped', color: '#1899ac', mw: 2400 }],
    renewShare: 0.9,
    carbonEst: 40,
    price: 90,
    currency: 'EUR',
    netMW: 500,
    netMeasured: false,
    ageH: 5,
  },
  emptyRow('mk'),
]

vi.mock('../lib/compare', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/compare')>()
  return {
    ...real,
    loadCompareRows: vi.fn(async (onUpdate: (r: CompareRow[], d: number, t: number) => void) => {
      onUpdate(ROWS, ROWS.length, ROWS.length)
      return ROWS
    }),
  }
})

afterEach(cleanup)

const gridNames = () =>
  screen
    .getAllByRole('row')
    .slice(1) // header row
    .map((tr) => tr.querySelector('th')?.textContent?.trim() ?? '')

describe('ComparePanel', () => {
  it('renders every grid, biggest generation first, no-data rows last', async () => {
    render(<ComparePanel onPick={() => {}} onClose={() => {}} />)
    expect(await screen.findByText('Croatia')).toBeTruthy()
    expect(gridNames()[0]).toContain('Croatia') // 2.4 GW > 1.2 GW
    expect(gridNames()[2]).toContain('North Macedonia')
    expect(screen.getByText('no live data yet')).toBeTruthy()
  })

  it('re-sorts when a header is clicked and exposes aria-sort', async () => {
    render(<ComparePanel onPick={() => {}} onClose={() => {}} />)
    await screen.findByText('Croatia')
    fireEvent.click(screen.getByRole('button', { name: /est\. CO₂/ }))
    // Numbers start biggest-first: Croatia 40 < Slovenia 60 → Slovenia first.
    expect(gridNames()[0]).toContain('Slovenia')
    const th = screen.getByRole('button', { name: /est\. CO₂/ }).closest('th')
    expect(th?.getAttribute('aria-sort')).toBe('descending')
    fireEvent.click(screen.getByRole('button', { name: /est\. CO₂/ }))
    expect(gridNames()[0]).toContain('Croatia')
    expect(th?.getAttribute('aria-sort')).toBe('ascending')
  })

  it('marks HVDC-only net figures with a dagger and measured ones without', async () => {
    render(<ComparePanel onPick={() => {}} onClose={() => {}} />)
    await screen.findByText('Croatia')
    expect(screen.getByText(/▼ 300 MW$/)).toBeTruthy() // measured export, no dagger
    expect(screen.getByText(/▲ 500 MW†/)).toBeTruthy() // links-only import
  })

  it('clicking a grid calls onPick; Escape closes', async () => {
    const onPick = vi.fn()
    const onClose = vi.fn()
    render(<ComparePanel onPick={onPick} onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: /Slovenia/ }))
    expect(onPick).toHaveBeenCalledWith('si')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
