/** Pure helpers for BMU → station matching (import-safe for tests). */

const WORD_NUMBERS = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  // Roman numerals and "St" — ENTSO-E writes "ROEDSAND 2" / "ST ALBAN"
  // where OSM has "Rødsand II" / "Saint-Alban".
  ii: '2',
  iii: '3',
  iv: '4',
  st: 'saint',
}

// Note: 'battery'/'storage' stay meaningful — they distinguish co-located
// BESS units from the wind farm they share a name with.
const STOPWORDS = new Set([
  'wind',
  'farm',
  'windfarm',
  'offshore',
  'onshore',
  'power',
  'station',
  'plant',
  'plants',
  'generator',
  'generating',
  'generation',
  'unit',
  'module',
  'gt',
  'ccgt',
  'ocgt',
  'no',
  'ltd',
  'limited',
  'project',
  'energy',
  'park',
  'psh',
  'scheme',
  'the',
  'bmu',
  'export',
  'osp',
  'ospe',
  'ospw',
  'and',
  // French — "Centre Nucléaire de Production d'Electricité de Paluel" → "paluel"
  'centre',
  'centrale',
  'nucleaire',
  'production',
  'electricite',
  'd',
  'l',
  'de',
  'du',
  'des',
  'en',
  'sur',
  'la',
  'le',
  'les',
  'tranche',
  'groupe',
  'thermique',
  'electrique',
  'photovoltaique',
  'eolien',
  'parc',
  'barrage',
  'usine',
  'hydroelectrique',
  'amenagement',
  'turbine',
  'combustion',
  'tac',
  'ccg',
  // German — "Kraftwerk Duisburg-Walsum" → "duisburg walsum"
  'kraftwerk',
  'grosskraftwerk',
  'heizkraftwerk',
  'blockheizkraftwerk',
  'kernkraftwerk',
  'dampfkraftwerk',
  'kohlekraftwerk',
  'steinkohlekraftwerk',
  'braunkohlekraftwerk',
  'wasserkraftwerk',
  'gasturbinenkraftwerk',
  'pumpspeicherkraftwerk',
  'pumpspeicherwerk',
  'kavernenkraftwerk',
  // Austrian / Swiss compounds — "Donaukraftwerk Ybbs", "Laufkraftwerk ..."
  'donaukraftwerk',
  'laufkraftwerk',
  'speicherkraftwerk',
  'flusskraftwerk',
  'murkraftwerk',
  'zentrale',
  // Czech — "Elektrárna Temelín", "Teplárna Trmice" (accent-folded forms)
  'elektrarna',
  'teplarna',
  'vodni',
  'jaderna',
  'tepelna',
  'paroplynova',
  'precerpavaci',
  'spalovna',
  'kw',
  'hkw',
  'gthkw',
  'psw',
  'pss',
  'gud',
  'block',
  'gesamt',
  'und',
  'am',
  'im',
  'an',
  // Dutch / Belgian — "Kerncentrale Borssele", "Centrale TGV Seraing", "RINGVAART STEG"
  'kerncentrale',
  'elektriciteitscentrale',
  'steg',
  'tgv',
  'blok',
  'van',
  'der',
  'den',
  'het',
  // Danish — "Anholt Havmøllepark", "Kassø Solcellepark"
  'havmoellepark',
  'solcellepark',
  'solarpark',
  // Norwegian / Swedish — "Kvilldal kraftverk", "Forsmarks Kärnkraftverk"
  'kraftverk',
  'kraftstasjon',
  'pumpekraftverk',
  'vannkraftverk',
  'vindkraftverk',
  'vindpark',
  'kraftvaerk',
  'kaernkraftverk',
  'vattenkraftverk',
  'kraftvaermeverk',
  'vindkraftpark',
  // Polish — "Elektrownia Bełchatów", "EC Żerań" (CHP), "BGP Włocławek" (CCGT block)
  'elektrownia',
  'elektrocieplownia',
  'ec',
  'bgp',
  'farma',
  'wiatrowa',
  // Spanish — "Central nuclear de Almaraz", "Central Térmica de Castellón"
  'central',
  'nuclear',
  'termica',
  'hidroelectrica',
  'ciclo',
  'combinado',
  // Finnish — "Olkiluodon ydinvoimalaitos", "Imatran vesivoimalaitos"
  'voimalaitos',
  'voimala',
  'vesivoimalaitos',
  'ydinvoimalaitos',
  'tuulipuisto',
  'tuulivoimapuisto',
  // Estonian / Latvian / Lithuanian - Eesti Elektrijaam, Plavinu HES,
  // Kruonio hidroakumuliacine elektrine (accent-folded forms)
  'elektrijaam',
  'soojuselektrijaam',
  'huedroelektrijaam',
  'koostootmisjaam',
  'tuulepark',
  'elektrostacija',
  'hidroelektrostacija',
  'termoelektrocentrale',
  'hes',
  'tec',
  'elektrine',
  'hidroelektrine',
  'hidroakumuliacine',
  'termofikacine',
  'kondensacine',
  'vejo',
  'parkas',
  // Portuguese — "Central termoeléctrica", "Barragem do Alqueva", "Aproveitamento Hidroeléctrico"
  'termoelectrica',
  'barragem',
  'aproveitamento',
  'do',
  'da',
  'dos',
  'das',
  // Italian — "Centrale termoelettrica di Torrevaldaliga Nord"
  'termoelettrica',
  'idroelettrica',
  'nucleare',
  'elettrica',
  'impianto',
  'diga',
  'di',
  // Corporate suffixes that ENTSO-E unit names sometimes carry
  'sa',
  'ag',
  'gmbh',
  'bv',
  'nv',
])

