/**
 * Pure aggregation for Elexon live data — plain ESM so both the browser
 * bundle (src/lib/live.ts) and the node snapshot script share one
 * implementation. Types in live-core.d.mts.
 */

/** B1610 quantity is MWh per half-hour → average MW is ×2. */
export const MWH_HH_TO_MW = 2

/** One GB settlement period. */
const HALF_HOUR_MS = 1_800_000

/** Single formatter for every Europe/London instant → calendar-parts read. */
const LONDON_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const londonParts = (utcMs) =>
  Object.fromEntries(LONDON_PARTS.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]))

/** Minutes that Europe/London is ahead of UTC at a given instant. */
const londonOffsetMinutes = (utcMs) => {
  const p = londonParts(utcMs)
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
  return (asUTC - utcMs) / 60000
}

/** Europe/London calendar date ("YYYY-MM-DD") at a given instant. */
export function londonDate(utcMs) {
  const p = londonParts(utcMs)
  return `${p.year}-${p.month}-${p.day}`
}

/**
 * UTC instant of the Europe/London midnight that opens settlement day `date`
 * ("YYYY-MM-DD"). Guess UTC midnight, step back by the offset there, then
 * re-derive the offset at that candidate — two passes converge even when the
 * guess lands on the far side of a DST transition (#5).
 */
export function londonDayStartMs(date) {
  const [y, m, d] = String(date).split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  if (!Number.isFinite(guess)) throw new Error(`bad settlement date: ${date}`)
  const candidate = guess - londonOffsetMinutes(guess) * 60_000
  return guess - londonOffsetMinutes(candidate) * 60_000
}

/** ISO date one day after `isoDate`. */
const nextIsoDate = (isoDate) => daysBefore(isoDate, -1)

/**
 * Settlement periods in a GB day, measured between London midnights: 48
 * normally, 50 on the October clocks-back day, 46 on the March clocks-forward
 * day. Never guessed from wall-clock arithmetic (#5).
 */
export function periodsInDay(date) {
  const start = londonDayStartMs(date)
  const n = (londonDayStartMs(nextIsoDate(date)) - start) / HALF_HOUR_MS
  if (n !== 46 && n !== 48 && n !== 50) {
    throw new Error(`unexpected settlement-period count ${n} for ${date}`)
  }
  return n
}

/** 1-based settlement period of `utcMs` within settlement day `date`. */
export function settlementPeriodAt(date, utcMs) {
  return Math.floor((utcMs - londonDayStartMs(date)) / HALF_HOUR_MS) + 1
}

/**
 * Slots a day series should expose: exact when the settlement date is known,
 * otherwise 48 widened to whatever the rows actually reached, so a caller
 * without a date still never loses SP 49/50 on a clocks-back day (#5).
 */
const slotCount = (date, maxPeriodSeen) =>
  date ? periodsInDay(date) : Math.min(50, Math.max(48, maxPeriodSeen))

/**
 * Aggregate B1610 rows into per-station day series.
 * @param rows    [{bmUnit, settlementPeriod, quantity}] (MWh per half-hour)
 * @param byUnit  {bmUnit → stationId}
 * @param date    settlement date ("YYYY-MM-DD") — sizes the series exactly on
 *                clock-change days; optional for callers that lack it (#5)
 * @returns Map<stationId, {series, avgMW, peakMW, energyGWh, periods}>
 *          series = 46 | 48 | 50 MW values (null where no data for any unit)
 */
