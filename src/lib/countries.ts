/** Per-country configuration: bounds, voltage tiers, live-data support. */

export type CountryId = 'gb' | 'nl'

export interface VoltageTier {
  /** `v` values (kV classes) in this tier, highest tier first. */
  kvs: number[]
  label: string
}

export interface CountryConfig {
  id: CountryId
  name: string
  flag: string
  bounds: [[number, number], [number, number]]
  /** Exactly three tiers: backbone, secondary, regional (may be empty). */
  tiers: [VoltageTier, VoltageTier, VoltageTier]
  /** Whether the per-station live layer exists for this country. */
  hasLive: boolean
  liveNote: string
  tagline: string
}

export const COUNTRIES: Record<CountryId, CountryConfig> = {
  gb: {
    id: 'gb',
    name: 'United Kingdom',
    flag: '🇬🇧',
    bounds: [
      [-11.5, 49.3],
      [4.5, 61.3],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [275], label: '275 kV lines' },
      { kvs: [132], label: '132 kV (Scotland)' },
    ],
    hasLive: true,
    liveNote: '',
    tagline: 'Every utility-scale generator · the high-voltage network · HVDC links',
  },
  nl: {
    id: 'nl',
    name: 'Netherlands',
    flag: '🇳🇱',
    bounds: [
      [2.8, 50.6],
      [7.4, 54.3],
    ],
    tiers: [
      { kvs: [380], label: '380 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [150, 110], label: '150 / 110 kV lines' },
    ],
    hasLive: false,
    liveNote: 'Live per-station output is UK-only for now (Elexon). A Dutch layer would use ENTSO-E data — on the roadmap.',
    tagline: 'Elke grote centrale · het hoogspanningsnet · HVDC-verbindingen',
  },
}

export const DEFAULT_COUNTRY: CountryId = 'gb'

export function countryFromHash(): CountryId {
  const h = window.location.hash.replace('#', '').toLowerCase()
  return h === 'nl' ? 'nl' : 'gb'
}
