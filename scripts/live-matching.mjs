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
  // OTHER / null covers batteries, new offshore wind registrations (e.g.
  // Sofia pre-classification), tidal, CHP oddities — allow broadly.
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

export function compatible(bmuFuel, stationFuel) {
  const list = COMPAT[bmuFuel ?? 'OTHER'] ?? COMPAT.OTHER
  return list.includes(stationFuel)
}

/**
 * Match one BMU against the station index.
 * @returns {{stationId: string, score: number} | null}
 */
export function matchUnit(bmu, stationIndex) {
  const unitToks = tokens(bmu.bmUnitName)
  const stem = stemTokens(unitToks)
  let best = null
  for (const st of stationIndex) {
    if (!compatible(bmu.fuelType, st.fuel)) continue
    const score = Math.max(jaccard(unitToks, st.toks), jaccard(stem, st.toks))
    if (score >= 0.55 && (!best || score > best.score)) best = { stationId: st.id, score }
  }
  return best
}
