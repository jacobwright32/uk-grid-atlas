// ENTSO-E parser tests (#58): parseSeries/parsePriceSeries/stationDayFromSeries
// were the highest-risk untested code — every European snapshot flows
// through them. XML fixtures go through the same fast-xml-parser config the
// client uses, so attribute/#text quirks are exercised for real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ENTSOE_COUNTRIES,
  EntsoeClient,
  FLOW_BORDERS,
  PSR_BUCKETS,
  PSR_COMPAT,
  PSR_MIN_SCORE,
  dayStartMs,
  dayWindow,
  expandSeries,
  matchByName,
  orientFlow,
  parsePriceSeries,
  parseSeries,
  psrCompatFuels,
  resetUnknownPsrTypes,
  retryDelayMs,
  stationDayFromSeries,
  unknownPsrCounts,
} from './entsoe.mjs'
import { BROAD_MIN_SCORE, tokens } from './live-matching.mjs'
import { INTERCONNECTORS } from './interconnectors.mjs'
import { BUCKET_META, makeXmlParser } from './snapshot-common.mjs'

const parse = (xml) => makeXmlParser().parse(xml)

describe('parseSeries', () => {
  it('parses a per-type (A75) document: psrType, resolution, points', () => {
    const doc = parse(`
      <GL_MarketDocument>
        <TimeSeries>
          <inBiddingZone_Domain.mRID codingScheme="A01">10YFI-1--------U</inBiddingZone_Domain.mRID>
          <MktPSRType><psrType>B14</psrType></MktPSRType>
          <Period>
            <resolution>PT60M</resolution>
            <Point><position>1</position><quantity>1000</quantity></Point>
            <Point><position>2</position><quantity>1100.5</quantity></Point>
          </Period>
        </TimeSeries>
      </GL_MarketDocument>`)
    const series = parseSeries(doc)
    expect(series).toHaveLength(1)
    expect(series[0].psrType).toBe('B14')
    expect(series[0].stepMin).toBe(60)
    expect(series[0].inDomain).toBe('10YFI-1--------U')
    expect(series[0].outDomain).toBeNull()
    expect(series[0].points).toEqual([
      { position: 1, mw: 1000 },
      { position: 2, mw: 1100.5 },
    ])
  })

  it('parses a per-unit (A73) document: EIC via #text, name, nominalP', () => {
    const doc = parse(`
      <GL_MarketDocument>
        <TimeSeries>
          <MktPSRType>
            <psrType>B14</psrType>
            <PowerSystemResources>
              <mRID codingScheme="A10">48W000000LOVI1AB</mRID>
              <name>Loviisa 1</name>
              <nominalP unit="MAW">507</nominalP>
            </PowerSystemResources>
          </MktPSRType>
          <Period>
            <resolution>PT60M</resolution>
            <Point><position>1</position><quantity>507</quantity></Point>
          </Period>
        </TimeSeries>
      </GL_MarketDocument>`)
    const [s] = parseSeries(doc)
    expect(s.unitEic).toBe('48W000000LOVI1AB')
    expect(s.unitName).toBe('Loviisa 1')
    expect(s.nominalP).toBe(507)
  })

  it('handles single vs repeated TimeSeries/Period and 15/30-minute steps', () => {
    const doc = parse(`
      <GL_MarketDocument>
        <TimeSeries>
          <MktPSRType><psrType>B18</psrType></MktPSRType>
          <Period>
            <resolution>PT15M</resolution>
            <Point><position>1</position><quantity>10</quantity></Point>
          </Period>
          <Period>
            <resolution>PT30M</resolution>
            <Point><position>1</position><quantity>20</quantity></Point>
          </Period>
        </TimeSeries>
      </GL_MarketDocument>`)
    const series = parseSeries(doc)
    expect(series).toHaveLength(2) // one entry per Period
    expect(series[0].stepMin).toBe(15)
    expect(series[1].stepMin).toBe(30)
  })

  it('flags consumption series via outBiddingZone only', () => {
    const doc = parse(`
      <GL_MarketDocument>
        <TimeSeries>
          <outBiddingZone_Domain.mRID codingScheme="A01">10YFI-1--------U</outBiddingZone_Domain.mRID>
          <MktPSRType><psrType>B10</psrType></MktPSRType>
          <Period>
            <resolution>PT60M</resolution>
            <Point><position>1</position><quantity>300</quantity></Point>
          </Period>
        </TimeSeries>
      </GL_MarketDocument>`)
    const [s] = parseSeries(doc)
    expect(s.outDomain).toBe('10YFI-1--------U')
    expect(s.inDomain).toBeNull() // fetcher skips these (pumping load)
  })

  it('returns [] for null/acknowledgement/malformed documents', () => {
    expect(parseSeries({})).toEqual([])
    expect(parseSeries(parse('<Acknowledgement_MarketDocument/>'))).toEqual([])
  })
})

