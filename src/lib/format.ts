import { londonDayStartMs } from './live-core.mjs'

/** "1,234 MW" / "49.9 MW" / em-dash when unknown. */
export function fmtMW(mw: number | null | undefined): string {
  if (mw == null || !Number.isFinite(mw)) return '—'
  const rounded = mw >= 100 ? Math.round(mw) : Math.round(mw * 10) / 10
  return `${rounded.toLocaleString('en-GB')} MW`
}

/** Aggregate figure: GW with one decimal below 100 GW. */
export function fmtGW(mw: number): string {
  const gw = mw / 1000
  if (gw >= 100) return `${Math.round(gw).toLocaleString('en-GB')} GW`
  if (gw >= 1) return `${gw.toFixed(1)} GW`
  return `${Math.round(mw).toLocaleString('en-GB')} MW`
}

export function fmtCount(n: number): string {
  return n.toLocaleString('en-GB')
}

const CURRENCY_SIGNS: Record<string, string> = { EUR: '€', GBP: '£', PLN: 'zł', CAD: 'C$' }

/** "42 €/MWh" · unknown currencies fall back to their code. */
export function fmtPrice(v: number, currency: string): string {
  const sign = CURRENCY_SIGNS[currency]
  const n = Math.round(v)
  return sign ? `${n} ${sign}/MWh` : `${n} ${currency}/MWh`
}

const HALF_HOUR_MS = 1_800_000

/**
 * Wall-clock label for scrub slot `i` (#5). Half-hourly GB days are anchored to
 * the London midnight that opens the settlement day and formatted in
 * Europe/London, so the two clock-change days read correctly: `i * 30 min` puts
 * the 47th slot of the 50-period October day at 23:00 when it is really 22:30,
 * and shifts everything after the March gap by an hour. Hourly EU snapshots are
 * already local hours, so plain arithmetic is the right answer there.
 *
 * Shared by MixStrip and TimeSlider — they scrub the same slots, and having
 * two copies is how TimeSlider ended up still doing the naive arithmetic.
 */
export function slotLabel(i: number, stepMin: number, meteredDate: string | null): string {
  if (stepMin === 30 && meteredDate) {
    return new Date(londonDayStartMs(meteredDate) + i * HALF_HOUR_MS).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/London',
    })
  }
  const mins = i * stepMin
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

/** "combined_cycle" → "Combined cycle" ; "gas;oil" → "Gas · oil". */
export function humanise(raw: string | null | undefined): string | null {
  if (!raw) return null
  return raw
    .split(';')
    .map((part) => {
      const s = part.trim().replace(/_/g, ' ')
      return s.charAt(0).toUpperCase() + s.slice(1)
    })
    .join(' · ')
}
