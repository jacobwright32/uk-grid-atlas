// Pipeline unit tests (vitest picks up *.test.mjs too).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clipRingToBox,
  parseCapacityMW,
  parseVoltClassWith,
  simplify,
  unwrapRing,
} from './pipeline-utils.mjs'
import { buildRegionBasemap } from './basemap.mjs'
import { UNNAMED, dedupeStations, mergeLines, phaseKey, readLineFile } from './build-data.mjs'
import { fetchOne, hasElements } from './fetch-overpass.mjs'

describe('parseCapacityMW', () => {
  it('parses plain MW', () => {
    expect(parseCapacityMW('460 MW')).toBe(460)
    expect(parseCapacityMW('49.9MW')).toBeCloseTo(49.9)
  })
  it('parses separators and GW/kW/W', () => {
    expect(parseCapacityMW('1,218 MW')).toBe(1218)
    expect(parseCapacityMW('2 GW')).toBe(2000)
    expect(parseCapacityMW('750 kW')).toBeCloseTo(0.75)
    expect(parseCapacityMW('500000 W')).toBeCloseTo(0.5)
  })
  it('bare numbers: MW when plausible, kW when large, watts when huge', () => {
    expect(parseCapacityMW('420')).toBe(420)
    expect(parseCapacityMW('12870')).toBeCloseTo(12.87) // bare kWp (common on DE solar)
    expect(parseCapacityMW('24000000')).toBe(24)
  })
  it('European decimal commas vs thousands separators', () => {
    expect(parseCapacityMW('1,2 MW')).toBeCloseTo(1.2)
    expect(parseCapacityMW('12,87 MWp')).toBeCloseTo(12.87)
    expect(parseCapacityMW('1,218 MW')).toBe(1218)
    expect(parseCapacityMW('1,218.5 MW')).toBeCloseTo(1218.5)
  })
  it('rejects junk', () => {
    expect(parseCapacityMW('yes')).toBeNull()
    expect(parseCapacityMW(null)).toBeNull()
    expect(parseCapacityMW('')).toBeNull()
  })
})

describe('parseVoltClassWith', () => {
  // GB-style classify, as bound by build-data's gb registry entry.
  const gb = (n) => (n >= 380000 ? 400 : n >= 264000 ? 275 : n >= 110000 ? 132 : null)
  // Baltic-style: a different ladder proves the classify is actually used.
  const baltic = (n) => (n >= 300000 ? 330 : n >= 100000 ? 110 : null)

  it('classifies single voltages through the country classify', () => {
    expect(parseVoltClassWith(gb, '400000')).toBe(400)
    expect(parseVoltClassWith(gb, '275000')).toBe(275)
    expect(parseVoltClassWith(gb, '132000')).toBe(132)
    expect(parseVoltClassWith(baltic, '330000')).toBe(330)
    expect(parseVoltClassWith(baltic, '110000')).toBe(110)
  })
  it('takes the highest of multi-voltage ways', () => {
    expect(parseVoltClassWith(gb, '275000;132000')).toBe(275)
    expect(parseVoltClassWith(gb, '132000;400000')).toBe(400)
    expect(parseVoltClassWith(baltic, '110000;330000')).toBe(330)
  })
  it('ignores sub-transmission and junk', () => {
    expect(parseVoltClassWith(gb, '33000')).toBeNull()
    expect(parseVoltClassWith(gb, null)).toBeNull()
    expect(parseVoltClassWith(gb, 'abc')).toBeNull()
    // a qualifying part still wins next to junk
    expect(parseVoltClassWith(gb, 'abc;400000')).toBe(400)
  })
})

describe('simplify', () => {
  it('keeps endpoints and collapses collinear points', () => {
    const line = [
      [0, 0],
      [1, 0.00001],
      [2, 0],
      [3, 0.00002],
      [4, 0],
    ]
    const out = simplify(line, 0.001)
    expect(out[0]).toEqual([0, 0])
    expect(out[out.length - 1]).toEqual([4, 0])
    expect(out.length).toBe(2)
  })
  it('preserves genuine corners', () => {
    const corner = [
      [0, 0],
      [1, 0],
      [1, 1],
    ]
    expect(simplify(corner, 0.001)).toHaveLength(3)
  })
})