// ENTSO-E spells Germanic/Nordic letters out ("Luenen", "Roedsand",
// "Skaerbaekvaerket"); OSM uses the native forms. Fold both sides the same.
const TRANSLIT = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', æ: 'ae', ø: 'oe', å: 'aa', ł: 'l' }

function fold(s) {
  return s
    .replace(/[äöüßæøåł]/g, (c) => TRANSLIT[c])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remaining accents: é è ç î …
}

/** Normalise a free-text unit/station name into a token set. */
export function tokens(name) {
  if (!name) return []
  return (
    fold(name.toLowerCase())
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map((t) => WORD_NUMBERS[t] ?? t)
      // Dutch glues the generic suffix on: Clauscentrale / Amercentrale → claus / amer
      .map((t) =>
        t.length > 'centrale'.length && t.endsWith('centrale') ? t.slice(0, -'centrale'.length) : t,
      )
      .filter((t) => t && !STOPWORDS.has(t))
  )
}

/** Drop trailing unit designators like "2", "gt51", "a" from BMU name tokens. */
export function stemTokens(toks) {
  const out = [...toks]
  while (out.length > 1) {
    const last = out[out.length - 1]
    if (/^\d{1,2}$/.test(last) || /^[a-z]$/.test(last) || /^(gt|st|g|b)?\d+[a-z]?$/.test(last))
      out.pop()
    else break
  }
  return out
}

export function jaccard(a, b) {
  if (!a.length || !b.length) return 0
  const A = new Set(a)
  const B = new Set(b)
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/** BMU fuelType → compatible station display fuels. */
export const COMPAT = {
  NUCLEAR: ['nuclear'],
  CCGT: ['gas'],
  OCGT: ['gas', 'oil'],
  WIND: ['wind_offshore', 'wind_onshore'],
  PS: ['pumped', 'hydro'],
  NPSHYD: ['hydro', 'pumped'],
  BIOMASS: ['bioenergy', 'waste', 'gas'],
  COAL: ['bioenergy', 'coal', 'other'],
  OIL: ['oil', 'gas'],
  // A *declared* OTHER (and a missing fuelType, which Elexon leaves off plenty
  // of embedded units) covers batteries, new offshore wind registrations (e.g.
  // Sofia pre-classification), tidal, CHP oddities — allow broadly. Codes the
  // table has never heard of do NOT get this list; see compatFuels (#11).
  OTHER: [
    'storage',
    'gas',
    'bioenergy',
    'waste',
    'oil',
    'other',
    'marine',
    'hydro',
    'solar',
    'wind_offshore',
    'wind_onshore',
    'pumped',
  ],
}

/** Name-score floor when the fuel gate is a confident single-fuel one. */
export const MIN_SCORE = 0.55

/**
 * Name-score floor when the fuel gate does almost no work — the broad
 * OTHER list. The name then carries the whole decision, so demand a
 * near-exact overlap: 0.7 rejects the "one shared locality word" band
 * (1-of-2 = 0.5, 2-of-3 = 0.67) and admits 3-of-4 = 0.75 and up (#11).
 */
export const BROAD_MIN_SCORE = 0.7

/** Runner-up this close to the winner = ambiguous match, worth a QA look (#11). */
export const NEAR_TIE_DELTA = 0.05

/**
 * Warn-once tally for unrecognised type codes (#11). Silence is how a new
 * Elexon/ENTSO-E code degrades a whole run unnoticed; one line per distinct
 * code is enough to notice without spamming a several-thousand-unit loop.
 */
export function makeUnknownCodeTally(label) {
  const counts = new Map()
  return {
    note(code) {
      const seen = counts.get(code) ?? 0
      counts.set(code, seen + 1)
      if (!seen)
        console.warn(`${label}: unrecognised code ${JSON.stringify(code)} — not matched (#11)`)
    },
    /** {CODE: attempts}, commonest first — goes into the run's match report. */
    counts: () => Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])),
    reset: () => counts.clear(),
  }
}

