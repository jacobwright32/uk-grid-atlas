/**
 * Browser-side Elexon Insights fetch orchestration.
 * All endpoints are free, key-less and CORS-open (Access-Control-Allow-Origin: *).
 * Every stage degrades independently; whatever succeeds is shown.
 */
import {
  aggregateDay,
  aggregatePN,
  chunk,
  currentSettlement,
  daysBefore,
  aggregateMID,
  londonDayStartMs,
  parseOutturn,
  parseOutturnDay,
  periodsInDay,
} from './live-core.mjs'
import type {
  B1610Row,
  MixDaySeries,
  MixSnapshot,
  PNRow,
  PriceDay,
  StationDay,
} from './live-core.mjs'
import { foldMixDay } from './fleet'
import { pooled } from './pool'

const API = 'https://data.elexon.co.uk/bmrs/api/v1'
const UNIT_BATCH = 30
const MAX_LOOKBACK_DAYS = 16
/** In-flight requests per fan-out — 13 unit batches used to go out at once (#9). */
const FETCH_POOL = 5
/** Metered-day probes in flight; see findLatestMeteredDay (#9). */
const PROBE_POOL = 3

export interface BmuMap {
  byUnit: Record<string, string>
  stations: Record<string, { units: { b: string; name: string; cap: number }[] }>
  sentinels: string[]
}

export interface LiveData {
  /** Which pipeline produced this data. */
  basis: 'elexon' | 'entsoe'
  /** ISO settlement date of the metered day. */
  meteredDate: string | null
  perStationDay: Map<string, StationDay>
  /** Scheduled output right now (PN), per station — Elexon only. */
  perStationNow: Map<string, number> | null
  mix: MixSnapshot | null
  /** Pre-computed mix rows (ENTSO-E snapshots ship them ready-made). */
  mixRows: import('./fleet').MixRow[] | null
  /** Per-fuel series over the metered day, keyed like the mix rows (#17). */
  mixSeries: Record<string, (number | null)[]> | null
  /** HVDC import total per interval, aligned with mixSeries (#17). */
  importSeries: (number | null)[] | null
  /** Per-link flow series over the metered day, + = import (#43). */
  flowSeries: Record<string, (number | null)[]> | null
  /** Wholesale prices over the metered day (day-ahead EU, market index GB). */
  prices: PriceDay | null
  /** Actual total load over the metered day, MW per interval (#24). */
  demandSeries: (number | null)[] | null
  /** Data-source label for UI copy ("ENTSO-E" default; "IESO" for Canada). */
  sourceLabel: string | null
  /** Today's partial mix from ENTSO-E — fresher than the metered day (#18). */
  today: EntsoeToday | null
  /** 'live' = fetched now; 'snapshot' = bundled/committed fallback. */
  source: 'live' | 'snapshot'
}

/** Today-so-far mix baked into ENTSO-E snapshots (#18 intraday). */
export interface EntsoeToday {
  date: string
  /** Today's day-ahead prices (fully known from yesterday's auction). */
  prices?: PriceDay | null
  /** Today's load so far (#24). */
  demandSeries?: (number | null)[] | null
  /** Data runs through this hour (e.g. 14 = through 13:59). */
  throughHour: number
  mixRows: import('./fleet').MixRow[]
  mixSeries: Record<string, (number | null)[]>
  importSeries: (number | null)[]
  totalMW: number
  importMW: number
}

/** Shape of public/live/<cc>.json written by fetch-entsoe-snapshot.mjs. */
interface EntsoeSnapshotFile {
  version: number
  basis: 'entsoe'
  date: string
  generatedAt: string
  perStation: Record<string, StationDay>
  mixRows: import('./fleet').MixRow[]
  mixSeries?: Record<string, (number | null)[]>
  importSeries?: (number | null)[]
  flowSeries?: Record<string, (number | null)[]>
  prices?: PriceDay | null
  demandSeries?: (number | null)[] | null
  sourceLabel?: string
  today?: EntsoeToday | null
  mix: MixSnapshot
}