describe('parsePriceSeries', () => {
  it('parses A44 price points with currency', () => {
    const doc = parse(`
      <Publication_MarketDocument>
        <TimeSeries>
          <currency_Unit.name>EUR</currency_Unit.name>
          <Period>
            <resolution>PT60M</resolution>
            <Point><position>1</position><price.amount>42.07</price.amount></Point>
            <Point><position>2</position><price.amount>-5.5</price.amount></Point>
          </Period>
        </TimeSeries>
      </Publication_MarketDocument>`)
    const [z] = parsePriceSeries(doc)
    expect(z.currency).toBe('EUR')
    expect(z.stepMin).toBe(60)
    expect(z.points).toEqual([
      { position: 1, price: 42.07 },
      { position: 2, price: -5.5 },
    ])
  })
  it('defaults missing currency to EUR and tolerates empty docs', () => {
    const doc = parse(`
      <Publication_MarketDocument>
        <TimeSeries>
          <Period>
            <resolution>PT60M</resolution>
            <Point><position>1</position><price.amount>10</price.amount></Point>
          </Period>
        </TimeSeries>
      </Publication_MarketDocument>`)
    expect(parsePriceSeries(doc)[0].currency).toBe('EUR')
    expect(parsePriceSeries({})).toEqual([])
  })
})

describe('stationDayFromSeries', () => {
  it('averages quarter-hour points into hourly slots', () => {
    const day = stationDayFromSeries([
      {
        stepMin: 15,
        points: [
          { position: 1, mw: 100 },
          { position: 2, mw: 100 },
          { position: 3, mw: 200 },
          { position: 4, mw: 200 },
        ],
      },
    ])
    expect(day.series[0]).toBe(150)
    expect(day.periods).toBe(1)
    expect(day.peakMW).toBe(150)
  })
  it('sums multiple unit series into one station and clamps negatives', () => {
    const mk = (mw) => ({ stepMin: 60, points: [{ position: 1, mw }] })
    const day = stationDayFromSeries([mk(300), mk(-500)])
    expect(day.series[0]).toBe(0) // net negative clamps to zero, hour still covered
    expect(day.periods).toBe(1)
  })
  it('returns null when no points land', () => {
    expect(stationDayFromSeries([])).toBeNull()
    expect(stationDayFromSeries([{ stepMin: 60, points: [{ position: 1, mw: NaN }] }])).toBeNull()
  })
})

describe('dayWindow', () => {
  it('covers one UTC day, rolling months correctly', () => {
    expect(dayWindow('2026-07-20')).toEqual({
      periodStart: '202607200000',
      periodEnd: '202607210000',
    })
    expect(dayWindow('2026-01-31').periodEnd).toBe('202602010000')
    expect(dayWindow('2026-12-31').periodEnd).toBe('202701010000')
  })
})

describe('orientFlow (#57)', () => {
  // Fenno-Skan: FLOW_BORDERS lists the pair from Sweden's side (SE3 first).
  const fennoSkan = FLOW_BORDERS.find((b) => b.links.includes('fenno-skan'))
  const SE3 = '10Y1001A1001A46L'
  const FI = '10YFI-1--------U'

  it('keeps the listed perspective when the page country owns pair[0]', () => {
    const se = new Set(['10Y1001A1001A44P', '10Y1001A1001A45N', SE3, '10Y1001A1001A47J'])
    expect(orientFlow(fennoSkan, se)).toEqual([
      [FI, SE3, 1], // Finland → Sweden counts as Swedish import
      [SE3, FI, -1],
    ])
  })
  it('flips signs for the other side of a shared border (the #fi bug)', () => {
    const fi = new Set([FI])
    expect(orientFlow(fennoSkan, fi)).toEqual([
      [FI, SE3, -1], // Finland → Sweden is a Finnish EXPORT
      [SE3, FI, 1], // Sweden → Finland is the Finnish import
    ])
  })
  it('both query directions cover the border exactly once each way', () => {
    for (const border of FLOW_BORDERS) {
      const specs = orientFlow(border, new Set(border.pair.slice(0, 1)))
      const pairs = specs.map(([o, i]) => `${o}→${i}`)
      expect(new Set(pairs).size).toBe(2)
      expect(specs[0][2] + specs[1][2]).toBe(0) // opposite signs
    }
  })
})

