/**
 * Data-source display metadata (#53). The snapshots' `basis: 'entsoe'` is a
 * SHAPE contract (baked snapshot vs GB's browser pipeline), not a statement
 * about who published the numbers — that's `sourceLabel`. This table keys
 * the user-facing copy off the label so IESO/ERCOT+NYISO stop being magic
 * strings scattered through App/Sidebar/popup.
 */

export interface SourceMeta {
  /** Legend / footnote label ("ENTSO-E", "IESO", "ERCOT + NYISO"). */
  label: string
  /** Region the feed covers when narrower than the map country. */
  regionName: string | null
  /** Sidebar coverage footnote. */
  footnote: string
  /** Whether per-station data comes from the ≥100 MW ENTSO-E registry. */
  unitThreshold: boolean
}

const ENTSOE_META: SourceMeta = {
  label: 'ENTSO-E',
  regionName: null,
  footnote:
    'Unit-level data covers plants ≥100 MW (ENTSO-E registry); smaller sites appear in the mix but not per-station.',
  unitThreshold: true,
}

export const SOURCE_META: Record<string, SourceMeta> = {
  IESO: {
    label: 'IESO',
    regionName: 'Ontario',
    footnote:
      'Per-station data covers IESO market participants (Ontario); Alberta and Québec have no public per-plant feed.',
    unitThreshold: false,
  },
  'ERCOT + NYISO': {
    label: 'ERCOT + NYISO',
    regionName: 'Texas + New York',
    footnote:
      'Fuel mix covers ERCOT (Texas) and NYISO (New York); other ISOs and per-plant data have no key-less public feed.',
    unitThreshold: false,
  },
}

/** Meta for a baked snapshot's source (ENTSO-E when unlabelled). */
export function sourceMetaFor(sourceLabel: string | null | undefined): SourceMeta {
  return (sourceLabel && SOURCE_META[sourceLabel]) || ENTSOE_META
}

/**
 * Neutral shape discriminator: true when the live data is a baked snapshot
 * (EU/CA/US), false for GB's browser-side Elexon pipeline.
 */
export function isBaked(live: { basis: string } | null | undefined): boolean {
  return live?.basis === 'entsoe'
}

/** Mix panel title: source region beats country name; GB stays GB. */
export function mixTitleFor(
  countryName: string,
  live: { basis: string; sourceLabel: string | null } | null,
): string {
  if (!isBaked(live)) return 'GB transmission mix'
  const region = sourceMetaFor(live?.sourceLabel).regionName
  return `${region ?? countryName} generation mix`
}