const unknownFuels = makeUnknownCodeTally('bmu fuelType')

/** Unrecognised BMU fuelTypes seen so far this run → match attempts (#11). */
export function unknownFuelCounts() {
  return unknownFuels.counts()
}

/** Clear the unrecognised-fuelType tally (per-run scripts, tests). */
export function resetUnknownFuels() {
  unknownFuels.reset()
}

/** Fuels whose allow-list is broad enough that the name must carry the match. */
export function isBroadFuel(bmuFuel) {
  return bmuFuel == null || bmuFuel === 'OTHER'
}

/**
 * Station fuels a BMU fuelType may match. A declared OTHER (or an absent
 * fuelType) keeps the broad list; a code the table has never heard of —
 * 'B20', a typo, a newly-introduced Elexon code — gets nothing instead of
 * silently inheriting 12 of 13 fuels. It lands in the unmatched QA list,
 * where an OVERRIDE (or a new COMPAT row) can place it deliberately (#11).
 */
export function compatFuels(bmuFuel) {
  if (isBroadFuel(bmuFuel)) return COMPAT.OTHER
  const list = COMPAT[bmuFuel]
  if (list) return list
  unknownFuels.note(bmuFuel)
  return []
}

export function compatible(bmuFuel, stationFuel) {
  return compatFuels(bmuFuel).includes(stationFuel)
}

/** True when the runner-up scored within NEAR_TIE_DELTA of the winner (#11). */
export function isNearTie(match) {
  if (!match?.runnerUp) return false
  return match.score - match.runnerUp.score <= NEAR_TIE_DELTA
}

/**
 * Match one BMU against the station index. Broad-list fuels must clear
 * BROAD_MIN_SCORE, unrecognised fuels never match at all (#11). The runner-up
 * rides along so callers can flag ambiguous wins — see isNearTie.
 * @returns {{stationId: string, score: number, runnerUp: {stationId: string, score: number} | null} | null}
 */
export function matchUnit(bmu, stationIndex) {
  const fuels = compatFuels(bmu.fuelType)
  if (!fuels.length) return null
  const floor = isBroadFuel(bmu.fuelType) ? BROAD_MIN_SCORE : MIN_SCORE
  const unitToks = tokens(bmu.bmUnitName)
  const stem = stemTokens(unitToks)
  let best = null
  let runnerUp = null
  for (const st of stationIndex) {
    if (!fuels.includes(st.fuel)) continue
    const score = Math.max(jaccard(unitToks, st.toks), jaccard(stem, st.toks))
    if (score <= 0) continue
    // best is always >= runnerUp, so a new winner demotes the old one
    if (!best || score > best.score) {
      runnerUp = best
      best = { stationId: st.id, score }
    } else if (!runnerUp || score > runnerUp.score) runnerUp = { stationId: st.id, score }
  }
  // The runner-up may sit just under the floor — that is still the ambiguity
  // worth reporting, so it survives the floor check on the winner.
  if (!best || best.score < floor) return null
  return { ...best, runnerUp }
}