export function aggregateDay(rows, byUnit, date) {
  const cap = date ? periodsInDay(date) : 50
  /** stationId → per-period MWh sums + presence flags */
  const sums = new Map()
  let maxSeen = 0
  for (const row of rows) {
    const stationId = byUnit[row.bmUnit]
    if (!stationId) continue
    const p = row.settlementPeriod
    if (!Number.isInteger(p) || p < 1 || p > cap) continue
    let s = sums.get(stationId)
    if (!s) {
      s = { mwh: new Array(cap).fill(0), has: new Array(cap).fill(false) }
      sums.set(stationId, s)
    }
    s.mwh[p - 1] += row.quantity
    s.has[p - 1] = true
    if (p > maxSeen) maxSeen = p
  }

  const len = slotCount(date, maxSeen)
  const out = new Map()
  for (const [stationId, s] of sums) {
    const series = []
    let energyMWh = 0
    let peakMW = 0
    let count = 0
    for (let i = 0; i < len; i++) {
      if (!s.has[i]) {
        series.push(null)
        continue
      }
      const mw = Math.max(0, s.mwh[i] * MWH_HH_TO_MW)
      series.push(Math.round(mw * 10) / 10)
      energyMWh += Math.max(0, s.mwh[i])
      if (mw > peakMW) peakMW = mw
      count++
    }
    if (!count) continue
    out.set(stationId, {
      series,
      periods: count,
      avgMW: Math.round(((energyMWh * MWH_HH_TO_MW) / count) * 10) / 10,
      peakMW: Math.round(peakMW * 10) / 10,
      energyGWh: Math.round(energyMWh / 100) / 10,
    })
  }
  return out
}

/**
 * Aggregate PN (physical notification) segments for ONE settlement period
 * into per-station scheduled MW: time-weighted mean of each unit's level,
 * summed per station. Negative levels (pumping/charging) are kept.
 * @param rows [{bmUnit, timeFrom, timeTo, levelFrom, levelTo}]
 */
export function aggregatePN(rows, byUnit) {
  const perUnit = new Map()
  for (const row of rows) {
    const stationId = byUnit[row.bmUnit]
    if (!stationId) continue
    const ms = Date.parse(row.timeTo) - Date.parse(row.timeFrom)
    if (!(ms > 0)) continue
    const meanLevel = (row.levelFrom + row.levelTo) / 2
    let u = perUnit.get(row.bmUnit)
    if (!u) {
      u = { stationId, weighted: 0, ms: 0 }
      perUnit.set(row.bmUnit, u)
    }
    u.weighted += meanLevel * ms
    u.ms += ms
  }
  const out = new Map()
  for (const u of perUnit.values()) {
    const mw = u.ms ? u.weighted / u.ms : 0
    out.set(u.stationId, Math.round(((out.get(u.stationId) ?? 0) + mw) * 10) / 10)
  }
  return out
}

/** Outturn fuelType → interconnector feature id on the map. */
export const INT_TO_IC = {
  INTFR: 'ifa',
  INTIFA2: 'ifa2',
  INTELEC: 'eleclink',
  INTNED: 'britned',
  INTNEM: 'nemo',
  INTNSL: 'nsl',
  INTVKL: 'viking',
  INTIRL: 'moyle',
  INTEW: 'ewic',
  INTGRNL: 'greenlink',
}

/** Human labels + display order for the mix strip. */
export const MIX_FUELS = [
  ['WIND', 'Wind'],
  ['CCGT', 'Gas'],
  ['NUCLEAR', 'Nuclear'],
  ['BIOMASS', 'Biomass'],
  ['NPSHYD', 'Hydro'],
  ['PS', 'Pumped'],
  ['OCGT', 'Gas (OCGT)'],
  ['OIL', 'Oil'],
  ['COAL', 'Coal'],
  ['OTHER', 'Other'],
]

/**
 * Parse /generation/outturn/summary response → latest instant.
 * @returns {{time, fuels: [{key,label,mw}], interconnectors: {icId: mw}, totalMW, importMW}}
 */
export function parseOutturn(payload) {
  if (!Array.isArray(payload) || !payload.length) return null
  const latest = payload[payload.length - 1]
  const rows = latest?.data ?? []
  const fuels = []
  const interconnectors = {}
  let totalMW = 0
  let importMW = 0
  const byKey = new Map(rows.map((r) => [r.fuelType, r.generation]))
  for (const [key, label] of MIX_FUELS) {
    const mw = byKey.get(key)
    if (mw == null || mw <= 0) continue
    fuels.push({ key, label, mw })
    totalMW += mw
  }
  for (const r of rows) {
    const ic = INT_TO_IC[r.fuelType]
    if (ic) {
      interconnectors[ic] = r.generation
      importMW += r.generation
    }
  }
  return { time: latest.startTime, fuels, interconnectors, totalMW, importMW }
}

