import { useEffect, useMemo, useRef, useState } from 'react'
import type { GridData } from '../lib/types'
import { FUEL_COLOR, FUEL_LABEL } from '../lib/fuels'
import type { FuelId } from '../lib/types'
import { fmtMW } from '../lib/format'

export interface SearchTarget {
  id: string
  coords: [number, number]
  /** monotonically increasing so re-selecting the same station re-flies */
  tick: number
}

interface Props {
  data: GridData
  onSelect: (target: SearchTarget) => void
}

/** Accent/case-insensitive haystack normalisation (client-side twin of the
 *  pipeline's fold — ł and the Nordic letters have no NFD decomposition). */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(
      /[äöüßæøåł]/g,
      (c) => ({ ä: 'a', ö: 'o', ü: 'u', ß: 'ss', æ: 'ae', ø: 'o', å: 'a', ł: 'l' })[c] ?? c,
    )
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

interface Entry {
  id: string
  name: string
  fuel: FuelId
  capacityMW: number | null
  coords: [number, number]
  hay: string
}

export default function SearchBox({ data, onSelect }: Props) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const tickRef = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Build the search index once per dataset.
  const index = useMemo<Entry[]>(
    () =>
      data.stations.features
        .filter((f) => f.properties.name !== 'Unnamed site')
        .map((f) => ({
          id: f.properties.id,
          name: f.properties.name,
          fuel: f.properties.fuel as FuelId,
          capacityMW: f.properties.capacityMW ?? null,
          coords: f.geometry.coordinates as [number, number],
          hay: fold(f.properties.name),
        })),
    [data],
  )

  const results = useMemo(() => {
    const needle = fold(q.trim())
    if (needle.length < 2) return []
    const starts: Entry[] = []
    const contains: Entry[] = []
    for (const e of index) {
      const at = e.hay.indexOf(needle)
      if (at === 0) starts.push(e)
      else if (at > 0) contains.push(e)
    }
    const byCap = (a: Entry, b: Entry) => (b.capacityMW ?? 0) - (a.capacityMW ?? 0)
    return [...starts.sort(byCap), ...contains.sort(byCap)].slice(0, 8)
  }, [q, index])

  // Close on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  // "/" focuses search from anywhere (unless already typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pick = (e: Entry) => {
    tickRef.current += 1
    onSelect({ id: e.id, coords: e.coords, tick: tickRef.current })
    setOpen(false)
    inputRef.current?.blur()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      const hit = results[cursor] ?? results[0]
      if (hit) pick(hit)
    } else if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  return (
    <div className="searchbox" ref={rootRef} role="search">
      <input
        ref={inputRef}
        type="search"
        className="searchbox-input"
        placeholder="Search stations…  ( / )"
        aria-label="Search power stations by name"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="searchbox-results"
        aria-activedescendant={open && results[cursor] ? `search-opt-${cursor}` : undefined}
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setCursor(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && results.length > 0 && (
        <ul className="searchbox-results" id="searchbox-results" role="listbox">
          {results.map((r, i) => (
            <li key={r.id} role="presentation">
              <button
                type="button"
                id={`search-opt-${i}`}
                role="option"
                aria-selected={i === cursor}
                className={`searchbox-item${i === cursor ? ' searchbox-item--on' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(r)}
              >
                <i style={{ background: FUEL_COLOR.get(r.fuel) ?? '#898781' }} />
                <span className="searchbox-name">{r.name}</span>
                <span className="searchbox-meta">
                  {FUEL_LABEL[r.fuel] ?? r.fuel}
                  {r.capacityMW != null ? ` · ${fmtMW(r.capacityMW)}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
