/**
 * ENTSO-E Transparency Platform client + parsers (node-only).
 *
 * Auth: free account at https://transparency.entsoe.eu → My Account
 * Settings → generate a "Web API Security Token". Export it as ENTSOE_TOKEN.
 *
 * Documents used:
 *   A71/A33 installed capacity per unit  → unit registry (name, EIC, MW, type)
 *   A73/A16 actual generation per unit   → per-station day series
 *   A75/A16 actual generation per type   → country mix
 *   A11     cross-border physical flows  → interconnector flows
 */
import { XMLParser } from 'fast-xml-parser'

const BASE = 'https://web-api.tp.entsoe.eu/api'

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false })

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x])

export class EntsoeClient {
  constructor(token) {
    if (!token) throw new Error('ENTSOE_TOKEN missing')
    this.token = token
  }

  async get(params) {
    const qs = new URLSearchParams({ securityToken: this.token, ...params })
    const res = await fetch(`${BASE}?${qs}`, {
      headers: { 'User-Agent': 'grid-atlas/1.0 (open-data dashboard)' },
      signal: AbortSignal.timeout(90_000),
    })
    const text = await res.text()
    if (!res.ok) {
      // 400 with an Acknowledgement document = "no data" for many queries
      if (text.includes('Acknowledgement_MarketDocument')) return null
      throw new Error(`ENTSO-E ${res.status}: ${text.slice(0, 160)}`)
    }
    if (text.includes('Acknowledgement_MarketDocument')) return null
    return parser.parse(text)
  }
}

/** Control/bidding-zone registry per Grid Atlas country. */
export const ENTSOE_COUNTRIES = {
  nl: { unitDomains: ['10YNL----------L'], mixDomains: ['10YNL----------L'] },
  be: { unitDomains: ['10YBE----------2'], mixDomains: ['10YBE----------2'] },
  ie: {
    // All-island: EirGrid + SONI control areas, SEM bidding zone.
    unitDomains: ['10YIE-1001A00010', '10Y1001A1001A016'],
    mixDomains: ['10Y1001A1001A59C'],
  },
  dk: {
    unitDomains: ['10Y1001A1001A796'],
    mixDomains: ['10YDK-1--------W', '10YDK-2--------M'],
  },
  fr: { unitDomains: ['10YFR-RTE------C'], mixDomains: ['10YFR-RTE------C'] },
  de: {
    unitDomains: ['10YDE-RWENET---I', '10YDE-EON------1', '10YDE-VE-------2', '10YDE-ENBW-----N'],
    mixDomains: ['10Y1001A1001A82H'],
  },
  ch: { unitDomains: ['10YCH-SWISSGRIDZ'], mixDomains: ['10YCH-SWISSGRIDZ'] },
  at: { unitDomains: ['10YAT-APG------L'], mixDomains: ['10YAT-APG------L'] },
  cz: { unitDomains: ['10YCZ-CEPS-----N'], mixDomains: ['10YCZ-CEPS-----N'] },
  no: {
    // Five bidding zones; per-unit and mix data both publish per zone.
    unitDomains: [
      '10YNO-1--------2',
      '10YNO-2--------T',
      '10YNO-3--------J',
      '10YNO-4--------9',
      '10Y1001A1001A48H',
    ],
    mixDomains: [
      '10YNO-1--------2',
      '10YNO-2--------T',
      '10YNO-3--------J',
      '10YNO-4--------9',
      '10Y1001A1001A48H',
    ],
  },
  se: {
    unitDomains: ['10Y1001A1001A44P', '10Y1001A1001A45N', '10Y1001A1001A46L', '10Y1001A1001A47J'],
    mixDomains: ['10Y1001A1001A44P', '10Y1001A1001A45N', '10Y1001A1001A46L', '10Y1001A1001A47J'],
  },
  pl: { unitDomains: ['10YPL-AREA-----S'], mixDomains: ['10YPL-AREA-----S'] },
  pt: { unitDomains: ['10YPT-REN------W'], mixDomains: ['10YPT-REN------W'] },
  fi: { unitDomains: ['10YFI-1--------U'], mixDomains: ['10YFI-1--------U'] },
  ee: { unitDomains: ['10Y1001A1001A39I'], mixDomains: ['10Y1001A1001A39I'] },
  lv: { unitDomains: ['10YLV-1001A00074'], mixDomains: ['10YLV-1001A00074'] },
  lt: { unitDomains: ['10YLT-1001A0008Q'], mixDomains: ['10YLT-1001A0008Q'] },
  es: { unitDomains: ['10YES-REE------0'], mixDomains: ['10YES-REE------0'] },
  it: {
    // Terna publishes per-unit data per bidding zone; the CTA domain carries
    // the mix. Day-ahead prices (A44) exist per bidding zone only.
    priceDomains: [
      '10Y1001A1001A73I',
      '10Y1001A1001A70O',
      '10Y1001A1001A71M',
      '10Y1001A1001A788',
      '10Y1001A1001A75E',
      '10Y1001A1001A74G',
      '10Y1001C--00096J',
    ],
    unitDomains: [
      '10Y1001A1001A73I',
      '10Y1001A1001A70O',
      '10Y1001A1001A71M',
      '10Y1001A1001A788',
      '10Y1001A1001A75E',
      '10Y1001A1001A74G',
      '10Y1001C--00096J',
    ],
    mixDomains: ['10YIT-GRTN-----B'],
  },
}

