/**
 * Derived carbon intensity (#21): generation-weighted average of standard
 * lifecycle emission factors over the mix buckets we already have — no new
 * feeds, works identically for GB (Elexon), the 29 ENTSO-E grids, Ontario
 * and the US.
 *
 * Factors are IPCC AR5 / UNECE-style lifecycle medians in gCO₂e/kWh. They
 * are deliberately coarse (a bucket, not a plant) — the figure is for
 * storytelling, not compliance accounting.
 */
export const CARBON_FACTORS: Record<string, number> = {
  coal: 820,
  gas: 490,
  other: 650, // oil & unclassified thermal
  biomass: 230,
  solar: 41,
  geothermal: 38,
  hydro: 24,
  nuclear: 12,
  wind: 12,
  // Client-side GB fleet buckets that don't appear in snapshots:
  pumped: 24, // hydro machines
  storage: 0, // discharging a battery emits at charge time, not here
}

/**
 * Weighted intensity of a set of mix rows ({key, nowMW}); imports and
 * unknown buckets are excluded from both numerator and denominator.
 * Returns null when nothing attributable is generating.
 */
export function intensityOf(rows: Array<{ key: string; nowMW: number }>): number | null {
  let grams = 0
  let mw = 0
  for (const r of rows) {
    const f = CARBON_FACTORS[r.key]
    if (f == null || r.key === 'imports' || !(r.nowMW > 0)) continue
    grams += r.nowMW * f
    mw += r.nowMW
  }
  return mw > 0 ? Math.round(grams / mw) : null
}

/** Intensity from a bucket → MW map (history day records). */
export function intensityOfMix(mix: Record<string, number>): number | null {
  return intensityOf(Object.entries(mix).map(([key, nowMW]) => ({ key, nowMW })))
}

/** "142 g/kWh" (CO₂e implied by the surrounding copy). */
export function fmtIntensity(v: number): string {
  return `${v} g/kWh`
}
