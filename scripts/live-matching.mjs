/** Pure helpers for BMU → station matching (import-safe for tests). */

const WORD_NUMBERS = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
}

// Note: 'battery'/'storage' stay meaningful — they distinguish co-located
// BESS units from the wind farm they share a name with.
const STOPWORDS = new Set([
  'wind', 'farm', 'windfarm', 'offshore', 'onshore', 'power', 'station', 'plant',
  'generator', 'generating', 'generation', 'unit', 'module', 'gt', 'ccgt', 'ocgt',
  'no', 'ltd', 'limited', 'project', 'energy', 'park',
  'psh', 'scheme', 'the', 'bmu', 'export', 'osp', 'ospe', 'ospw',
])

/** Normalise a free-text unit/station name into a token set. */
export function tokens(name) {
  if (!name) return []
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => WORD_NUMBERS[t] ?? t)
    .filter((t) => t && !STOPWORDS.has(t))
}

/** Drop trailing unit designators like "2", "gt51", "a" from BMU name tokens. */
export function stemTokens(toks) {
  const out = [...toks]
  while (out.length > 1) {
    const last = out[out.length - 1]
    if (/^\d{1,2}$/.test(last) || /^[a-z]$/.test(last) || /^(gt|st)?\d+[a-z]?$/.test(last)) out.pop()
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
    'storage', 'gas', 'bioenergy', 'waste', 'oil', 'other', 'marine', 'hydro',
    'solar', 'wind_offshore', 'wind_onshore', 'pumped',
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