/**
 * Borders whose physical flow is carried entirely by mapped HVDC links, so
 * the A11 border total can be attributed (capacity-proportional when a
 * border carries several links).
 */
export const FLOW_BORDERS = [
  {
    pair: ['10YFR-RTE------C', '10YGB----------A'],
    links: ['ifa', 'ifa2', 'eleclink'],
    countries: ['fr'],
  },
  { pair: ['10YNL----------L', '10YGB----------A'], links: ['britned'], countries: ['nl'] },
  { pair: ['10YBE----------2', '10YGB----------A'], links: ['nemo'], countries: ['be'] },
  {
    pair: ['10Y1001A1001A59C', '10YGB----------A'],
    links: ['moyle', 'ewic', 'greenlink'],
    countries: ['ie'],
  },
  { pair: ['10YDK-1--------W', '10YGB----------A'], links: ['viking'], countries: ['dk'] },
  { pair: ['10YNL----------L', '10YNO-2--------T'], links: ['norned'], countries: ['nl', 'no'] },
  { pair: ['10YNL----------L', '10YDK-1--------W'], links: ['cobra'], countries: ['nl', 'dk'] },
  { pair: ['10YBE----------2', '10Y1001A1001A82H'], links: ['alegro'], countries: ['be', 'de'] },
  { pair: ['10YDK-1--------W', '10YNO-2--------T'], links: ['skagerrak'], countries: ['dk', 'no'] },
  {
    pair: ['10YDK-1--------W', '10Y1001A1001A46L'],
    links: ['konti-skan'],
    countries: ['dk', 'se'],
  },
  { pair: ['10YDK-2--------M', '10Y1001A1001A82H'], links: ['kontek'], countries: ['dk', 'de'] },
  {
    pair: ['10Y1001A1001A82H', '10Y1001A1001A47J'],
    links: ['baltic-cable'],
    countries: ['de', 'se'],
  },
  { pair: ['10Y1001A1001A82H', '10YNO-2--------T'], links: ['nordlink'], countries: ['de', 'no'] },
  { pair: ['10YGB----------A', '10YNO-2--------T'], links: ['nsl'], countries: ['no'] },
  { pair: ['10Y1001A1001A47J', '10YPL-AREA-----S'], links: ['swepol'], countries: ['se', 'pl'] },
  {
    pair: ['10Y1001A1001A46L', '10YFI-1--------U'],
    links: ['fenno-skan'],
    countries: ['se', 'fi'],
  },
  {
    pair: ['10YFI-1--------U', '10Y1001A1001A39I'],
    links: ['estlink'],
    countries: ['fi', 'ee'],
  },
  { pair: ['10Y1001A1001A47J', '10YLT-1001A0008Q'], links: ['nordbalt'], countries: ['se', 'lt'] },
  {
    pair: ['10YFR-RTE------C', '10YES-REE------0'],
    links: ['inelfe'],
    countries: ['es', 'fr'],
  },
  {
    pair: ['10YFR-RTE------C', '10Y1001A1001A73I'],
    links: ['savoie-piemont'],
    countries: ['it', 'fr'],
  },
  { pair: ['10Y1001A1001A788', '10YGR-HTSO-----Y'], links: ['grita'], countries: ['it'] },
  { pair: ['10Y1001A1001A788', '10YCS-CG-TSO---S'], links: ['monita'], countries: ['it'] },
]

/** ENTSO-E psrType → Grid Atlas mix bucket. */
export const PSR_BUCKETS = {
  B18: ['wind', 'Wind'],
  B19: ['wind', 'Wind'],
  B16: ['solar', 'Solar'],
  B04: ['gas', 'Gas'],
  B03: ['gas', 'Gas'],
  B14: ['nuclear', 'Nuclear'],
  B02: ['coal', 'Coal & lignite'],
  B05: ['coal', 'Coal & lignite'],
  B01: ['biomass', 'Biomass & waste'],
  B17: ['biomass', 'Biomass & waste'],
  B10: ['hydro', 'Hydro & pumped'],
  B11: ['hydro', 'Hydro & pumped'],
  B12: ['hydro', 'Hydro & pumped'],
  B06: ['other', 'Oil & other'],
  B07: ['coal', 'Coal & lignite'], // fossil oil shale (Estonia's Narva fleet)
  B08: ['other', 'Oil & other'],
  B09: ['geothermal', 'Geothermal'],
  B13: ['other', 'Oil & other'],
  B15: ['hydro', 'Hydro & pumped'],
  B20: ['other', 'Oil & other'],
}

