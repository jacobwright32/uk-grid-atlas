/**
 * Coverage surface (#96): read every baked live + history file and emit
 * public/live/coverage.json — a machine-readable statement of what each grid
 * actually publishes, measured from the files rather than promised by docs.
 * The sidebar's "published data" block and the python package's
 * weg.coverage() both read this one contract.
 *
 *   node scripts/build-coverage.mjs
 *
 * Runs at the end of every live-snapshots workflow bake, so the claims are
 * exactly as fresh as the data they describe.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIVE_DIR = join(process.cwd(), 'public', 'live')
const HISTORY_DIR = join(LIVE_DIR, 'history')

/** Grids whose live layer runs in the browser instead of a baked snapshot. */
const BROWSER_LIVE = new Set(['gb'])

const someValue = (series) => (series ?? []).some((v) => v != null)

/**
 * Coverage of one grid, measured from its parsed snapshot + history files
 * (either may be null). Pure — unit-tested directly.
 */
export function coverageForGrid(cc, snapshot, history) {
  const out = {
    // What pipeline the figures come from ("ENTSO-E" is the default label).
    source: snapshot?.sourceLabel ?? (BROWSER_LIVE.has(cc) ? 'Elexon' : 'ENTSO-E'),
    snapshot: snapshot != null,
    browserLive: BROWSER_LIVE.has(cc),
    generatedAt: snapshot?.generatedAt ?? null,
    meteredDate: snapshot?.date ?? null,
    /** Stations with any live per-unit output in the snapshot. */
    perStationLive: Object.entries(snapshot?.perStation ?? {}).filter(([, day]) =>
      someValue(day?.series),
    ).length,
    /** Today-so-far block present (#18). */
    intraday: snapshot?.today != null,
    // "Published" means anywhere in the feed — snapshot OR history. GB has
    // no snapshot file yet 31 priced days; "not published" would be a lie.
    prices:
      someValue(snapshot?.prices?.series) ||
      someValue(snapshot?.today?.prices?.series) ||
      (history?.days ?? []).some((d) => d.price != null),
    demand:
      someValue(snapshot?.demandSeries) ||
      someValue(snapshot?.today?.demandSeries) ||
      (history?.days ?? []).some((d) => d.demandMW != null),
    /**
     * Trade measurement: 'net' = A11 over every border (#93), 'hvdc' =
     * mapped links only, 'none' = nothing measured.
     */
    flows: someValue(snapshot?.netImportSeries)
      ? 'net'
      : someValue(snapshot?.importSeries)
        ? 'hvdc'
        : 'none',
    /** Mapped HVDC links with per-link series. */
    links: Object.keys(snapshot?.flowSeries ?? {}).length,
    historyDays: history?.days?.length ?? 0,
    hourlyDays: history?.hourly?.length ?? 0,
    /** Hourly days carrying per-station series (the station-dot scrub). */
    perStationHistoryDays: (history?.hourly ?? []).filter(
      (h) => Object.keys(h.perStation ?? {}).length > 0,
    ).length,
    priceDays: (history?.days ?? []).filter((d) => d.price != null).length,
    demandDays: (history?.days ?? []).filter((d) => d.demandMW != null).length,
    currency: history?.currency ?? null,
  }
  // GB's per-station live is fetched by the browser from Elexon directly —
  // count it as live coverage even though no snapshot file exists.
  if (BROWSER_LIVE.has(cc)) {
    out.intraday = true // FUELINST is instantaneous by nature
    out.flows = 'net' // an island's interconnectors are its borders
  }
  return out
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function buildCoverage() {
  // History is the universal set: every grid has one, GB included.
  const ccs = readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .sort()
  const grids = {}
  for (const cc of ccs) {
    const snapshot = readJSON(join(LIVE_DIR, `${cc}.json`))
    const history = readJSON(join(HISTORY_DIR, `${cc}.json`))
    grids[cc] = coverageForGrid(cc, snapshot, history)
  }
  return { version: 1, generatedAt: new Date().toISOString(), grids }
}

// Entry point — skipped under vitest import.
if (process.argv[1] && process.argv[1].endsWith('build-coverage.mjs')) {
  const coverage = buildCoverage()
  const path = join(LIVE_DIR, 'coverage.json')
  writeFileSync(path, JSON.stringify(coverage, null, 1) + '\n')
  const n = Object.keys(coverage.grids).length
  const nets = Object.values(coverage.grids).filter((g) => g.flows === 'net').length
  console.log(`coverage.json: ${n} grids · ${nets} with net trade measured`)
}