describe('unwrapRing', () => {
  it('leaves ordinary rings alone', () => {
    const ring = [
      [10, 50],
      [11, 50],
      [11, 51],
      [10, 50],
    ]
    expect(unwrapRing(ring)).toEqual(ring)
  })
  it('makes antimeridian crossings continuous', () => {
    const ring = [
      [179, 65],
      [-179.5, 65], // crosses 180 eastward
      [-179.5, 66],
      [179, 66],
      [179, 65],
    ]
    const out = unwrapRing(ring)
    expect(out.map(([x]) => x)).toEqual([179, 180.5, 180.5, 179, 179])
    // closed ring stays closed
    expect(out[0]).toEqual(out[out.length - 1])
  })
})

describe('clipRingToBox', () => {
  const box = [0, 0, 10, 10]
  it('keeps a fully-inside ring, closed', () => {
    const ring = [
      [2, 2],
      [8, 2],
      [8, 8],
      [2, 8],
      [2, 2],
    ]
    const out = clipRingToBox(ring, box)
    expect(out[0]).toEqual(out[out.length - 1])
    expect(out.slice(0, -1)).toHaveLength(4)
  })
  it('clips a straddling ring to the box edge', () => {
    const ring = [
      [-5, 2],
      [5, 2],
      [5, 8],
      [-5, 8],
      [-5, 2],
    ]
    const out = clipRingToBox(ring, box)
    expect(out).not.toBeNull()
    for (const [x, y] of out) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(10)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(10)
    }
    // area is halved: the kept part spans x 0..5, y 2..8
    expect(Math.max(...out.map(([x]) => x))).toBe(5)
    expect(Math.min(...out.map(([x]) => x))).toBe(0)
  })
  it('returns null when nothing remains', () => {
    const ring = [
      [20, 20],
      [30, 20],
      [30, 30],
      [20, 20],
    ]
    expect(clipRingToBox(ring, box)).toBeNull()
  })
})

describe('buildRegionBasemap', () => {
  // A toy "Eurasia": crosses the antimeridian like Chukotka does, with a
  // vertex inside the EU select box.
  const eurasia = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-179, 66], // beyond 180 (unwraps to 181)
          [-179, 70],
          [100, 70],
          [10, 55], // inside the eu select box
          [100, 40],
          [-179, 66],
        ],
      ],
    },
  }
  it('ships antimeridian-crossing land without wrap jumps', () => {
    const fc = buildRegionBasemap({ features: [eurasia] }, 'eu')
    expect(fc.features).toHaveLength(1)
    for (const ring of fc.features[0].geometry.coordinates) {
      for (let i = 1; i < ring.length; i++) {
        expect(Math.abs(ring[i][0] - ring[i - 1][0])).toBeLessThanOrEqual(180)
      }
      for (const [x] of ring) {
        expect(x).toBeLessThanOrEqual(180)
        expect(x).toBeGreaterThanOrEqual(-35)
      }
    }
  })
  it('drops polygons outside the select box', () => {
    const antarctica = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-60, -75],
            [60, -75],
            [0, -85],
            [-60, -75],
          ],
        ],
      },
    }
    const fc = buildRegionBasemap({ features: [antarctica] }, 'eu')
    expect(fc.features).toHaveLength(0)
  })
})

