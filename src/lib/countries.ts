/** Per-country configuration: bounds, voltage tiers, live-data support. */

export type CountryId =
  'gb' | 'nl' | 'be' | 'ie' | 'dk' | 'fr' | 'de' | 'no' | 'se' | 'pl' | 'es' | 'it' | 'us' | 'all'

/** Countries with their own data bundles ('all' merges these at runtime). */
export const REAL_COUNTRY_IDS = [
  'gb',
  'nl',
  'be',
  'ie',
  'dk',
  'fr',
  'de',
  'no',
  'se',
  'pl',
  'es',
  'it',
  'us',
] as const
export type RealCountryId = (typeof REAL_COUNTRY_IDS)[number]

export interface VoltageTier {
  /** `v` values (kV classes) in this tier, highest tier first. */
  kvs: number[]
  label: string
}

export interface CountryConfig {
  id: CountryId
  /** Basemap region this country renders on. */
  region: 'eu' | 'na'
  /** Which live-data pipeline feeds this country's live layer. */
  liveKind: 'elexon' | 'entsoe' | 'none'
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
  all: {
    id: 'all',
    region: 'eu',
    name: 'All countries',
    flag: '🌍',
    bounds: [
      [-126.0, 24.0],
      [31.5, 71.0],
    ],
    tiers: [
      { kvs: [765, 500, 420, 400, 380], label: 'Backbone (≥380 kV)' },
      { kvs: [345, 300, 275, 230, 225, 220], label: '220–345 kV' },
      { kvs: [150, 132, 130, 110], label: '110–150 kV' },
    ],
    hasLive: false,
    liveKind: 'none',
    liveNote:
      'Thirteen grids, one map. Switch to a single country for its details and its live output layer.',
    tagline: 'Thirteen grids · two continents · every HVDC link',
  },
  gb: {
    id: 'gb',
    region: 'eu',
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
    liveKind: 'elexon',
    liveNote: '',
    tagline: 'Every utility-scale generator · the high-voltage network · HVDC links',
  },
  nl: {
    id: 'nl',
    region: 'eu',
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
    hasLive: true,
    liveKind: 'entsoe',
    liveNote: 'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow.',
    tagline: 'Elke grote centrale · het hoogspanningsnet · HVDC-verbindingen',
  },
  be: {
    id: 'be',
    region: 'eu',
    name: 'Belgium',
    flag: '🇧🇪',
    bounds: [
      [2.3, 49.4],
      [6.5, 51.9],
    ],
    tiers: [
      { kvs: [380], label: '380 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [150], label: '150 kV lines' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote: 'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow.',
    tagline: 'Elke centrale · chaque centrale · le réseau THT · HVDC',
  },
  ie: {
    id: 'ie',
    region: 'eu',
    name: 'Ireland (all-island)',
    flag: '🇮🇪',
    bounds: [
      [-10.8, 51.3],
      [-5.2, 55.5],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [275, 220], label: '275 / 220 kV lines' },
      { kvs: [110], label: '110 kV lines' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote: 'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow.',
    tagline: 'The all-island grid · every generator · HVDC links',
  },
  dk: {
    id: 'dk',
    region: 'eu',
    name: 'Denmark',
    flag: '🇩🇰',
    bounds: [
      [6.9, 54.4],
      [13.3, 58.0],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [150, 132], label: '150 / 132 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote: 'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow.',
    tagline: 'Alle kraftværker · transmissionsnettet · HVDC-forbindelser',
  },
  fr: {
    id: 'fr',
    region: 'eu',
    name: 'France',
    flag: '🇫🇷',
    bounds: [
      [-5.5, 41.2],
      [9.8, 51.3],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [225], label: '225 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. The 90/63 kV regional network is omitted to keep the map fast.',
    tagline: 'Chaque centrale · le réseau THT · liaisons HVDC',
  },
  de: {
    id: 'de',
    region: 'eu',
    name: 'Germany',
    flag: '🇩🇪',
    bounds: [
      [5.5, 47.2],
      [15.3, 55.2],
    ],
    tiers: [
      { kvs: [380], label: '380 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. The vast 110 kV network is omitted to keep the map fast.',
    tagline: 'Jedes Kraftwerk · das Höchstspannungsnetz · HGÜ-Verbindungen',
  },
  no: {
    id: 'no',
    region: 'eu',
    name: 'Norway',
    flag: '🇳🇴',
    bounds: [
      [4.0, 57.7],
      [31.5, 71.4],
    ],
    tiers: [
      { kvs: [420], label: '420 kV lines' },
      { kvs: [300], label: '300 kV lines' },
      { kvs: [132], label: '132 kV lines' },
    ],
    hasLive: false,
    liveKind: 'none',
    liveNote: 'Infrastructure view for now — the ENTSO-E live layer for Norway is on the roadmap.',
    tagline: 'Hvert kraftverk · sentralnettet · HVDC-forbindelser',
  },
  se: {
    id: 'se',
    region: 'eu',
    name: 'Sweden',
    flag: '🇸🇪',
    bounds: [
      [10.5, 55.0],
      [24.4, 69.2],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [130], label: '130 kV lines' },
    ],
    hasLive: false,
    liveKind: 'none',
    liveNote: 'Infrastructure view for now — the ENTSO-E live layer for Sweden is on the roadmap.',
    tagline: 'Varje kraftverk · stamnätet · HVDC-länkar',
  },
  pl: {
    id: 'pl',
    region: 'eu',
    name: 'Poland',
    flag: '🇵🇱',
    bounds: [
      [14.0, 48.9],
      [24.2, 55.0],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: false,
    liveKind: 'none',
    liveNote:
      'Infrastructure view for now — the ENTSO-E live layer for Poland is on the roadmap. The dense 110 kV network is omitted to keep the map fast.',
    tagline: 'Każda elektrownia · sieć przesyłowa · połączenia HVDC',
  },
  es: {
    id: 'es',
    region: 'eu',
    name: 'Spain',
    flag: '🇪🇸',
    bounds: [
      [-9.9, 35.7],
      [4.6, 43.9],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: false,
    liveKind: 'none',
    liveNote:
      'Infrastructure view for now — the ENTSO-E live layer for Spain is on the roadmap. The 132/110 kV regional networks are omitted to keep the map fast; the Canaries sit outside the default frame (pan south-west).',
    tagline: 'Cada central · la red de transporte · enlaces HVDC',
  },
  it: {
    id: 'it',
    region: 'eu',
    name: 'Italy',
    flag: '🇮🇹',
    bounds: [
      [6.5, 36.4],
      [18.7, 47.2],
    ],
    tiers: [
      { kvs: [380], label: '380 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: false,
    liveKind: 'none',
    liveNote:
      'Infrastructure view for now — the ENTSO-E live layer for Italy is on the roadmap. The vast 150 kV network is omitted to keep the map fast.',
    tagline: 'Ogni centrale · la rete di trasmissione · collegamenti HVDC',
  },
  us: {
    id: 'us',
    region: 'na',
    name: 'United States (CONUS)',
    flag: '🇺🇸',
    bounds: [
      [-125.5, 24.2],
      [-66.4, 49.8],
    ],
    tiers: [
      { kvs: [765, 500], label: '765 / 500 kV lines' },
      { kvs: [345], label: '345 kV lines' },
      { kvs: [230], label: '230 kV lines' },
    ],
    hasLive: false,
    liveKind: 'none',
    liveNote:
      'Live output for the US would come from the EIA hourly API (regional, not per-plant) — on the roadmap. Alaska, Hawaii and Puerto Rico are omitted in v1.',
    tagline: 'Every utility-scale plant · the bulk transmission grid · HVDC ties',
  },
}

export const DEFAULT_COUNTRY: CountryId = 'all'

export function countryFromHash(): CountryId {
  const h = window.location.hash.replace('#', '').toLowerCase()
  return h in COUNTRIES ? (h as CountryId) : DEFAULT_COUNTRY
}