/** psrType → station fuel groups it may match (for unit→station mapping). */
export const PSR_COMPAT = {
  B14: ['nuclear'],
  B09: ['geothermal', 'other'],
  B04: ['gas'],
  B03: ['gas'],
  B02: ['coal'],
  B05: ['coal'],
  B01: ['bioenergy', 'waste', 'coal', 'gas'],
  B17: ['waste', 'bioenergy'],
  B06: ['oil', 'gas'],
  B07: ['coal', 'other'],
  B10: ['pumped', 'hydro'],
  B11: ['hydro', 'pumped'],
  B12: ['hydro', 'pumped'],
  B15: ['hydro'],
  B16: ['solar'],
  B18: ['wind_offshore', 'wind_onshore'],
  B19: ['wind_onshore', 'wind_offshore'],
  B20: ['storage', 'gas', 'oil', 'other', 'bioenergy', 'waste', 'marine', 'hydro', 'solar'],
}

const YMDHM = (d) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
    d.getUTCDate(),
  ).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(
    d.getUTCMinutes(),
  ).padStart(2, '0')}`

/** UTC window covering one calendar day. */
export function dayWindow(isoDate) {
  const start = new Date(`${isoDate}T00:00:00Z`)
  const end = new Date(start.getTime() + 24 * 3600 * 1000)
  return { periodStart: YMDHM(start), periodEnd: YMDHM(end) }
}

function resolutionMinutes(res) {
  if (res === 'PT15M') return 15
  if (res === 'PT30M') return 30
  if (res === 'PT60M' || res === 'P1D') return 60
  return 60
}

/**
 * Parse an A44 day-ahead price document (Publication_MarketDocument whose
 * points carry `price.amount` rather than `quantity`) into hourly series.
 * Returns [{currency, stepMin, points: [{position, price}]}] per TimeSeries.
 */
export function parsePriceSeries(doc) {
  const root = doc?.Publication_MarketDocument
  if (!root) return []
  const out = []
  for (const ts of asArray(root.TimeSeries)) {
    const currency = ts['currency_Unit.name'] ?? 'EUR'
    for (const period of asArray(ts.Period)) {
      const stepMin = resolutionMinutes(period.resolution)
      const points = asArray(period.Point).map((p) => ({
        position: parseInt(p.position, 10),
        price: parseFloat(p['price.amount']),
      }))
      out.push({ currency, stepMin, points })
    }
  }
  return out
}

/** Parse a GL_MarketDocument's TimeSeries into flat unit/type series. */
export function parseSeries(doc) {
  const root = doc?.GL_MarketDocument ?? doc?.Publication_MarketDocument
  if (!root) return []
  const out = []
  for (const ts of asArray(root.TimeSeries)) {
    const psr = ts.MktPSRType ?? {}
    const unit = psr.PowerSystemResources ?? {}
    for (const period of asArray(ts.Period)) {
      const stepMin = resolutionMinutes(period.resolution)
      const points = asArray(period.Point).map((p) => ({
        position: parseInt(p.position, 10),
        mw: parseFloat(p.quantity),
      }))
      out.push({
        psrType: psr.psrType ?? null,
        unitEic: unit.mRID?.['#text'] ?? unit.mRID ?? null,
        unitName: unit.name ?? null,
        nominalP: unit.nominalP ? parseFloat(unit.nominalP['#text'] ?? unit.nominalP) : null,
        inDomain:
          ts['inBiddingZone_Domain.mRID']?.['#text'] ?? ts['inBiddingZone_Domain.mRID'] ?? null,
        outDomain:
          ts['outBiddingZone_Domain.mRID']?.['#text'] ?? ts['outBiddingZone_Domain.mRID'] ?? null,
        stepMin,
        points,
      })
    }
  }
  return out
}

/** Sum per-unit series (already mapped to stations) into StationDay shape. */
export function stationDayFromSeries(seriesList) {
  // Normalise to hourly slots (0-23); finer resolutions are averaged.
  const sums = new Array(24).fill(0)
  const counts = new Array(24).fill(0)
  for (const s of seriesList) {
    const perHour = 60 / s.stepMin
    for (const p of s.points) {
      const hour = Math.floor(((p.position - 1) * s.stepMin) / 60)
      if (hour < 0 || hour > 23 || !Number.isFinite(p.mw)) continue
      sums[hour] += p.mw / perHour
      counts[hour] += 1 / perHour
    }
  }
  const series = []
  let energyMWh = 0
  let peakMW = 0
  let periods = 0
  for (let h = 0; h < 24; h++) {
    if (counts[h] <= 0) {
      series.push(null)
      continue
    }
    const mw = Math.max(0, sums[h])
    series.push(Math.round(mw * 10) / 10)
    energyMWh += mw
    if (mw > peakMW) peakMW = mw
    periods++
  }
  if (!periods) return null
  return {
    series,
    periods,
    avgMW: Math.round((energyMWh / periods) * 10) / 10,
    peakMW: Math.round(peakMW * 10) / 10,
    energyGWh: Math.round(energyMWh / 100) / 10,
  }
}