// ------------------------------------------------- station name de-dup (#6)
describe('phaseKey', () => {
  it('folds the spellings of one phase onto a single key', () => {
    expect(phaseKey('Hornsea 1')).toBe('hornsea 1')
    expect(phaseKey('Hornsea One')).toBe('hornsea 1')
    expect(phaseKey('Hornsea Project One')).toBe('hornsea 1')
    expect(phaseKey('Race Bank Phase 2')).toBe('race bank 2')
    expect(phaseKey('Race Bank II')).toBe('race bank 2')
    expect(phaseKey('  gwynt y  Môr ')).toBe(phaseKey('Gwynt y Mor'))
    // 'Extension' is phase noise in the key; the capacity signature keeps it
    expect(phaseKey('Walney Extension')).toBe(phaseKey('Walney Offshore Windfarm'))
  })
  it('keeps the phase number, so different phases stay apart', () => {
    expect(phaseKey('Hornsea 1')).not.toBe(phaseKey('Hornsea 2'))
    // an umbrella site is not claimed to be phase 2 either
    expect(phaseKey('Race Bank')).not.toBe(phaseKey('Race Bank Phase 2'))
  })
  it('does not fold a trailing letter: Triton Knoll A and B are separate builds', () => {
    expect(phaseKey('Triton Knoll A')).not.toBe(phaseKey('Triton Knoll B'))
  })
  it('gives up when nothing distinctive survives the fold', () => {
    expect(phaseKey('Wind Farm 2')).toBeNull() // → a bare number, not an identity
    expect(phaseKey('')).toBeNull()
    expect(phaseKey(null)).toBeNull()
  })
})

describe('dedupeStations', () => {
  const st = (name, capacityMW, [lon, lat], osmType = 'way', fuel = 'wind_offshore') => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id: `${osmType}/${name}`, name, fuel, capacityMW, osmType },
  })
  const names = (fc) => fc.map((f) => f.properties.name)

  it('collapses one phase spelled three ways, keeping the richest element', () => {
    const out = dedupeStations([
      st('Hornsea One', 1218, [1.79, 53.88], 'way'),
      st('Hornsea 1', null, [1.8, 53.89], 'relation'),
      st('Hornsea Project One', 1218, [1.81, 53.9], 'node'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].properties.name).toBe('Hornsea 1') // relation outranks way/node
    // capacity rule, half one: aliases of a phase are one build, counted once
    expect(out[0].properties.capacityMW).toBe(1218)
  })
  it('collapses "Walney" with "Walney Extension" and sums the two builds', () => {
    const out = dedupeStations([
      st('Walney', 367, [-3.52, 54.05]),
      st('Walney Extension', 659, [-3.6, 54.08]),
    ])
    expect(out).toHaveLength(1)
    // capacity rule, half two: an extension is real extra plant, so the site
    // carries both — a plain max would quietly delete 659 MW
    expect(out[0].properties.capacityMW).toBe(1026)
  })
  it('keeps same-named sites in different regions apart', () => {
    const kent = st('Mill Farm', 10, [1.0, 51.3], 'way', 'wind_onshore')
    const moray = st('Mill Farm', 12, [-3.2, 57.5], 'way', 'wind_onshore')
    expect(names(dedupeStations([kent, moray]))).toEqual(['Mill Farm', 'Mill Farm'])
    // …while a node copy of the Kent one still folds into it
    const out = dedupeStations([
      kent,
      moray,
      st('Mill Farm', 3, [1.01, 51.31], 'node', 'wind_onshore'),
    ])
    expect(out).toHaveLength(2)
    expect(out[0].properties.capacityMW).toBe(10)
  })
  it('keeps different phases, and different fuels at one site, apart', () => {
    expect(
      names(
        dedupeStations([st('Hornsea 1', 1218, [1.79, 53.88]), st('Hornsea 2', 1386, [1.9, 53.95])]),
      ),
    ).toEqual(['Hornsea 1', 'Hornsea 2'])
    // co-located solar + wind under one brand are two stations, not one
    const mixed = dedupeStations([
      st('Kelmarsh Park', 5, [-0.93, 52.4], 'way', 'solar'),
      st('Kelmarsh Park 2', 7, [-0.94, 52.41], 'way', 'wind_onshore'),
    ])
    expect(mixed).toHaveLength(2)
  })
  it('keeps "Drax" and "Drax Bioenergy" apart: an extra real word is a different site', () => {
    // Documented limit of the fold — only phase/variant markers are noise, so
    // a descriptive suffix (unit, technology, operator) still separates two
    // features. Over-merging here would erase a real station's capacity.
    const out = dedupeStations([
      st('Drax', 3906, [-0.99, 53.73], 'relation', 'bioenergy'),
      st('Drax Bioenergy', 660, [-0.99, 53.74], 'way', 'bioenergy'),
    ])
    expect(names(out)).toEqual(['Drax', 'Drax Bioenergy'])
    expect(out.map((f) => f.properties.capacityMW)).toEqual([3906, 660])
  })
  it('requires a phase marker, so generic names never fold on the key alone', () => {
    // tokens() strips generic industry words in every language it knows, so
    // Italy's fifteen "Impianto fotovoltaico" ("PV plant") sites share one
    // key while being fifteen different solar parks. Without the marker rule
    // the neighbours among them would merge. Same story for a dam mapped
    // next to its power station.
    expect(
      dedupeStations([
        st('Impianto fotovoltaico', null, [12.5, 41.9], 'way', 'solar'),
        st('Fotovoltaico', null, [12.51, 41.91], 'way', 'solar'),
      ]),
    ).toHaveLength(2)
    expect(
      dedupeStations([
        st('Centrale de Chaudanne', 23.5, [6.4, 43.8], 'way', 'hydro'),
        st('Barrage de Chaudanne', null, [6.41, 43.81], 'way', 'hydro'),
      ]),
    ).toHaveLength(2)
  })
  it('never folds the nameless-site placeholder', () => {
    const out = dedupeStations([
      st(UNNAMED, 5, [-1, 52], 'node', 'solar'),
      st(UNNAMED, 7, [-1.001, 52.001], 'node', 'solar'),
    ])
    expect(out).toHaveLength(2) // thousands of them share that label
  })
  it('leaves the input features untouched', () => {
    const inputs = [st('Walney', 367, [-3.52, 54.05]), st('Walney Extension', 659, [-3.6, 54.08])]
    dedupeStations(inputs)
    expect(inputs.map((f) => f.properties.capacityMW)).toEqual([367, 659])
  })
  it('lets a known capacity win at equal element rank', () => {
    const out = dedupeStations([
      st('Fallago Rig', null, [-2.7, 55.8], 'way', 'wind_onshore'),
      st('Fallago Rig', 144, [-2.701, 55.801], 'way', 'wind_onshore'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].properties.capacityMW).toBe(144)
  })
})