describe('matchByName (#56)', () => {
  const index = [
    { id: 'olkiluoto', fuel: 'nuclear', toks: tokens('Olkiluoto nuclear power plant') },
    { id: 'luenen', fuel: 'gas', toks: tokens('Kraftwerk Lünen') },
    { id: 'ajos', fuel: 'wind_onshore', toks: tokens('Ajos tuulipuisto') },
  ]
  it('matches units to stations through the multilingual tokeniser', () => {
    expect(matchByName(index, 'Olkiluoto 3', 'B14')).toBe('olkiluoto')
    expect(matchByName(index, 'LUENEN', 'B04')).toBe('luenen') // ENTSO-E spells the umlaut out
  })
  it('PSR compatibility gates out same-name different-fuel stations', () => {
    // a wind unit named like the gas plant must not land on it
    expect(matchByName(index, 'Luenen', 'B19')).toBeNull()
    // and a nuclear unit can never land on wind
    expect(matchByName(index, 'Ajos', 'B14')).toBeNull()
  })
  it('returns null below the similarity threshold', () => {
    expect(matchByName(index, 'Meri-Pori', 'B14')).toBeNull()
  })
})

describe('matchByName psr-code strictness (#11)', () => {
  const index = [
    { id: 'olkiluoto', fuel: 'nuclear', toks: tokens('Olkiluoto nuclear power plant') },
    { id: 'amer', fuel: 'gas', toks: tokens('Amercentrale Geertruidenberg') },
    { id: 'meygen', fuel: 'marine', toks: tokens('MeyGen Tidal Array') },
  ]
  beforeEach(() => resetUnknownPsrTypes())
  afterEach(() => vi.restoreAllMocks())

  it('keeps a declared B20 (and a missing psrType) matching real "other" units', () => {
    expect(matchByName(index, 'MeyGen Tidal Array', 'B20')).toBe('meygen')
    expect(matchByName(index, 'MeyGen Tidal Array 4', null)).toBe('meygen')
    // but a partial name ('MeyGen Tidal' = 2 of 3 tokens) no longer suffices
    expect(matchByName(index, 'MeyGen Tidal', 'B20')).toBeNull()
  })
  it('keeps 0.5 for a confident single-fuel gate but demands 0.7 from B20', () => {
    // the case PSR_MIN_SCORE exists for: OSM carries a locality token ENTSO-E
    // omits, so "Amer 9" vs "Amercentrale Geertruidenberg" is 0.5 exactly
    expect(matchByName(index, 'Amer 9', 'B04')).toBe('amer')
    expect(matchByName(index, 'Amer 9', 'B20')).toBeNull()
    expect(PSR_MIN_SCORE).toBeLessThan(BROAD_MIN_SCORE)
  })
  it('never matches an unrecognised psr code, warning once per code (#11)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(matchByName(index, 'Olkiluoto 3', 'B99')).toBeNull()
    expect(matchByName(index, 'Olkiluoto 1', 'B99')).toBeNull()
    expect(matchByName(index, 'Amer 9', 'WIND')).toBeNull() // Elexon code in a psr field
    expect(warn).toHaveBeenCalledTimes(2)
    expect(unknownPsrCounts()).toEqual({ B99: 2, WIND: 1 })
  })
  it('never lands a non-nuclear unit on a nuclear station', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(matchByName(index, 'Olkiluoto 3', 'B20')).toBeNull()
    expect(matchByName(index, 'Olkiluoto 3', null)).toBeNull()
    expect(matchByName(index, 'Olkiluoto 3', 'B99')).toBeNull()
  })
})

