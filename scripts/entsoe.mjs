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
import {
  BROAD_MIN_SCORE,
  jaccard,
  makeUnknownCodeTally,
  stemTokens,
  tokens,
} from './live-matching.mjs'

const BASE = 'https://web-api.tp.entsoe.eu/api'

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false })

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x])

/** ENTSO-E states its own ban expiry in the 429 body — honour it, don't guess. */
const BAN_UNTIL_RE = /banned until '([^']+)'/

/** A ban can outlast a short backoff, but never block a run indefinitely. */
const MAX_WAIT_MS = 15 * 60_000

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * How long to wait before retrying a throttled/failed ENTSO-E request.
 *
 * The API answers a rate-limit breach with `429` and an HTML body naming the
 * instant the ban lifts, so the only correct wait is "until then". Guessing a
 * fixed backoff either gives up while still banned or sleeps far too long.
 * Falls back to Retry-After, then to exponential backoff for a bare 429 or a
 * transient 5xx.
 *
 * Exported for tests — the wait is the part worth pinning, not the sleeping.
 */
export function retryDelayMs({ body = '', retryAfter = null, attempt = 1, now = Date.now() }) {
  const banned = BAN_UNTIL_RE.exec(body)
  if (banned) {
    const until = Date.parse(banned[1])
    // +2s so we don't race the server's own clock back to a second ban.
    if (Number.isFinite(until)) return Math.min(Math.max(until - now + 2_000, 1_000), MAX_WAIT_MS)
  }
  const secs = Number(retryAfter)
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1_000, MAX_WAIT_MS)
  return Math.min(30_000 * 2 ** (attempt - 1), MAX_WAIT_MS)
}

export class EntsoeClient {
  /**
   * @param token ENTSO-E security token.
   * @param opts.maxAttempts total tries per request, including the first.
   * @param opts.sleep injectable for tests.
   */
  constructor(token, { maxAttempts = 4, sleep = sleepMs } = {}) {
    if (!token) throw new Error('ENTSOE_TOKEN missing')
    this.token = token
    this.maxAttempts = maxAttempts
    this.sleep = sleep
  }

