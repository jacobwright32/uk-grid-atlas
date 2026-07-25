/**
 * Rolling mix + price history (live/history/<cc>.json), baked by the
 * snapshot fetchers: a week of hourly series and a month of daily averages.
 * Loaded lazily — only when the user flips the mix strip off the day view.
 */

export interface HistoryDay {
  date: string
  /** bucket key → day-average MW */
  mix: Record<string, number>
  importMW: number | null
  totalMW: number
  price: number | null
}

export interface HistoryHourly {
  date: string
  mixSeries: Record<string, (number | null)[]>
  importSeries: (number | null)[] | null
  prices: (number | null)[] | null
}

export interface HistoryFile {
  version: number
  updatedAt: string
  currency: string | null
  sourceLabel: string | null
  /** Oldest → newest, ≤ 31. */
  days: HistoryDay[]
  /** Oldest → newest, ≤ 7 (a subset of the days window). */
  hourly: HistoryHourly[]
}

/**
 * Snapshot mix-bucket palette — mirrors BUCKET_META in
 * scripts/snapshot-common.mjs (history files carry keys only, no colours).
 */
export const HISTORY_BUCKETS: Record<string, { label: string; color: string }> = {
  wind: { label: 'Wind', color: '#199e70' },
  solar: { label: 'Solar', color: '#c98500' },
  gas: { label: 'Gas', color: '#3987e5' },
  nuclear: { label: 'Nuclear', color: '#9085e9' },
  coal: { label: 'Coal & lignite', color: '#ad7a45' },
  geothermal: { label: 'Geothermal', color: '#bd5fd1' },
  biomass: { label: 'Biomass & waste', color: '#d95926' },
  hydro: { label: 'Hydro & pumped', color: '#1899ac' },
  other: { label: 'Oil & other', color: '#e66767' },
}
export const HISTORY_FALLBACK_COLOR = '#898781'

/** Load a country's baked history; null when none exists yet (404). */
export async function loadHistory(countryId: string): Promise<HistoryFile | null> {
  try {
    const res = await fetch(`live/history/${countryId}.json`, {
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    const h = (await res.json()) as HistoryFile
    return Array.isArray(h.days) && h.days.length ? h : null
  } catch {
    return null
  }
}

/** Bucket keys ordered by total energy, biggest first — stable stacking. */
export function bucketOrder(days: HistoryDay[]): string[] {
  const totals = new Map<string, number>()
  for (const d of days) {
    for (const [key, mw] of Object.entries(d.mix)) {
      totals.set(key, (totals.get(key) ?? 0) + mw)
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
}

/** Whole days from `first` to `date` (both ISO). */
export function dayIndexOf(first: string, date: string): number {
  return Math.round(
    (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86_400_000,
  )
}

/** Every calendar day from `first` to `last` inclusive. */
export function calendarDays(first: string, last: string): string[] {
  const out: string[] = []
  const end = dayIndexOf(first, last)
  for (let i = 0; i <= end; i++) {
    out.push(new Date(Date.parse(`${first}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10))
  }
  return out
}

export interface StitchedWeek {
  /** Every calendar day in the window — slots [i*24 … i*24+23] each. */
  dates: string[]
  /** Buckets ordered biggest-first. */
  keys: string[]
  /** Continuous hourly series, length = dates.length × 24. */
  series: Record<string, (number | null)[]>
  prices: (number | null)[] | null
  imports: (number | null)[] | null
}

/**
 * Flatten hourly day records (oldest → newest) onto the calendar: a day the
 * fetcher never recorded stays a 24-slot null gap in every series rather
 * than being spliced out — time distances on the chart stay honest.
 */
export function stitchHourly(hourly: HistoryHourly[]): StitchedWeek {
  const firstRec = hourly[0]
  const lastRec = hourly[hourly.length - 1]
  if (!firstRec || !lastRec) {
    return { dates: [], keys: [], series: {}, prices: null, imports: null }
  }
  const first = firstRec.date
  const dates = calendarDays(first, lastRec.date)
  const n = dates.length * 24
  const keys = new Set<string>()
  for (const h of hourly) for (const k of Object.keys(h.mixSeries)) keys.add(k)

  const place = (
    out: (number | null)[],
    h: HistoryHourly,
    s: (number | null)[] | undefined | null,
  ) => {
    if (!s) return
    const base = dayIndexOf(first, h.date) * 24
    for (let hr = 0; hr < 24; hr++) out[base + hr] = s[hr] ?? null
  }

  const series: Record<string, (number | null)[]> = {}
  for (const key of keys) {
    const out = new Array<number | null>(n).fill(null)
    for (const h of hourly) place(out, h, h.mixSeries[key])
    series[key] = out
  }

  const stitchAux = (pick: (h: HistoryHourly) => (number | null)[] | null) => {
    if (!hourly.some((h) => pick(h)?.some((v) => v != null))) return null
    const out = new Array<number | null>(n).fill(null)
    for (const h of hourly) place(out, h, pick(h))
    return out
  }

  // Order stacked areas by each bucket's total, biggest at the bottom.
  const totals = new Map<string, number>()
  for (const [key, s] of Object.entries(series)) {
    totals.set(
      key,
      s.reduce<number>((a, v) => a + (v ?? 0), 0),
    )
  }
  const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)

  return {
    dates,
    keys: ordered,
    series,
    prices: stitchAux((h) => h.prices),
    imports: stitchAux((h) => h.importSeries),
  }
}

/** "2026-07-24" → "24 Jul" (axis/readout label). */
export function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