describe('registry invariants', () => {
  it('every PSR bucket key is a snapshot bucket (incl. B07 shale → coal)', () => {
    for (const [key] of Object.values(PSR_BUCKETS)) {
      expect(BUCKET_META[key], `bucket ${key}`).toBeTruthy()
    }
    expect(PSR_BUCKETS.B07[0]).toBe('coal') // Estonia's Narva oil-shale fleet
  })
  it('PSR_COMPAT covers every known psr type and keeps B20 broad (#11)', () => {
    for (const psr of Object.keys(PSR_COMPAT)) {
      expect(PSR_BUCKETS[psr], `compat ${psr}`).toBeTruthy()
    }
    // Completeness is now load-bearing: an unlisted code matches nothing, so
    // every bucket ENTSO-E can publish needs a compat row (B08 peat, B13 marine
    // used to ride on the B20 fallback).
    for (const psr of Object.keys(PSR_BUCKETS)) {
      expect(PSR_COMPAT[psr], `bucket ${psr}`).toBeTruthy()
    }
    // B20 stays broad for *declared* "other" units …
    expect(PSR_COMPAT.B20.length).toBeGreaterThan(1)
    expect(psrCompatFuels('B20')).toEqual(PSR_COMPAT.B20)
    expect(psrCompatFuels(null)).toEqual(PSR_COMPAT.B20)
    // … but an unrecognised code no longer inherits it
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(psrCompatFuels('B99')).toEqual([])
    vi.restoreAllMocks()
  })
  it('every FLOW_BORDERS link exists in INTERCONNECTORS with capacity', () => {
    const byId = new Map(INTERCONNECTORS.map((ic) => [ic.id, ic]))
    for (const border of FLOW_BORDERS) {
      expect(border.pair).toHaveLength(2)
      for (const eic of border.pair) expect(eic).toMatch(/^10Y/)
      expect(border.countries.length).toBeGreaterThan(0)
      for (const id of border.links) {
        const ic = byId.get(id)
        expect(ic, `link ${id}`).toBeTruthy()
        expect(ic.capMW).toBeGreaterThan(0)
      }
    }
  })
  it('every country config has unit and mix domains', () => {
    for (const [cc, cfg] of Object.entries(ENTSOE_COUNTRIES)) {
      expect(cfg.unitDomains.length, cc).toBeGreaterThan(0)
      expect(cfg.mixDomains.length, cc).toBeGreaterThan(0)
    }
  })
  // Load (A65) is a control-area measurement while generation (A75) is published
  // per bidding zone, so the two domains diverge wherever a market zone isn't a
  // control area. `loadDomains` is the opt-in override for that case and the
  // demand query falls back to `mixDomains` without it — which is why Ireland
  // silently had demand null on all 31 days of history (#24): A65 against the
  // SEM bidding zone returns no series at all.
  it('declares loadDomains only where load and generation domains diverge', () => {
    const withLoad = Object.entries(ENTSOE_COUNTRIES).filter(([, cfg]) => cfg.loadDomains)
    for (const [cc, cfg] of withLoad) {
      expect(Array.isArray(cfg.loadDomains), cc).toBe(true)
      expect(cfg.loadDomains.length, cc).toBeGreaterThan(0)
      for (const eic of cfg.loadDomains) expect(eic, cc).toMatch(/^10Y/)
      // An override identical to mixDomains is a no-op that reads like a fix.
      expect(cfg.loadDomains.join(), cc).not.toBe(cfg.mixDomains.join())
    }
    // Pinned deliberately: a second divergent grid is a finding worth a decision,
    // not a line copied from here. Ireland's is EirGrid's control area, which is
    // the Republic only — the mix above stays all-island.
    expect(withLoad.map(([cc]) => cc)).toEqual(['ie'])
    expect(ENTSOE_COUNTRIES.ie.loadDomains).toEqual(['10YIE-1001A00010'])
  })
})