  async get(params) {
    const qs = new URLSearchParams({ securityToken: this.token, ...params })
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${BASE}?${qs}`, {
        headers: { 'User-Agent': 'grid-atlas/1.0 (open-data dashboard)' },
        signal: AbortSignal.timeout(90_000),
      })
      const text = await res.text()
      // 400 with an Acknowledgement document = "no data" for many queries
      if (text.includes('Acknowledgement_MarketDocument')) return null
      if (res.ok) return parser.parse(text)

      // A 31-day backfill is a few hundred requests, so a parallel bank of
      // them trips ENTSO-E's limiter and every subsequent call 429s. Without
      // this the whole run died on the first one — and a baker that deletes
      // history before refetching leaves nothing behind when it does.
      const retryable = res.status === 429 || res.status >= 500
      if (!retryable || attempt >= this.maxAttempts)
        throw new Error(`ENTSO-E ${res.status}: ${text.slice(0, 160)}`)
      const waitMs = retryDelayMs({
        body: text,
        retryAfter: res.headers?.get?.('retry-after') ?? null,
        attempt,
      })
      console.warn(
        `ENTSO-E ${res.status} — waiting ${Math.round(waitMs / 1000)}s then retrying (attempt ${attempt}/${this.maxAttempts})`,
      )
      await this.sleep(waitMs)
    }
  }
}

/**
 * Control/bidding-zone registry per Grid Atlas country.
 *
 * `mixDomains` answers generation (A75) and, for every grid but Ireland, load
 * (A65) as well. `loadDomains` overrides the load query where the two differ —
 * load is a control-area measurement, so a market-only construct like the SEM
 * bidding zone has generation but no load at all.
 */
export const ENTSOE_COUNTRIES = {
  nl: { unitDomains: ['10YNL----------L'], mixDomains: ['10YNL----------L'] },
  be: { unitDomains: ['10YBE----------2'], mixDomains: ['10YBE----------2'] },
  ie: {
    // All-island: EirGrid + SONI control areas, SEM bidding zone.
    unitDomains: ['10YIE-1001A00010', '10Y1001A1001A016'],
    mixDomains: ['10Y1001A1001A59C'],
    // A65 against the SEM zone returns nothing, which is why Ireland was the
    // one grid with demand null on every day of history (#24). EirGrid's
    // control area does publish it (~3.7 GW). SONI files no load with ENTSO-E
    // at all, so this figure is the Republic only while the mix above is
    // all-island — the gap to generation is partly real imports (EWIC, Moyle,
    // Greenlink) and partly that missing NI slice.
    loadDomains: ['10YIE-1001A00010'],
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
  si: { unitDomains: ['10YSI-ELES-----O'], mixDomains: ['10YSI-ELES-----O'] },
  hu: { unitDomains: ['10YHU-MAVIR----U'], mixDomains: ['10YHU-MAVIR----U'] },
  sk: { unitDomains: ['10YSK-SEPS-----K'], mixDomains: ['10YSK-SEPS-----K'] },
  // HEP publishes no per-unit output (A73/A71 both empty) — mix, load and
  // prices only. unitDomains stays set so the registry build degrades to an
  // empty map rather than a config error.
  hr: { unitDomains: ['10YHR-HEP------M'], mixDomains: ['10YHR-HEP------M'] },
  bg: { unitDomains: ['10YCA-BULGARIA-R'], mixDomains: ['10YCA-BULGARIA-R'] },
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
  // Grid batteries discharging. Declared by BE (and increasingly others) and
  // previously unmapped, so the MW were dropped from the mix entirely (#11).
  B25: ['storage', 'Battery storage'],
}

/**
 * psrType → station fuel groups it may match (for unit→station mapping).
 * Must stay complete over PSR_BUCKETS: a code missing here is treated as
 * unrecognised and matches nothing at all (#11).
 */
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
  B08: ['coal', 'bioenergy', 'other'], // fossil peat (Finnish/Irish multi-fuel CHP)
  B10: ['pumped', 'hydro'],
  B11: ['hydro', 'pumped'],
  B12: ['hydro', 'pumped'],
  B13: ['marine'],
  B15: ['hydro'],
  B16: ['solar'],
  B18: ['wind_offshore', 'wind_onshore'],
  B19: ['wind_onshore', 'wind_offshore'],
  // B20 "Other" is a real declaration — batteries, tidal, CHP oddities, units
  // awaiting reclassification — so it stays broad, but a B20 win has to clear
  // BROAD_MIN_SCORE. Unrecognised codes no longer inherit this list (#11).
  B20: ['storage', 'gas', 'oil', 'other', 'bioenergy', 'waste', 'marine', 'hydro', 'solar'],
  // B25 is an explicit battery declaration, so unlike B20 it stays narrow.
  B25: ['storage'],
}

/**
 * Name-score floor for a confident single-fuel psr gate. Deliberately looser
 * than GB's MIN_SCORE (0.55): OSM names for continental plants routinely carry
 * a locality token ENTSO-E omits — "Amer 9" vs "Amercentrale Geertruidenberg"
 * scores 0.5 exactly — so 0.5 is load-bearing on this corpus. The broad-list
 * floor is shared with GB: once the fuel gate stops helping there is no
 * corpus-specific reason to be looser than the other matcher (#11).
 */
export const PSR_MIN_SCORE = 0.5

const unknownPsrTypes = makeUnknownCodeTally('entsoe psrType')

/** Unrecognised psrTypes seen so far this run → match attempts (#11). */
export function unknownPsrCounts() {
  return unknownPsrTypes.counts()
}

/** Clear the unrecognised-psrType tally (per-run scripts, tests). */
export function resetUnknownPsrTypes() {
  unknownPsrTypes.reset()
}

/** psrTypes whose allow-list is broad enough that the name must carry the match. */
export function isBroadPsr(psrType) {
  return psrType == null || psrType === 'B20'
}

/**
 * Station fuels a psrType may match. A declared B20 (or a missing psrType)
 * keeps the broad list; a code PSR_COMPAT has never heard of gets nothing
 * rather than silently inheriting B20's nine fuels (#11).
 */
export function psrCompatFuels(psrType) {
  if (isBroadPsr(psrType)) return PSR_COMPAT.B20
  const list = PSR_COMPAT[psrType]
  if (list) return list
  unknownPsrTypes.note(psrType)
  return []
}

/**
 * Orient one border's two A11 queries for a page country (#43/#57).
 * FLOW_BORDERS lists pair[0] from ONE side's perspective; when that side
 * isn't the page country the sign flips, so + is always import INTO the
 * country being rendered. Returns [outDomain, inDomain, sign] triples.
 * (Pre-fix, Fenno-Skan on #fi showed Sweden's perspective: imports counted
 * as exports and vice versa — this is the regression-tested extraction.)
 */
export function orientFlow(border, ownDomains) {
  const [home, away] = border.pair
  const flip = ownDomains.has(home) ? 1 : -1
  return [
    [away, home, +flip],
    [home, away, -flip],
  ]
}

/**
 * Fuzzy-match one ENTSO-E unit name against the OSM station index, gated by
 * PSR type compatibility (#56) — a wind unit never lands on a gas station,
 * however similar the names. Unrecognised psr codes match nothing, and broad
 * (B20 / missing) ones must clear the higher BROAD_MIN_SCORE bar (#11).
 */
export function matchByName(index, name, psrType) {
  const compat = psrCompatFuels(psrType)
  if (!compat.length) return null
  const floor = isBroadPsr(psrType) ? BROAD_MIN_SCORE : PSR_MIN_SCORE
  const unitToks = tokens(name)
  const stem = stemTokens(unitToks)
  let best = null
  for (const st of index) {
    if (!compat.includes(st.fuel)) continue
    const score = Math.max(jaccard(unitToks, st.toks), jaccard(stem, st.toks))
    if (score >= floor && (!best || score > best.score)) best = { id: st.id, score }
  }
  return best?.id ?? null
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

/** UTC midnight of an ISO date — the origin every series is placed against. */
export const dayStartMs = (isoDate) => Date.parse(`${isoDate}T00:00:00Z`)

/** A Period's declared bounds as epoch ms, null when the document omits them. */
function intervalMs(period) {
  const at = (v) => {
    const ms = Date.parse(v ?? '')
    return Number.isFinite(ms) ? ms : null
  }
  return { startMs: at(period.timeInterval?.start), endMs: at(period.timeInterval?.end) }
}

/**
 * Expand one parsed Period into dense, absolutely-timed per-slot values.
 *
 * Two ENTSO-E details make raw points unusable as they arrive, and getting
 * either wrong silently corrupts the mix rather than failing loudly:
 *
 *  1. `position` is 1-based *within its own Period*, and a document may split
 *     one day across several Periods starting at any instant — Ireland's
 *     all-island A75 routinely publishes a 01:00Z fragment and a 15:00Z one.
 *     Read positionally, every fragment lands back on hour 0: the afternoon
 *     disappears and the fragments stack on top of each other, so the day
 *     either fails the 20-hour coverage gate (17 of IE's last 31 days did) or
 *     passes it carrying double-counted early hours.
 *  2. Every document is curveType A03, "variable sized block" — a point's
 *     value holds until the next declared position, and the final one runs to
 *     the Period's end. Unchanged values are omitted, so a steady generator
 *     describes a whole day with a single point (DE's B09 does exactly that).
 *     Read one-slot-per-point, a flat 24-hour contribution becomes a blip and
 *     every sparse series under-reports its coverage.
 *
 * Partial days are safe: the TSO shortens the Period's end to the publication
 * boundary (FR mid-morning reports end=10:00Z), so running the last block to
 * that end fabricates nothing. Slots outside the requested day are dropped.
 * A Period with no declared interval — only synthetic test documents now —
 * falls back to position-as-slot-index, one slot per point.
 */
export function expandSeries(s, originMs, valueKey = 'mw') {
  const step = s.stepMin * 60_000
  const base = s.startMs ?? originMs
  const pts = s.points
    .filter((p) => Number.isFinite(p.position) && Number.isFinite(p[valueKey]))
    .sort((a, b) => a.position - b.position)
  if (!pts.length) return []
  // Never fill past the end of the day being asked for, whatever the document
  // claims — bad bounds waste cycles, they don't get to invent slots.
  const dayEndSlot = Math.ceil((originMs + 24 * 3600_000 - base) / step)
  const declaredEnd = s.endMs == null ? pts.at(-1).position : Math.round((s.endMs - base) / step)
  const lastSlot = Math.min(declaredEnd, dayEndSlot)
  const out = []
  for (let i = 0; i < pts.length; i++) {
    const from = pts[i].position
    const to = i + 1 < pts.length ? pts[i + 1].position - 1 : Math.max(lastSlot, from)
    for (let pos = from; pos <= Math.min(to, dayEndSlot); pos++) {
      const hour = Math.floor((base + (pos - 1) * step - originMs) / 3600_000)
      if (hour >= 0 && hour <= 23) out.push({ hour, value: pts[i][valueKey] })
    }
  }
  return out
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
      out.push({ currency, stepMin, ...intervalMs(period), points })
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
        ...intervalMs(period),
        points,
      })
    }
  }
  return out
}

/** Sum per-unit series (already mapped to stations) into StationDay shape. */
export function stationDayFromSeries(seriesList, originMs = null) {
  // Normalise to hourly slots (0-23); finer resolutions are averaged.
  const sums = new Array(24).fill(0)
  const counts = new Array(24).fill(0)
  for (const s of seriesList) {
    const perHour = 60 / s.stepMin
    // Without a day origin, place each series against its own start — the old
    // positional reading, so callers that don't know the date still work.
    const origin = originMs ?? s.startMs ?? 0
    // Same A03 / fragment handling the mix needs — a unit held at a steady
    // output publishes one point covering the whole day.
    for (const { hour, value } of expandSeries(s, origin)) {
      sums[hour] += value / perHour
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