/** Load a committed European snapshot; null when none exists yet (404). */
export async function loadEntsoeSnapshot(countryId: string): Promise<LiveData | null> {
  try {
    const res = await fetch(`live/${countryId}.json`, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return null
    const snap = (await res.json()) as EntsoeSnapshotFile
    const perStationDay = new Map<string, StationDay>(Object.entries(snap.perStation))
    return {
      basis: 'entsoe',
      meteredDate: snap.date,
      perStationDay,
      perStationNow: null,
      mix: snap.mix,
      mixRows: snap.mixRows,
      mixSeries: snap.mixSeries ?? null,
      importSeries: snap.importSeries ?? null,
      flowSeries: snap.flowSeries ?? null,
      prices: snap.prices ?? null,
      demandSeries: snap.demandSeries ?? null,
      sourceLabel: snap.sourceLabel ?? null,
      today: snap.today ?? null,
      source: 'live',
    }
  } catch {
    return null
  }
}

async function getJSON<T>(url: string, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return (await res.json()) as T
}

function b1610StreamUrl(date: string, units: string[]): string {
  const from = `${daysBefore(date, 1)}T22:00:00Z`
  const to = `${date}T23:30:00Z`
  const unitParams = units.map((u) => `&bmUnit=${encodeURIComponent(u)}`).join('')
  return `${API}/datasets/B1610/stream?from=${from}&to=${to}${unitParams}`
}

/**
 * Find the newest settlement day with metered data. Probed newest-first in
 * PROBE_POOL-wide windows, stopping at the first window that yields a hit: the
 * answer is nearly always day 1 or 2, so the old 16-way parallel fan-out was
 * almost entirely wasted requests, while a strictly serial walk would cost 16
 * round trips when nothing is metered at all (#9). MAX_LOOKBACK_DAYS still
 * bounds the search.
 */
export async function findLatestMeteredDay(sentinels: string[]): Promise<string | null> {
  const { settlementDate } = currentSettlement()
  const days = Array.from({ length: MAX_LOOKBACK_DAYS }, (_, i) =>
    daysBefore(settlementDate, i + 1),
  )
  const probe = async (date: string) => {
    const rows = await getJSON<B1610Row[]>(b1610StreamUrl(date, sentinels), 15_000)
    const hit =
      Array.isArray(rows) &&
      rows.some((r) => (r as { settlementDate?: string }).settlementDate === date)
    return hit ? date : null
  }
  for (let i = 0; i < days.length; i += PROBE_POOL) {
    const probes = await pooled(days.slice(i, i + PROBE_POOL), PROBE_POOL, probe)
    // Window results stay in input order, so the first hit is the newest day.
    for (const p of probes) if (p.status === 'fulfilled' && p.value) return p.value
  }
  return null
}

export async function fetchMeteredDay(
  date: string,
  bmuMap: BmuMap,
): Promise<Map<string, StationDay>> {
  const units = Object.keys(bmuMap.byUnit)
  const batches = chunk(units, UNIT_BATCH)
  const settled = await pooled(batches, FETCH_POOL, (batch) =>
    getJSON<(B1610Row & { settlementDate: string })[]>(b1610StreamUrl(date, batch)),
  )
  const rows: B1610Row[] = []
  let failures = 0
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      for (const row of s.value) if (row.settlementDate === date) rows.push(row)
    } else failures++
  }
  if (failures === batches.length) throw new Error('all B1610 batches failed')
  // Pass the date so a clock-change day keeps all 46/50 of its periods (#5).
  return aggregateDay(rows, bmuMap.byUnit, date)
}

export async function fetchScheduledNow(bmuMap: BmuMap): Promise<{
  perStation: Map<string, number>
  label: string
}> {
  const { settlementDate, settlementPeriod } = currentSettlement()
  const units = Object.keys(bmuMap.byUnit)
  const batches = chunk(units, UNIT_BATCH)
  const settled = await pooled(batches, FETCH_POOL, (batch) => {
    const unitParams = batch.map((u) => `&bmUnit=${encodeURIComponent(u)}`).join('')
    return getJSON<{ data: PNRow[] }>(
      `${API}/datasets/PN?settlementDate=${settlementDate}&settlementPeriod=${settlementPeriod}${unitParams}`,
    )
  })
  const rows: PNRow[] = []
  let ok = 0
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      rows.push(...s.value.data)
      ok++
    }
  }
  if (!ok) throw new Error('all PN batches failed')
  return {
    perStation: aggregatePN(rows, bmuMap.byUnit),
    label: `period ${settlementPeriod}, ${settlementDate}`,
  }
}