// ------------------------------------------- loud failures on bad raw data (#15)
describe('readLineFile', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the parsed extract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lines-'))
    writeFileSync(join(dir, 'gb_lines_hv.json'), '{"elements":[{"type":"way","id":1}]}')
    const { data, error } = readLineFile(dir, 'gb_lines_hv.json')
    expect(error).toBeUndefined()
    expect(data.elements).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })
  it('reports a truncated file instead of skipping it in silence (#15)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'lines-'))
    writeFileSync(join(dir, 'gb_lines_hv_s.json'), '{"elements":[{"type":"way"') // download cut off
    const { data, error } = readLineFile(dir, 'gb_lines_hv_s.json')
    expect(data).toBeUndefined()
    expect(error).toBeInstanceOf(Error) // the caller counts these and exits non-zero
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('gb_lines_hv_s.json')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('hasElements', () => {
  it('accepts only a non-empty element array', () => {
    expect(hasElements({ elements: [{ type: 'way' }] })).toBe(true)
    expect(hasElements({ elements: [] })).toBe(false)
    expect(hasElements({})).toBe(false)
    expect(hasElements(null)).toBe(false)
  })
})

describe('fetchOne', () => {
  afterEach(() => vi.restoreAllMocks())

  const ok = (body) => ({ ok: true, text: async () => body })
  const run = (dir, doFetch, mirrors = ['https://a.example/api']) =>
    fetchOne('plants_gb.json', '[out:json];', {
      rawDir: dir,
      mirrors,
      attempts: 2,
      doFetch,
      wait: async () => {},
    })

  it('caches a response that carries elements', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'raw-'))
    const body = '{"elements":[{"type":"node","id":1}]}'
    expect(await run(dir, async () => ok(body))).toBe(true)
    expect(readFileSync(join(dir, 'plants_gb.json'), 'utf8')).toBe(body)
    rmSync(dir, { recursive: true, force: true })
  })
  it('never caches a 200-with-zero-elements answer, and fails the query (#15)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'raw-'))
    let calls = 0
    const result = await run(dir, async () => {
      calls++
      return ok('{"elements":[]}')
    })
    expect(result).toBe(false) // → non-zero exit, not a tick
    expect(existsSync(join(dir, 'plants_gb.json'))).toBe(false)
    expect(calls).toBe(2) // every attempt got its turn instead of stopping at the empty
    expect(warn.mock.calls[0][0]).toContain('0 elements')
    rmSync(dir, { recursive: true, force: true })
  })
  it('lets the next mirror answer after an empty one (#15)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'raw-'))
    const body = '{"elements":[{"type":"way","id":9}]}'
    const doFetch = async (url) => ok(url.includes('busy') ? '{"elements":[]}' : body)
    expect(await run(dir, doFetch, ['https://busy.example/api', 'https://b.example/api'])).toBe(
      true,
    )
    expect(readFileSync(join(dir, 'plants_gb.json'), 'utf8')).toBe(body)
    rmSync(dir, { recursive: true, force: true })
  })
  it('refetches over an empty file left by an older run', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'raw-'))
    writeFileSync(join(dir, 'plants_gb.json'), '{"elements":[]}')
    const body = '{"elements":[{"type":"node","id":2}]}'
    expect(await run(dir, async () => ok(body))).toBe(true)
    expect(readFileSync(join(dir, 'plants_gb.json'), 'utf8')).toBe(body)
    rmSync(dir, { recursive: true, force: true })
  })
})

