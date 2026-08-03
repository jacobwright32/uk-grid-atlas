/**
 * Compare view (#95): one row per grid, built from the same live snapshots
 * the single-country views read — nothing new is fetched from any TSO, just
 * the ~32 baked JSON files (plus GB's one live FUELINST call) through the
 * pool. Loaded on demand when #compare opens.
 */
import { COUNTRIES, REAL_COUNTRY_IDS } from './countries'
import type { CountryId } from './countries'
import { intensityOf } from './carbon'
import { fetchMixNow, loadEntsoeSnapshot } from './live'
import type { LiveData } from './live'
import type { MixSnapshot } from './live-core.mjs'
import type { MixRow } from './fleet'
import { computeMixRows } from './fleet'
import { pooled } from './pool'

export interface CompareSlice {
  key: string
  label: string
  color: string
  mw: number
}

export interface CompareRow {
  id: CountryId
  name: string
  flag: string
  /** 'ok' — figures loaded; 'none' — no snapshot baked yet / fetch failed. */
  state: 'ok' | 'none'
  /** Generation, MW — imports excluded (matches the mix strip's total). */
  totalMW: number
  /** Generation buckets, biggest first — the stacked bar. */
  slices: CompareSlice[]
  /** Wind+solar+hydro+geothermal+biomass over generation, 0..1. */
  renewShare: number | null
  /** Estimated lifecycle intensity, gCO₂eq/kWh — see CARBON_FACTORS. */
  carbonEst: number | null
  /** Day-average wholesale price, in `currency` per MWh. */
  price: number | null
  currency: string | null
  /** Signed net trade, + import / − export; null when nothing is measured. */
  netMW: number | null
  /** True when every border is measured (#93 A11 sum, or GB's island set). */
  netMeasured: boolean
  /** Hours since the figures were produced; ~0 on GB's browser-live path. */
  ageH: number | null
  /** Which day the figures describe. */
  basis: 'live' | 'today' | 'day'
}

const RENEWABLE_KEYS = new Set(['wind', 'solar', 'hydro', 'geothermal', 'biomass'])

/**
 * Emissions estimate over generation slices; null when nothing qualifies.
 * Delegates to the one factor table (lib/carbon, #21 — the same numbers the
 * python package's fuels.py publishes) so every artifact says the same
 * gCO₂e/kWh for the same mix.
 */
export function carbonEstimate(slices: CompareSlice[]): number | null {
  return intensityOf(slices.map((s) => ({ key: s.key, nowMW: s.mw })))
}

/** Renewable share of generation, 0..1; null with no generation at all. */
export function renewableShare(slices: CompareSlice[]): number | null {
  let total = 0
  let renew = 0
  for (const s of slices) {
    total += s.mw
    if (RENEWABLE_KEYS.has(s.key)) renew += s.mw
  }
  return total > 0 ? renew / total : null
}

const HOUR_MS = 3_600_000

function priceAvg(prices: { series: (number | null)[] } | null | undefined): number | null {
  const vals = prices?.series.filter((v): v is number => v != null) ?? []
  if (!vals.length) return null
  return vals.reduce((a, v) => a + v, 0) / vals.length
}

/**
 * Signed net trade for one basis. The imports row's post-#93 label carries
 * the semantics: "Net imports"/"Net exports" means the A11 sum over every
 * border, the HVDC qualifier means mapped links only — and no row at all
 * means nothing was measured (the honesty-A suppression), in which case the
 * snapshot's 0 must not be read as "trades nothing". Snapshots baked before
 * that suppression still carry a phantom zero-MW HVDC row over an all-null
 * series; the same client-side guard MixStrip applies drops it here too.
 */
function netFrom(
  rows: MixRow[],
  importMW: number | null | undefined,
  flowsMeasured: boolean,
): { netMW: number | null; netMeasured: boolean } {
  const row = rows.find((r) => r.key === 'imports')
  if (!row || importMW == null) return { netMW: null, netMeasured: false }
  const hvdcOnly = !(row.label === 'Net imports' || row.label === 'Net exports')
  if (hvdcOnly && !flowsMeasured && row.nowMW === 0) return { netMW: null, netMeasured: false }
  return { netMW: importMW, netMeasured: !hvdcOnly }
}

