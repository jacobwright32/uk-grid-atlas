// Country-registry invariants (#61): 22 grids × a dozen hand-typed fields.
// "Added a country, forgot a field / typo'd a domain" should fail here, not
// in production. Cross-checks the client registry against the scripts-side
// ENTSO-E registry so the two can't silently drift apart.
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module without type declarations
import { ENTSOE_COUNTRIES, FLOW_BORDERS } from '../../scripts/entsoe.mjs'
import { COUNTRIES, DEFAULT_COUNTRY, hashFor, parseHash, REAL_COUNTRY_IDS } from './countries'

const entries = Object.entries(COUNTRIES)

describe('COUNTRIES registry', () => {
  it('keys, ids and REAL_COUNTRY_IDS agree', () => {
    for (const [key, cfg] of entries) expect(cfg.id).toBe(key)
    expect(Object.keys(COUNTRIES).sort()).toEqual([...REAL_COUNTRY_IDS, 'all'].sort())
  })
  it('every entry carries its copy fields', () => {
    for (const [key, cfg] of entries) {
      expect(cfg.name, key).toBeTruthy()
      expect(cfg.flag, key).toBeTruthy()
      expect(cfg.tagline, key).toBeTruthy()
      // GB's live copy lives in the Elexon-specific sidebar; snapshot-fed
      // countries must explain their data source here.
      if (cfg.liveKind === 'entsoe') expect(cfg.liveNote, key).toBeTruthy()
    }
  })
  it('bounds are sane [[w,s],[e,n]] boxes', () => {
    for (const [key, cfg] of entries) {
      const [[w, s], [e, n]] = cfg.bounds
      expect(w, key).toBeLessThan(e)
      expect(s, key).toBeLessThan(n)
      expect(w, key).toBeGreaterThanOrEqual(-180)
      expect(e, key).toBeLessThanOrEqual(180)
      expect(s, key).toBeGreaterThanOrEqual(-60)
      expect(n, key).toBeLessThanOrEqual(85)
    }
  })
  it('exactly three voltage tiers, each kV class in one tier only', () => {
    for (const [key, cfg] of entries) {
      expect(cfg.tiers, key).toHaveLength(3)
      const all = cfg.tiers.flatMap((t) => t.kvs)
      expect(new Set(all).size, `${key} duplicates a kV class across tiers`).toBe(all.length)
      for (const kv of all) expect(kv, key).toBeGreaterThan(0)
      // The third tier may be empty (380/220-only grids) — but a tier that
      // carries kV classes needs a legend label.
      for (const t of cfg.tiers) if (t.kvs.length) expect(t.label, key).toBeTruthy()
    }
  })
  it('live wiring is consistent (hasLive ⇒ a real pipeline)', () => {
    for (const [key, cfg] of entries) {
      if (cfg.hasLive) expect(cfg.liveKind, key).not.toBe('none')
      if (cfg.liveKind === 'elexon') expect(key).toBe('gb')
    }
  })
})

describe('hash permalinks (#22)', () => {
  it('parses country-only hashes as before', () => {
    expect(parseHash('#fi')).toEqual({ country: 'fi', station: null })
    expect(parseHash('#FI')).toEqual({ country: 'fi', station: null })
    expect(parseHash('')).toEqual({ country: DEFAULT_COUNTRY, station: null })
    expect(parseHash('#nope')).toEqual({ country: DEFAULT_COUNTRY, station: null })
  })
  it('parses station deep links, keeping the slash inside OSM ids', () => {
    expect(parseHash('#fi/station/way/653307622')).toEqual({
      country: 'fi',
      station: 'way/653307622',
    })
    expect(parseHash('#ca/station/node/12345')).toEqual({ country: 'ca', station: 'node/12345' })
    expect(parseHash('#all/station/way/1')).toEqual({ country: 'all', station: 'way/1' })
  })
  it('ignores malformed station segments', () => {
    expect(parseHash('#fi/station/')).toEqual({ country: 'fi', station: null })
    expect(parseHash('#fi/nonsense/way/1')).toEqual({ country: 'fi', station: null })
    expect(parseHash('#nope/station/way/1').station).toBeNull() // junk country
  })
  it('hashFor round-trips through parseHash', () => {
    expect(parseHash(hashFor('fi', 'way/653307622'))).toEqual({
      country: 'fi',
      station: 'way/653307622',
    })
    expect(hashFor(DEFAULT_COUNTRY, null)).toBe('')
    expect(hashFor('fi', null)).toBe('#fi')
  })
})

describe('client ↔ scripts registries', () => {
  it('every ENTSO-E-fed country has an ENTSOE_COUNTRIES config', () => {
    for (const [key, cfg] of entries) {
      if (cfg.liveKind !== 'entsoe' || key === 'all') continue
      if (key === 'us' || key === 'ca') continue // IESO/ERCOT bake the same shape
      expect(ENTSOE_COUNTRIES[key], `${key} missing from scripts/entsoe.mjs`).toBeTruthy()
    }
  })
  it('every scripts-side ENTSO-E country exists on the map', () => {
    for (const cc of Object.keys(ENTSOE_COUNTRIES)) {
      expect(COUNTRIES[cc as keyof typeof COUNTRIES], cc).toBeTruthy()
    }
  })
  it('every FLOW_BORDERS country is an ENTSO-E country', () => {
    for (const border of FLOW_BORDERS) {
      for (const cc of border.countries) {
        expect(ENTSOE_COUNTRIES[cc], `border ${border.links.join(',')} → ${cc}`).toBeTruthy()
      }
    }
  })
})
