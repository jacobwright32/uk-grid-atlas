/**
 * Pure aggregation for Elexon live data — plain ESM so both the browser
 * bundle (src/lib/live.ts) and the node snapshot script share one
 * implementation. Types in live-core.d.mts.
 */

/** B1610 quantity is MWh per half-hour → average MW is ×2. */
export const MWH_HH_TO_MW = 2

/**
 * Aggregate B1610 rows into per-station day series.
 * @param rows    [{bmUnit, settlementPeriod, quantity}] (MWh per half-hour)
 * @param byUnit  {bmUnit → stationId}
 * @returns Map<stationId, {series, avgMW, peakMW, energyGWh, periods}>
 *          series = 48 MW values (null where no data for any unit)
 */
export function aggregateDay(rows, byUnit) {
  /** stationId → Float64Array(48) sums + presence flags */
  const sums = new Map()
  for (const row of rows) {
    const stationId = byUnit[row.bmUnit]
    if (!stationId) continue
    const p = row.settlementPeriod
    if (!Number.isInteger(p) || p < 1 || p > 50) continue
    let s = sums.get(stationId)
    if (!s) {
      s = { mwh: new Array(50).fill(0), has: new Array(50).fill(false) }
      sums.set(stationId, s)
    }
    s.mwh[p - 1] += row.quantity
    s.has[p - 1] = true
  }

  const out = new Map()
  for (const [stationId, s] of sums) {
    const series = []
    let energyMWh = 0
    let peakMW = 0
    let count = 0
    for (let i = 0; i < 48; i++) {
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
 * Parse a whole day of /generation/outturn/summary snapshots into 48
 * half-hourly series (#17 mix-strip scrub). Buckets by Europe/London clock
 * to line up with B1610 settlement periods; the last reading inside each
 * half-hour wins. Interconnector fuel types fold into one imports series.
 * @returns {{fuels: Record<string,(number|null)[]>, imports: (number|null)[]} | null}
 */
export function parseOutturnDay(payload) {
  if (!Array.isArray(payload) || !payload.length) return null
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const fuels = {}
  const imports = new Array(48).fill(null)
  const interconnectors = {}
  for (const snap of payload) {
    const t = new Date(snap?.startTime ?? NaN)
    if (Number.isNaN(t.getTime())) continue
    const parts = Object.fromEntries(fmt.formatToParts(t).map((p) => [p.type, p.value]))
    const idx = (parseInt(parts.hour, 10) % 24) * 2 + (parseInt(parts.minute, 10) >= 30 ? 1 : 0)
    if (idx < 0 || idx > 47) continue
    let imp = null
    for (const r of snap.data ?? []) {
      if (!Number.isFinite(r?.generation)) continue
      const ic = INT_TO_IC[r.fuelType]
      if (ic) {
        imp = (imp ?? 0) + r.generation
        if (!interconnectors[ic]) interconnectors[ic] = new Array(48).fill(null)
        interconnectors[ic][idx] = r.generation
        continue
      }
      if (!MIX_FUELS.some(([key]) => key === r.fuelType)) continue
      if (!fuels[r.fuelType]) fuels[r.fuelType] = new Array(48).fill(null)
      fuels[r.fuelType][idx] = Math.max(0, r.generation)
    }
    if (imp != null) imports[idx] = Math.max(0, imp)
  }
  return Object.keys(fuels).length ? { fuels, imports, interconnectors } : null
}

/** Current GB settlement date + period (Europe/London local clock). */
export function currentSettlement(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]))
  const hour = parseInt(parts.hour, 10) % 24
  const minute = parseInt(parts.minute, 10)
  return {
    settlementDate: `${parts.year}-${parts.month}-${parts.day}`,
    settlementPeriod: hour * 2 + (minute >= 30 ? 2 : 1),
  }
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