// OSM chops a circuit into many ways; mergeLines rejoins same-voltage chains
// at degree-2 junctions. It used to rebuild the merged properties with
// `circuits: null` hardcoded, so the tag parsed upstream never survived —
// the property shipped in every bundle and was never once populated.
describe('mergeLines', () => {
  const seg = (coords, props = {}) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { v: 400, name: null, operator: null, circuits: null, ...props },
  })

  it('joins a chain end to end and keeps the agreed circuits count', () => {
    const out = mergeLines([
      seg(
        [
          [0, 0],
          [1, 0],
        ],
        { name: 'Line A', operator: 'NGET', circuits: 2 },
      ),
      seg(
        [
          [1, 0],
          [2, 0],
        ],
        { name: 'Line A', operator: 'NGET', circuits: 2 },
      ),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].geometry.coordinates).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ])
    expect(out[0].properties.circuits).toBe(2)
    expect(out[0].properties.name).toBe('Line A')
  })

  it('drops circuits when the chain disagrees, as it does for name/operator', () => {
    const out = mergeLines([
      seg(
        [
          [0, 0],
          [1, 0],
        ],
        { circuits: 2 },
      ),
      seg(
        [
          [1, 0],
          [2, 0],
        ],
        { circuits: 4 },
      ),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].properties.circuits).toBeNull()
  })

  it('carries a count tagged on only part of the chain', () => {
    // An untagged neighbour is missing data, not a contradiction.
    const out = mergeLines([
      seg(
        [
          [0, 0],
          [1, 0],
        ],
        { circuits: 3 },
      ),
      seg([
        [1, 0],
        [2, 0],
      ]),
    ])
    expect(out[0].properties.circuits).toBe(3)
  })

  it('keeps different voltages apart even when they touch', () => {
    const out = mergeLines([
      seg(
        [
          [0, 0],
          [1, 0],
        ],
        { circuits: 2 },
      ),
      seg(
        [
          [1, 0],
          [2, 0],
        ],
        { v: 275, circuits: 2 },
      ),
    ])
    expect(out).toHaveLength(2)
  })
})