// Every ENTSO-E document is curveType A03 and may split a day into several
// Periods starting at any instant. Reading `position` as a day offset and one
// slot per point corrupted the mix silently — Ireland lost 17 of its last 31
// days to it, and flat generators everywhere became one-slot blips.
describe('expandSeries', () => {
  const O = dayStartMs('2026-07-23')
  const at = (iso) => Date.parse(iso)

  it('holds each A03 block until the next declared position', () => {
    // One point at position 1 of a full 30-minute day = a flat 24 hours.
    const got = expandSeries(
      {
        stepMin: 30,
        startMs: O,
        endMs: O + 24 * 3600_000,
        points: [{ position: 1, mw: 500 }],
      },
      O,
    )
    expect(got).toHaveLength(48)
    expect(new Set(got.map((g) => g.hour)).size).toBe(24)
    expect(got.every((g) => g.value === 500)).toBe(true)
  })

  it('fills the gap between sparse points with the earlier value', () => {
    const got = expandSeries(
      {
        stepMin: 60,
        startMs: O,
        endMs: O + 4 * 3600_000,
        points: [
          { position: 1, mw: 10 },
          { position: 3, mw: 30 },
        ],
      },
      O,
    )
    expect(got).toEqual([
      { hour: 0, value: 10 },
      { hour: 1, value: 10 },
      { hour: 2, value: 30 },
      { hour: 3, value: 30 },
    ])
  })

  it('places a mid-day fragment at its real hours, not back at hour 0', () => {
    // Ireland's all-island A75 publishes a 15:00Z fragment whose positions
    // restart at 1; positionally it landed on hours 0-8.
    const start = at('2026-07-23T15:00Z')
    const got = expandSeries(
      {
        stepMin: 30,
        startMs: start,
        endMs: at('2026-07-24T00:00Z'),
        points: [{ position: 1, mw: 900 }],
      },
      O,
    )
    expect(Math.min(...got.map((g) => g.hour))).toBe(15)
    expect(Math.max(...got.map((g) => g.hour))).toBe(23)
  })

  it('honours a shortened end so partial days invent nothing', () => {
    // FR mid-morning: the TSO ends the Period at the publication boundary.
    const got = expandSeries(
      {
        stepMin: 60,
        startMs: O,
        endMs: O + 10 * 3600_000,
        points: [{ position: 1, mw: 100 }],
      },
      O,
    )
    expect(got).toHaveLength(10)
    expect(Math.max(...got.map((g) => g.hour))).toBe(9)
  })

  it('never fills past the requested day, whatever the document claims', () => {
    const got = expandSeries(
      {
        stepMin: 60,
        startMs: O,
        endMs: O + 400 * 3600_000, // nonsense bounds
        points: [{ position: 1, mw: 1 }],
      },
      O,
    )
    expect(got).toHaveLength(24)
  })

  it('drops slots outside the requested day and skips non-finite values', () => {
    const got = expandSeries(
      {
        stepMin: 60,
        startMs: O - 3 * 3600_000, // starts on the previous day
        endMs: O + 2 * 3600_000,
        points: [
          { position: 1, mw: 7 },
          { position: 4, mw: NaN },
        ],
      },
      O,
    )
    expect(got.every((g) => g.hour >= 0 && g.hour <= 23)).toBe(true)
    expect(got.every((g) => Number.isFinite(g.value))).toBe(true)
  })

  it('reads prices via the value key', () => {
    const got = expandSeries(
      { stepMin: 60, startMs: O, endMs: O + 2 * 3600_000, points: [{ position: 1, price: -5.5 }] },
      O,
      'price',
    )
    expect(got).toEqual([
      { hour: 0, value: -5.5 },
      { hour: 1, value: -5.5 },
    ])
  })

  it('falls back to position-as-slot for documents with no timeInterval', () => {
    const got = expandSeries(
      { stepMin: 60, startMs: null, endMs: null, points: [{ position: 3, mw: 42 }] },
      0,
    )
    expect(got).toEqual([{ hour: 2, value: 42 }])
  })

  it('carries the Period interval through parseSeries', () => {
    const doc = parse(`
      <GL_MarketDocument>
        <TimeSeries>
          <MktPSRType><psrType>B19</psrType></MktPSRType>
          <Period>
            <timeInterval>
              <start>2026-07-23T15:00Z</start>
              <end>2026-07-24T00:00Z</end>
            </timeInterval>
            <resolution>PT30M</resolution>
            <Point><position>1</position><quantity>900</quantity></Point>
          </Period>
        </TimeSeries>
      </GL_MarketDocument>`)
    const [s] = parseSeries(doc)
    expect(s.startMs).toBe(at('2026-07-23T15:00Z'))
    expect(s.endMs).toBe(at('2026-07-24T00:00Z'))
    expect(expandSeries(s, O)).toHaveLength(18)
  })

  it('carries the Period interval through parsePriceSeries', () => {
    const doc = parse(`
      <Publication_MarketDocument>
        <TimeSeries>
          <currency_Unit.name>EUR</currency_Unit.name>
          <Period>
            <timeInterval>
              <start>2026-07-23T00:00Z</start>
              <end>2026-07-24T00:00Z</end>
            </timeInterval>
            <resolution>PT60M</resolution>
            <Point><position>1</position><price.amount>42</price.amount></Point>
          </Period>
        </TimeSeries>
      </Publication_MarketDocument>`)
    const [s] = parsePriceSeries(doc)
    expect(s.startMs).toBe(at('2026-07-23T00:00Z'))
    expect(expandSeries(s, O, 'price')).toHaveLength(24)
  })

  it('spreads a flat unit across the whole day in stationDayFromSeries', () => {
    const day = stationDayFromSeries(
      [{ stepMin: 30, startMs: O, endMs: O + 24 * 3600_000, points: [{ position: 1, mw: 200 }] }],
      O,
    )
    expect(day.periods).toBe(24) // was 1 — a whole-day block read as a blip
    expect(day.avgMW).toBe(200)
    expect(day.series.every((v) => v === 200)).toBe(true)
  })
})