/** Build a compare row from a country's LiveData (pure — unit-tested). */
export function rowFromLive(id: CountryId, live: LiveData, now = Date.now()): CompareRow {
  const c = COUNTRIES[id]
  // GB's browser-live path ships raw FUELINST fuels; fold them into buckets
  // with no capacity context (compare needs none). ENTSO-E rows come baked.
  const gbRows =
    live.basis === 'elexon' && live.mix ? computeMixRows(live.mix, new Map(), 0) : null
  const dayRows = live.mixRows ?? gbRows ?? []
  // Prefer the intraday block when the bake produced one — hours fresher
  // than the metered day, and self-consistent (rows + net + prices).
  const t = live.today
  const rows = t?.mixRows ?? dayRows
  const basis: CompareRow['basis'] = live.basis === 'elexon' ? 'live' : t ? 'today' : 'day'

  const slices = rows
    .filter((r) => r.key !== 'imports' && r.nowMW > 0)
    .map((r) => ({ key: r.key, label: r.label, color: r.color, mw: r.nowMW }))
  const totalMW = slices.reduce((a, s) => a + s.mw, 0)

  const flowSeries = t ? t.importSeries : live.importSeries
  const flowsMeasured = flowSeries?.some((v) => v != null) ?? false
  const net =
    live.basis === 'elexon' && live.mix
      ? // An island grid's interconnectors *are* its borders, and FUELINST
        // reports them all — GB's HVDC figure is already the net position.
        { netMW: live.mix.importMW, netMeasured: true }
      : netFrom(rows, t ? t.importMW : (live.mix?.importMW ?? null), flowsMeasured)

  const priceDay = t?.prices ?? live.prices
  const stampMs = live.generatedAt
    ? Date.parse(live.generatedAt)
    : live.basis === 'elexon' && live.mix
      ? Date.parse(live.mix.time)
      : NaN

  return {
    id,
    name: c.name,
    flag: c.flag,
    state: slices.length ? 'ok' : 'none',
    totalMW,
    slices,
    renewShare: renewableShare(slices),
    carbonEst: carbonEstimate(slices),
    price: priceAvg(priceDay),
    currency: priceDay?.currency ?? null,
    netMW: net.netMW,
    netMeasured: net.netMeasured,
    ageH: Number.isFinite(stampMs) ? Math.max(0, (now - stampMs) / HOUR_MS) : null,
    basis,
  }
}

/** Placeholder for a grid with no loadable live data. */
export function emptyRow(id: CountryId): CompareRow {
  const c = COUNTRIES[id]
  return {
    id,
    name: c.name,
    flag: c.flag,
    state: 'none',
    totalMW: 0,
    slices: [],
    renewShare: null,
    carbonEst: null,
    price: null,
    currency: null,
    netMW: null,
    netMeasured: false,
    ageH: null,
    basis: 'day',
  }
}

/** Minimal LiveData wrapper for GB's one-request compare path. */
function gbLive(mix: MixSnapshot): LiveData {
  return {
    basis: 'elexon',
    meteredDate: null,
    generatedAt: null,
    perStationDay: new Map(),
    perStationNow: null,
    mix,
    mixRows: null,
    mixSeries: null,
    importSeries: null,
    flowSeries: null,
    prices: null,
    demandSeries: null,
    sourceLabel: null,
    today: null,
    source: 'live',
  }
}

/**
 * GB's compare price rides the baked history file (one small fetch) — the
 * browser-live MID pipeline would cost a metered-day probe plus a stream
 * call, far too heavy for one table cell. Latest baked day, so typically a
 * day behind the EU rows' day-ahead figures; the panel footnote says so.
 */
async function gbPrice(): Promise<{ price: number | null; currency: string | null }> {
  try {
    const res = await fetch('live/history/gb.json', { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return { price: null, currency: null }
    const h = (await res.json()) as {
      currency?: string | null
      days?: { price: number | null }[]
    }
    const last = [...(h.days ?? [])].reverse().find((d) => d.price != null)
    return last ? { price: last.price, currency: h.currency ?? 'GBP' } : { price: null, currency: null }
  } catch {
    return { price: null, currency: null }
  }
}

/**
 * Load every grid's row, a few in flight at a time, reporting progress as
 * rows land so the table can fill in live. Never rejects; grids that fail
 * become 'none' rows.
 */
export async function loadCompareRows(
  onUpdate: (rows: CompareRow[], done: number, total: number) => void,
  concurrency = 6,
): Promise<CompareRow[]> {
  const ids = REAL_COUNTRY_IDS
  const out: CompareRow[] = []
  let done = 0
  await pooled(ids, concurrency, async (id) => {
    let row: CompareRow
    try {
      if (COUNTRIES[id].liveKind === 'elexon') {
        const [mix, price] = await Promise.all([fetchMixNow().catch(() => null), gbPrice()])
        row = mix ? { ...rowFromLive(id, gbLive(mix)), ...price } : emptyRow(id)
      } else {
        const live = await loadEntsoeSnapshot(id)
        row = live ? rowFromLive(id, live) : emptyRow(id)
      }
    } catch {
      row = emptyRow(id)
    }
    out.push(row)
    done++
    onUpdate([...out], done, ids.length)
  })
  return out
}

export type CompareSortKey = 'name' | 'total' | 'renew' | 'carbon' | 'price' | 'net' | 'age'

/**
 * Sort rows for the table. Missing values sink to the bottom regardless of
 * direction — "no data" is never the winner of any ranking.
 */
export function sortRows(rows: CompareRow[], key: CompareSortKey, dir: 1 | -1): CompareRow[] {
  const val = (r: CompareRow): number | string | null => {
    switch (key) {
      case 'name':
        return r.name
      case 'total':
        return r.state === 'ok' ? r.totalMW : null
      case 'renew':
        return r.renewShare
      case 'carbon':
        return r.carbonEst
      case 'price':
        return r.price
      case 'net':
        return r.netMW
      case 'age':
        return r.ageH
    }
  }
  return [...rows].sort((a, b) => {
    const va = val(a)
    const vb = val(b)
    if (va == null && vb == null) return a.name.localeCompare(b.name)
    if (va == null) return 1
    if (vb == null) return -1
    if (typeof va === 'string' && typeof vb === 'string') return dir * va.localeCompare(vb)
    return dir * ((va as number) - (vb as number))
  })
}
