/** Per-country configuration: bounds, voltage tiers, live-data support. */

export type CountryId =
  | 'gb'
  | 'nl'
  | 'be'
  | 'ie'
  | 'dk'
  | 'fr'
  | 'de'
  | 'ch'
  | 'at'
  | 'cz'
  | 'si'
  | 'hu'
  | 'sk'
  | 'hr'
  | 'bg'
  | 'gr'
  | 'ro'
  | 'ba'
  | 'rs'
  | 'mk'
  | 'no'
  | 'se'
  | 'pl'
  | 'es'
  | 'pt'
  | 'it'
  | 'fi'
  | 'ee'
  | 'lv'
  | 'lt'
  | 'us'
  | 'ca'
  | 'all'

/** Countries with their own data bundles ('all' merges these at runtime). */
export const REAL_COUNTRY_IDS = [
  'gb',
  'nl',
  'be',
  'ie',
  'dk',
  'fr',
  'de',
  'ch',
  'at',
  'cz',
  'si',
  'hu',
  'sk',
  'hr',
  'bg',
  'gr',
  'ro',
  'ba',
  'rs',
  'mk',
  'no',
  'se',
  'pl',
  'es',
  'pt',
  'it',
  'fi',
  'ee',
  'lv',
  'lt',
  'us',
  'ca',
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
      [-139.5, 24.0],
      [31.5, 71.0],
    ],
    tiers: [
      { kvs: [765, 735, 500, 420, 400, 380], label: 'Backbone (≥380 kV)' },
      { kvs: [345, 330, 315, 300, 275, 230, 225, 220], label: '220–345 kV' },
      { kvs: [150, 132, 130, 110], label: '110–150 kV' },
    ],
    hasLive: false,
    liveKind: 'none',
    liveNote:
      'Thirty-two grids, one map. Switch to a single country for its details and its live output layer.',
    tagline: 'Thirty-two grids · two continents · every HVDC link',
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
  ch: {
    id: 'ch',
    region: 'eu',
    name: 'Switzerland',
    flag: '🇨🇭',
    bounds: [
      [5.9, 45.7],
      [10.6, 47.9],
    ],
    tiers: [
      { kvs: [380], label: '380 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. Cantonal 110 kV and the SBB 16.7 Hz railway grid are omitted.',
    tagline: 'Jedes Kraftwerk · das Swissgrid-Netz · alpine Speicherkraft',
  },
  at: {
    id: 'at',
    region: 'eu',
    name: 'Austria',
    flag: '🇦🇹',
    bounds: [
      [9.5, 46.3],
      [17.2, 49.1],
    ],
    tiers: [
      { kvs: [380], label: '380 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. Regional 110 kV and the ÖBB 16.7 Hz railway grid are omitted.',
    tagline: 'Jedes Kraftwerk · das APG-Netz · Alpenwasserkraft',
  },
  cz: {
    id: 'cz',
    region: 'eu',
    name: 'Czechia',
    flag: '🇨🇿',
    bounds: [
      [12.0, 48.5],
      [18.9, 51.1],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day from ENTSO-E, refreshed by a scheduled workflow. ČEPS publishes per-unit output for only a few fossil units — the mix is complete but station dots are sparse. The 110 kV distribution network is omitted.',
    tagline: 'Každá elektrárna · přenosová soustava ČEPS · jádro i uhlí',
  },
  si: {
    id: 'si',
    region: 'eu',
    name: 'Slovenia',
    flag: '🇸🇮',
    bounds: [
      [13.3, 45.4],
      [16.7, 46.95],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [110], label: '110 kV lines' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. ELES files per-unit output for only the four largest units — Krško, Šoštanj, Brestanica and Avče carry live dots; the hydro chains show capacity only.',
    tagline: 'Vsaka elektrarna · prenosno omrežje ELES · od Krškega do Drave',
  },
  hu: {
    id: 'hu',
    region: 'eu',
    name: 'Hungary',
    flag: '🇭🇺',
    bounds: [
      [16.0, 45.7],
      [23.0, 48.65],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. MAVIR files per-unit output for the whole large fleet — Paks, Mátra, Dunamenti, Csepel and the Budapest CHPs all carry live dots. The 120 kV subtransmission layer and the single 750 kV line to Ukraine are omitted.',
    tagline: 'Minden erőmű · a MAVIR átviteli hálózata · Pakstól a naperőművekig',
  },
  sk: {
    id: 'sk',
    region: 'eu',
    name: 'Slovakia',
    flag: '🇸🇰',
    bounds: [
      [16.8, 47.7],
      [22.6, 49.65],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [110], label: '110 kV lines' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. SEPS files per-unit output for five stations — both nuclear plants, Čierny Váh pumped storage, Malženice and PPC Bratislava carry live dots.',
    tagline: 'Každá elektráreň · prenosová sústava SEPS · jadro z Bohuníc a Mochoviec',
  },
  hr: {
    id: 'hr',
    region: 'eu',
    name: 'Croatia',
    flag: '🇭🇷',
    bounds: [
      [13.2, 42.3],
      [19.5, 46.65],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [110], label: '110 kV lines' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Daily mix, demand and day-ahead prices from ENTSO-E, refreshed by a scheduled workflow. HEP publishes no per-unit output at all, so station dots show capacity only — the mix strip is the live layer here.',
    tagline: 'Svaka elektrana · prijenosna mreža HOPS · vjetar s Jadrana',
  },
  bg: {
    id: 'bg',
    region: 'eu',
    name: 'Bulgaria',
    flag: '🇧🇬',
    bounds: [
      [22.3, 41.2],
      [28.7, 44.25],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [110], label: '110 kV lines' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. ESO files per-unit output for Kozloduy and the coal fleet — those dots are live; Varna and the Chaira pumped storage publish no unit data.',
    tagline: 'Всяка централа · преносната мрежа на ЕСО · Козлодуй и Марица',
  },
  gr: {
    id: 'gr',
    region: 'eu',
    name: 'Greece',
    flag: '🇬🇷',
    bounds: [
      [19.2, 34.7],
      [28.3, 41.9],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [150], label: '150 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. IPTO files per-unit output for the whole thermal and big-hydro fleet. Non-interconnected island systems show stations without live output; their 66 kV grids are below the tier model.',
    tagline: 'Κάθε σταθμός · το δίκτυο του ΑΔΜΗΕ · ήλιος και άνεμος',
  },
  ro: {
    id: 'ro',
    region: 'eu',
    name: 'Romania',
    flag: '🇷🇴',
    bounds: [
      [20.2, 43.6],
      [29.8, 48.3],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [110], label: '110 kV lines' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. Transelectrica files per-unit output for the big fleet — Cernavodă, the Iron Gates and the thermal plants carry live dots.',
    tagline: 'Fiecare centrală · rețeaua Transelectrica · de la Porțile de Fier la Cernavodă',
  },
  ba: {
    id: 'ba',
    region: 'eu',
    name: 'Bosnia and Herzegovina',
    flag: '🇧🇦',
    bounds: [
      [15.7, 42.5],
      [19.7, 45.3],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [110], label: '110 kV lines' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. NOS BiH files generation and demand but no day-ahead prices — the price line stays empty here, honestly.',
    tagline: 'Svaka elektrana · prijenosna mreža NOS BiH · voda i ugalj',
  },
  rs: {
    id: 'rs',
    region: 'eu',
    name: 'Serbia',
    flag: '🇷🇸',
    bounds: [
      [18.8, 42.2],
      [23.1, 46.2],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [110], label: '110 kV lines' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. EMS files per-unit output roughly twelve days behind the calendar, so the dotted day trails the mix strip by that lag.',
    tagline: 'Свака електрана · преносна мрежа ЕМС · Ђердап и Колубара',
  },
  mk: {
    id: 'mk',
    region: 'eu',
    name: 'North Macedonia',
    flag: '🇲🇰',
    bounds: [
      [20.4, 40.8],
      [23.05, 42.4],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [110], label: '110 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. MEPSO files per-unit output for Bitola, Negotino, the Skopje CHP and the big hydro plants.',
    tagline: 'Секоја централа · преносната мрежа на МЕПСО · јаглен и вода',
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
    hasLive: true,
    liveKind: 'entsoe',
    liveNote: 'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow.',
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
    hasLive: true,
    liveKind: 'entsoe',
    liveNote: 'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow.',
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
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. The dense 110 kV network is omitted to keep the map fast.',
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
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. Regional 132/110 kV networks are omitted; the Canaries sit outside the default frame.',
    tagline: 'Cada central · la red de transporte · enlaces HVDC',
  },
  pt: {
    id: 'pt',
    region: 'eu',
    name: 'Portugal',
    flag: '🇵🇹',
    bounds: [
      [-9.9, 36.8],
      [-6.0, 42.2],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [150], label: '150 kV lines' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. Madeira is shown; the Azores are outside the mapped frame.',
    tagline: 'Cada central · a rede de transporte · ligações HVDC',
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
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow. The vast 150 kV network is omitted to keep the map fast.',
    tagline: 'Ogni centrale · la rete di trasmissione · collegamenti HVDC',
  },
  fi: {
    id: 'fi',
    region: 'eu',
    name: 'Finland',
    flag: '🇫🇮',
    bounds: [
      [19.0, 59.6],
      [31.6, 70.1],
    ],
    tiers: [
      { kvs: [400], label: '400 kV lines' },
      { kvs: [220], label: '220 kV lines' },
      { kvs: [110], label: '110 kV lines' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote: 'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow.',
    tagline: 'Jokainen voimalaitos · kantaverkko · HVDC-yhteydet',
  },
  ee: {
    id: 'ee',
    region: 'eu',
    name: 'Estonia',
    flag: '🇪🇪',
    bounds: [
      [21.7, 57.5],
      [28.3, 59.8],
    ],
    tiers: [
      { kvs: [330], label: '330 kV lines' },
      { kvs: [110], label: '110 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote: 'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow.',
    tagline: 'Iga elektrijaam · põhivõrk · Estlink',
  },
  lv: {
    id: 'lv',
    region: 'eu',
    name: 'Latvia',
    flag: '🇱🇻',
    bounds: [
      [20.9, 55.6],
      [28.3, 58.1],
    ],
    tiers: [
      { kvs: [330], label: '330 kV lines' },
      { kvs: [110], label: '110 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote: 'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow.',
    tagline: 'Katra elektrostacija · pārvades tīkls · Daugavas kaskāde',
  },
  lt: {
    id: 'lt',
    region: 'eu',
    name: 'Lithuania',
    flag: '🇱🇹',
    bounds: [
      [20.9, 53.9],
      [26.9, 56.5],
    ],
    tiers: [
      { kvs: [330], label: '330 kV lines' },
      { kvs: [110], label: '110 kV lines' },
      { kvs: [], label: '' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote: 'Latest metered day per station from ENTSO-E, refreshed by a scheduled workflow.',
    tagline: 'Kiekviena elektrinė · perdavimo tinklas · NordBalt',
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
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      "Fuel mix from ERCOT and NYISO's public feeds (Texas + New York, ≈ a third of US generation), hourly, refreshed by the workflow. No US ISO publishes per-plant output openly. Alaska, Hawaii and Puerto Rico are omitted in v1.",
    tagline: 'Every utility-scale plant · the bulk grid · Texas & New York live',
  },
  ca: {
    id: 'ca',
    region: 'na',
    name: 'Canada',
    flag: '🇨🇦',
    bounds: [
      [-139.5, 41.7],
      [-52.0, 62.7],
    ],
    tiers: [
      { kvs: [735, 500], label: '735 / 500 kV lines' },
      { kvs: [315], label: '315 kV lines' },
      { kvs: [230], label: '230–240 kV lines' },
    ],
    hasLive: true,
    liveKind: 'entsoe',
    liveNote:
      "Ontario: per-station hourly output from IESO's public Generator Output report, refreshed by the workflow. Alberta and Québec don't publish per-plant data — on the roadmap. Remote northern microgrids are omitted.",
    tagline: 'Every major generator · provincial backbones · Ontario live via IESO',
  },
}

export const DEFAULT_COUNTRY: CountryId = 'all'

/**
 * Hash grammar (#22): `#cc` or `#cc/station/<osm-id>` — station ids contain
 * a slash themselves (`way/653307622`), so everything after `station/` is
 * the id. Pure so it's testable without a DOM.
 */
export function parseHash(raw: string): { country: CountryId; station: string | null } {
  const parts = raw.replace(/^#/, '').split('/')
  const cc = (parts[0] ?? '').toLowerCase()
  const country = Object.hasOwn(COUNTRIES, cc) ? (cc as CountryId) : DEFAULT_COUNTRY
  const rest = parts[1] === 'station' ? parts.slice(2).join('/') : ''
  const station = rest && Object.hasOwn(COUNTRIES, cc) ? rest : null
  return { country, station }
}

export function countryFromHash(): CountryId {
  return parseHash(window.location.hash).country
}

/** Station deep link in the current hash, if any (#22). */
export function stationFromHash(): string | null {
  return parseHash(window.location.hash).station
}

/** The shareable hash for a view — '' for the plain default view. */
export function hashFor(country: CountryId, station: string | null): string {
  if (station) return `#${country}/station/${station}`
  return country === DEFAULT_COUNTRY ? '' : `#${country}`
}