// The client had no coverage at all until a parallel bank of backfills got the
// token banned mid-run and every subsequent call 429'd (#68). These pin the
// retry contract: honour the server's own stated expiry, never wait forever,
// and never retry something a retry can't fix.
describe('retryDelayMs', () => {
  const NOW = Date.parse('2026-07-27T11:00:00Z')
  const banBody = (iso) => `<html><body><p>Requester banned until '${iso}'.</p></body></html>`

  it('waits until the ban expiry the server states, plus 2s of clock slack', () => {
    const body = banBody('2026-07-27T11:06:54.222Z')
    expect(retryDelayMs({ body, now: NOW })).toBe(6 * 60_000 + 54_222 + 2_000)
  })

  it('clamps a ban that has already lapsed to a 1s floor rather than 0 or negative', () => {
    const body = banBody('2026-07-27T10:00:00Z')
    expect(retryDelayMs({ body, now: NOW })).toBe(1_000)
  })

  it('clamps an absurdly distant ban to MAX_WAIT_MS so a run cannot hang for a day', () => {
    const body = banBody('2026-07-28T11:00:00Z')
    expect(retryDelayMs({ body, now: NOW })).toBe(15 * 60_000)
  })

  it('prefers the stated ban expiry over a Retry-After header', () => {
    const body = banBody('2026-07-27T11:01:00Z')
    expect(retryDelayMs({ body, retryAfter: '600', now: NOW })).toBe(62_000)
  })

  it('ignores an unparseable ban timestamp and falls through to backoff', () => {
    expect(retryDelayMs({ body: banBody('not-a-date'), attempt: 1, now: NOW })).toBe(30_000)
  })

  it('honours Retry-After seconds when the body says nothing', () => {
    expect(retryDelayMs({ retryAfter: '45', now: NOW })).toBe(45_000)
    expect(retryDelayMs({ retryAfter: '99999', now: NOW })).toBe(15 * 60_000)
  })

  it('ignores a non-numeric or non-positive Retry-After', () => {
    expect(retryDelayMs({ retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT', attempt: 2 })).toBe(60_000)
    expect(retryDelayMs({ retryAfter: '0', attempt: 1 })).toBe(30_000)
  })

  it('backs off exponentially from 30s, clamped at MAX_WAIT_MS', () => {
    const waits = [1, 2, 3, 4, 5, 6, 7].map((attempt) => retryDelayMs({ attempt }))
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000])
  })
})

describe('EntsoeClient', () => {
  const OK_XML = '<GL_MarketDocument><TimeSeries /></GL_MarketDocument>'
  const ACK_XML = '<Acknowledgement_MarketDocument><Reason /></Acknowledgement_MarketDocument>'
  const BAN_HTML = `<html><body><p>Requester banned until '2026-07-27T11:06:54.222Z'.</p></body></html>`

  /** Queue of {status, body, headers?}; each get() consumes one. */
  const stubFetch = (responses) => {
    const calls = []
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(url)
      const r = responses[calls.length - 1]
      if (!r) throw new Error(`unexpected fetch #${calls.length}`)
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: (k) => r.headers?.[k.toLowerCase()] ?? null },
        text: async () => r.body,
      }
    })
    return calls
  }

  /** Records what we'd have slept instead of actually sleeping. The pacing
   *  gap is off here — these tests pin retry/backoff semantics, and the
   *  process-wide last-request timestamp would otherwise leak a spurious
   *  pacing sleep into whichever test runs second. */
  const makeClient = (opts = {}) => {
    const slept = []
    const client = new EntsoeClient('token-abc', {
      sleep: async (ms) => void slept.push(ms),
      minGapMs: 0,
      ...opts,
    })
    return { client, slept }
  }

  const realFetch = globalThis.fetch

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('throws at construction without a token, before any request is attempted', () => {
    expect(() => new EntsoeClient('')).toThrow(/ENTSOE_TOKEN missing/)
    expect(() => new EntsoeClient(undefined)).toThrow(/ENTSOE_TOKEN missing/)
  })

  it('sends the token plus params and parses a 200 body', async () => {
    const calls = stubFetch([{ status: 200, body: OK_XML }])
    const { client, slept } = makeClient()
    const doc = await client.get({ documentType: 'A75', in_Domain: '10YFI-1--------U' })
    expect(doc).toHaveProperty('GL_MarketDocument')
    expect(slept).toEqual([])
    const qs = new URL(calls[0]).searchParams
    expect(qs.get('securityToken')).toBe('token-abc')
    expect(qs.get('documentType')).toBe('A75')
    expect(qs.get('in_Domain')).toBe('10YFI-1--------U')
  })

  it('returns null for an Acknowledgement document even on a 400 — that means "no data", not failure', async () => {
    stubFetch([{ status: 400, body: ACK_XML }])
    const { client, slept } = makeClient()
    expect(await client.get({ documentType: 'A75' })).toBeNull()
    expect(slept).toEqual([]) // not treated as retryable
  })

  it('retries a 429 after the stated ban expiry and returns the eventual success', async () => {
    const calls = stubFetch([
      { status: 429, body: BAN_HTML },
      { status: 200, body: OK_XML },
    ])
    const { client, slept } = makeClient()
    const doc = await client.get({ documentType: 'A75' })
    expect(doc).toHaveProperty('GL_MarketDocument')
    expect(calls).toHaveLength(2)
    expect(slept).toHaveLength(1)
    expect(slept[0]).toBeGreaterThan(0)
    expect(slept[0]).toBeLessThanOrEqual(15 * 60_000)
  })

  it('retries 5xx with exponential backoff', async () => {
    stubFetch([
      { status: 503, body: 'upstream down' },
      { status: 502, body: 'bad gateway' },
      { status: 200, body: OK_XML },
    ])
    const { client, slept } = makeClient()
    await client.get({ documentType: 'A75' })
    expect(slept).toEqual([30_000, 60_000])
  })

  it('gives up after maxAttempts and reports the status and body', async () => {
    const calls = stubFetch(Array.from({ length: 3 }, () => ({ status: 429, body: BAN_HTML })))
    const { client, slept } = makeClient({ maxAttempts: 3 })
    await expect(client.get({ documentType: 'A75' })).rejects.toThrow(/ENTSO-E 429:.*banned until/s)
    expect(calls).toHaveLength(3)
    expect(slept).toHaveLength(2) // no sleep after the final failure
  })

  it('does not retry a status a retry cannot fix', async () => {
    const calls = stubFetch([{ status: 401, body: 'Unauthorized' }])
    const { client, slept } = makeClient()
    await expect(client.get({ documentType: 'A75' })).rejects.toThrow(/ENTSO-E 401/)
    expect(calls).toHaveLength(1)
    expect(slept).toEqual([])
  })

  it('truncates a huge error body instead of pasting it into the log', async () => {
    stubFetch([{ status: 500, body: 'x'.repeat(5_000) }])
    const { client } = makeClient({ maxAttempts: 1 })
    await expect(client.get({})).rejects.toThrow(/^ENTSO-E 500: x{160}$/)
  })
})
