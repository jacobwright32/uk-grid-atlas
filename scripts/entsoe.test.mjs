// ENTSO-E parser tests (#58): parseSeries/parsePriceSeries/stationDayFromSeries
// were the highest-risk untested code — every European snapshot flows
// through them. XML fixtures go through the same fast-xml-parser config the
// client uses, so attribute/#text quirks are exercised for real.
import { describe, expect, it } from 'vitest'
import {
  ENTSOE_COUNTRIES,
  FLOW_BORDERS,
  PSR_BUCKETS,
  PSR_COMPAT,
  dayWindow,
  matchByName,
  orientFlow,
  parsePriceSeries,
  parseSeries,
  stationDayFromSeries,
} from './entsoe.mjs'
import { tokens } from './live-matching.mjs'
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

describe('registry invariants', () => {
  it('every PSR bucket key is a snapshot bucket (incl. B07 shale → coal)', () => {
    for (const [key] of Object.values(PSR_BUCKETS)) {
      expect(BUCKET_META[key], `bucket ${key}`).toBeTruthy()
    }
    expect(PSR_BUCKETS.B07[0]).toBe('coal') // Estonia's Narva oil-shale fleet
  })
  it('PSR_COMPAT covers only known psr types and keeps the B20 fallback', () => {
    for (const psr of Object.keys(PSR_COMPAT)) {
      expect(PSR_BUCKETS[psr], `compat ${psr}`).toBeTruthy()
    }
    expect(PSR_COMPAT.B20.length).toBeGreaterThan(0)
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
})
