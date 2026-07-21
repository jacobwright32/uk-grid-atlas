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