/**
 * Parse a whole day of /generation/outturn/summary snapshots into half-hourly
 * series (#17 mix-strip scrub). Readings are placed by the settlement period
 * of their UTC instant, so the clocks-back day's two local 01:00-02:00 hours
 * land in distinct slots instead of colliding, and the clocks-forward day has
 * no null hole where the skipped hour would be (#5). The last reading inside
 * each half-hour wins; interconnector fuel types fold into one imports series.
 * @param payload outturn snapshots covering one settlement day
 * @param date    settlement date ("YYYY-MM-DD"); taken from the first readable
 *                snapshot's London calendar date when omitted
 * @returns {{fuels: Record<string,(number|null)[]>, imports: (number|null)[]} | null}
 */
export function parseOutturnDay(payload, date) {
  if (!Array.isArray(payload) || !payload.length) return null
  const times = payload.map((snap) => Date.parse(snap?.startTime ?? ''))
  const firstMs = times.find((ms) => !Number.isNaN(ms))
  if (firstMs === undefined) return null
  const day = date ?? londonDate(firstMs)
  const n = periodsInDay(day)
  const dayStart = londonDayStartMs(day)
  const fuels = {}
  const imports = new Array(n).fill(null)
  const interconnectors = {}
  for (let s = 0; s < payload.length; s++) {
    const ms = times[s]
    if (Number.isNaN(ms)) continue
    const idx = Math.floor((ms - dayStart) / HALF_HOUR_MS)
    if (idx < 0 || idx >= n) continue
    let imp = null
    for (const r of payload[s]?.data ?? []) {
      if (!Number.isFinite(r?.generation)) continue
      const ic = INT_TO_IC[r.fuelType]
      if (ic) {
        imp = (imp ?? 0) + r.generation
        if (!interconnectors[ic]) interconnectors[ic] = new Array(n).fill(null)
        interconnectors[ic][idx] = r.generation
        continue
      }
      if (!MIX_FUELS.some(([key]) => key === r.fuelType)) continue
      if (!fuels[r.fuelType]) fuels[r.fuelType] = new Array(n).fill(null)
      fuels[r.fuelType][idx] = Math.max(0, r.generation)
    }
    if (imp != null) imports[idx] = Math.max(0, imp)
  }
  return Object.keys(fuels).length ? { fuels, imports, interconnectors } : null
}

/**
 * Aggregate MID (market index) rows into a half-hourly price series,
 * volume-weighting across data providers (APX + N2EX) per period. £/MWh.
 * @param rows [{settlementPeriod, price, volume}]
 * @param date settlement date ("YYYY-MM-DD") — sizes the series exactly on
 *             clock-change days, keeping SP 49/50 of the long day (#5)
 * @returns {{currency: 'GBP', series: (number|null)[], zones: 1} | null}
 */
export function aggregateMID(rows, date) {
  if (!Array.isArray(rows) || !rows.length) return null
  const cap = date ? periodsInDay(date) : 50
  const weighted = new Array(cap).fill(0)
  const volumes = new Array(cap).fill(0)
  let maxSeen = 0
  for (const r of rows) {
    const p = r?.settlementPeriod
    if (!Number.isInteger(p) || p < 1 || p > cap) continue
    if (!Number.isFinite(r.price) || !Number.isFinite(r.volume) || r.volume <= 0) continue
    weighted[p - 1] += r.price * r.volume
    volumes[p - 1] += r.volume
    if (p > maxSeen) maxSeen = p
  }
  if (!maxSeen) return null
  const len = slotCount(date, maxSeen)
  const series = []
  for (let i = 0; i < len; i++) {
    series.push(volumes[i] > 0 ? Math.round((weighted[i] / volumes[i]) * 100) / 100 : null)
  }
  return { currency: 'GBP', series, zones: 1 }
}

/**
 * Current GB settlement date + period. The date is Europe/London's calendar
 * date; the period counts half-hours from that day's local midnight, so both
 * clock-change days are right — an `hour * 2` formula can only reach 48 and is
 * off by ±2 for most of either day (#5).
 */
export function currentSettlement(now = new Date()) {
  const utcMs = now.getTime()
  const settlementDate = londonDate(utcMs)
  return { settlementDate, settlementPeriod: settlementPeriodAt(settlementDate, utcMs) }
}

/** ISO date string n days before an ISO date (UTC arithmetic). */
export function daysBefore(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** Chunk an array. */
export function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