/**
 * UTC window covering exactly one GB settlement day. These endpoints filter on
 * instants, so a naive `${date}T00:00:00Z`…`T23:59:59Z` window sits an hour out
 * through BST — it drops SP 1-2 and drags in the next day's first periods, and
 * on the clocks-back day it would also cut SP 49/50 (#5).
 */
function settlementDayWindow(date: string): { from: string; to: string } {
  const start = londonDayStartMs(date)
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + 'Z'
  return { from: iso(start), to: iso(start + periodsInDay(date) * 1_800_000 - 1000) }
}

/** Volume-weighted market-index prices for one settlement day (£/MWh). */
export async function fetchPricesDay(date: string): Promise<PriceDay | null> {
  const { from, to } = settlementDayWindow(date)
  const rows = await getJSON<unknown>(`${API}/datasets/MID/stream?from=${from}&to=${to}`)
  return aggregateMID(rows, date)
}

/** Half-hourly FUELINST series for one settlement day (#17 mix scrub). */
export async function fetchMixDay(date: string): Promise<MixDaySeries | null> {
  const { from, to } = settlementDayWindow(date)
  const payload = await getJSON<unknown>(
    `${API}/generation/outturn/summary?startTime=${from}&endTime=${to}`,
  )
  return parseOutturnDay(payload, date)
}

export async function fetchMixNow(): Promise<MixSnapshot | null> {
  const now = new Date()
  const start = new Date(now.getTime() - 90 * 60_000).toISOString().slice(0, 19) + 'Z'
  const end = new Date(now.getTime() + 30 * 60_000).toISOString().slice(0, 19) + 'Z'
  const payload = await getJSON<unknown>(
    `${API}/generation/outturn/summary?startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}`,
  )
  return parseOutturn(payload)
}

export interface SnapshotFile {
  date: string
  generatedAt: string
  perStation: Record<string, StationDay>
  mix: MixSnapshot | null
}

/** Full load: metered day + scheduled-now + mix, falling back per stage. */
export async function loadLive(bmuMap: BmuMap, snapshot: SnapshotFile | null): Promise<LiveData> {
  const [mixR, dayR, nowR] = await Promise.allSettled([
    fetchMixNow(),
    (async () => {
      const date = await findLatestMeteredDay(bmuMap.sentinels)
      if (!date) throw new Error('no metered day found')
      const [per, mixDay, prices] = await Promise.all([
        fetchMeteredDay(date, bmuMap),
        fetchMixDay(date).catch(() => null),
        fetchPricesDay(date).catch(() => null),
      ])
      return { date, per, mixDay, prices }
    })(),
    fetchScheduledNow(bmuMap),
  ])

  const day = dayR.status === 'fulfilled' ? dayR.value : null
  const nowData = nowR.status === 'fulfilled' ? nowR.value : null
  const mix = mixR.status === 'fulfilled' ? mixR.value : null

  if (day || nowData || mix) {
    return {
      basis: 'elexon',
      meteredDate: day?.date ?? null,
      perStationDay: day?.per ?? snapshotToMap(snapshot),
      perStationNow: nowData?.perStation ?? null,
      mix,
      mixRows: null,
      mixSeries: day?.mixDay ? foldMixDay(day.mixDay) : null,
      importSeries: day?.mixDay?.imports ?? null,
      flowSeries: day?.mixDay?.interconnectors ?? null,
      prices: day?.prices ?? null,
      demandSeries: null, // GB day view is browser-live; demand ships in history

      sourceLabel: null,
      today: null, // GB's default view is already instantaneous (FUELINST)
      source: 'live',
    }
  }
  // fully offline → bundled snapshot
  return {
    basis: 'elexon',
    meteredDate: snapshot?.date ?? null,
    perStationDay: snapshotToMap(snapshot),
    perStationNow: null,
    mix: snapshot?.mix ?? null,
    mixRows: null,
    mixSeries: null,
    importSeries: null,
    flowSeries: null,
    prices: null,
    demandSeries: null,
    sourceLabel: null,
    today: null,
    source: 'snapshot',
  }
}

function snapshotToMap(snapshot: SnapshotFile | null): Map<string, StationDay> {
  const map = new Map<string, StationDay>()
  if (snapshot) for (const [id, day] of Object.entries(snapshot.perStation)) map.set(id, day)
  return map
}
