import type { FuelId, GroupId } from './types'

/**
 * Colour system.
 *
 * The eight primary hues are the validated dark-mode categorical slots from
 * the design reference palette (surface #1a1a19): they pass the lightness
 * band, chroma floor and ≥3:1 contrast checks as a set. Hydro cyan is an
 * additional in-band step. With ten identity colours on one map an all-pairs
 * CVD guarantee is mathematically unreachable, so identity is never carried
 * by colour alone — every mark has a hover card naming its fuel, the legend
 * is always on screen, and per-fuel filters act as on-demand faceting.
 * Pumped-storage sites additionally carry a white ring (secondary encoding).
 */
export const GROUPS: {
  id: GroupId
  label: string
  color: string
  fuels: FuelId[]
}[] = [
  { id: 'wind_offshore', label: 'Wind · offshore', color: '#199e70', fuels: ['wind_offshore'] },
  { id: 'wind_onshore', label: 'Wind · onshore', color: '#008300', fuels: ['wind_onshore'] },
  { id: 'solar', label: 'Solar', color: '#c98500', fuels: ['solar'] },
  { id: 'gas', label: 'Gas', color: '#3987e5', fuels: ['gas'] },
  { id: 'nuclear', label: 'Nuclear', color: '#9085e9', fuels: ['nuclear'] },
  {
    id: 'hydro',
    label: 'Hydro · pumped · tidal',
    color: '#1899ac',
    fuels: ['hydro', 'pumped', 'marine'],
  },
  { id: 'bioenergy', label: 'Bioenergy & waste', color: '#d95926', fuels: ['bioenergy', 'waste'] },
  { id: 'geothermal', label: 'Geothermal', color: '#bd5fd1', fuels: ['geothermal'] },
  { id: 'coal', label: 'Coal', color: '#ad7a45', fuels: ['coal'] },
  { id: 'storage', label: 'Battery storage', color: '#d55181', fuels: ['storage'] },
  { id: 'oil', label: 'Oil & diesel', color: '#e66767', fuels: ['oil'] },
  { id: 'other', label: 'Other / unknown', color: '#6f6d66', fuels: ['other'] },
]

export const GROUP_BY_ID: ReadonlyMap<GroupId, (typeof GROUPS)[number]> = new Map(
  GROUPS.map((g) => [g.id, g]),
)

export const FUEL_TO_GROUP: ReadonlyMap<FuelId, GroupId> = new Map(
  GROUPS.flatMap((g) => g.fuels.map((f) => [f, g.id] as const)),
)

export const FUEL_COLOR: ReadonlyMap<FuelId, string> = new Map(
  GROUPS.flatMap((g) => g.fuels.map((f) => [f, g.color] as const)),
)

/** Human label for the granular fuel shown on hover cards. */
export const FUEL_LABEL: Record<FuelId, string> = {
  gas: 'Gas',
  nuclear: 'Nuclear',
  wind_offshore: 'Wind (offshore)',
  wind_onshore: 'Wind (onshore)',
  solar: 'Solar PV',
  hydro: 'Hydro',
  pumped: 'Pumped-storage hydro',
  marine: 'Tidal / marine',
  bioenergy: 'Bioenergy',
  waste: 'Energy from waste',
  storage: 'Battery / storage',
  oil: 'Oil & diesel',
  coal: 'Coal',
  geothermal: 'Geothermal',
  other: 'Other',
}

/**
 * The slice of OSM's `plant:method` worth putting on a card.
 *
 * 47,891 of the 60,183 stations carry a method, but most of them only restate
 * the fuel: 34,695 `solar photovoltaic`, 4,717 `combustion` across the five
 * thermal fuels, 1,724 `wind_turbine`, 104 `nuclear fission`. Rendering the raw
 * tag would append a redundant clause to three quarters of the cards.
 *
 * What's left is behavioural, and it is mostly hydro: 3,213 run-of-river sites
 * (non-dispatchable — they take what the river gives) against 1,685 reservoir
 * sites (dispatchable). That is the most useful thing on this map that the fuel
 * label cannot say, and until now it was sitting unread in every bundle. Then
 * 1,189 anaerobic-digestion bioenergy plants, 155 concentrating solar (a
 * different machine from PV), and single figures of tidal, gasification and CHP.
 *
 * Allowlist rather than denylist, for two reasons. The long tail of 73 distinct
 * fuel/method pairs is largely typos and mis-tags — `průběh_řekyw`,
 * `batteriespeicher`, `gas turbine`, `hydro | combustion` — and an allowlist
 * renders none of it without needing to enumerate the garbage. And each entry
 * is gated on fuel, so a value that is informative for one fuel can't leak into
 * another: `thermal` means concentrating solar on a solar plant and nothing
 * worth saying on the five gas plants that also claim it.
 */
export const METHOD_RULES: Record<string, { label: string; fuels: readonly FuelId[] }> = {
  'run-of-the-river': { label: 'run-of-river', fuels: ['hydro'] },
  'water-storage': { label: 'reservoir', fuels: ['hydro'] },
  barrage: { label: 'tidal barrage', fuels: ['hydro', 'marine'] },
  stream: { label: 'tidal stream', fuels: ['marine'] },
  anaerobic_digestion: { label: 'anaerobic digestion', fuels: ['bioenergy', 'waste'] },
  gasification: { label: 'gasification', fuels: ['bioenergy', 'waste'] },
  thermal: { label: 'concentrating', fuels: ['solar'] },
  cogeneration: { label: 'CHP', fuels: ['gas', 'bioenergy', 'waste', 'coal', 'oil'] },
  combined_cycle: { label: 'combined cycle', fuels: ['gas'] },
}

/**
 * Qualifier for a station's fuel label, or null when the tag says nothing new.
 *
 * OSM packs multiple methods into one value with `;` (and occasionally `/`), so
 * a mixed scheme tagged `water-storage;run-of-the-river` reads back as
 * "reservoir + run-of-river". Unrecognised tokens are dropped silently rather
 * than passed through: a card is not the place to surface a tagging error.
 */
export function methodLabel(fuel: FuelId, method?: string | null): string | null {
  if (!method) return null
  const out: string[] = []
  for (const raw of method.split(/[;/]/)) {
    const rule = METHOD_RULES[raw.trim().toLowerCase().replace(/\s+/g, '_')]
    if (!rule || !rule.fuels.includes(fuel)) continue
    if (!out.includes(rule.label)) out.push(rule.label)
  }
  return out.length ? out.join(' + ') : null
}

/** Line-tier colours: brightest = backbone, dimmest = regional. */
export const TIER_COLORS = ['#e8e6df', '#a8a69d', '#6f6d66'] as const

/** MapLibre `match` expression mapping granular fuel → colour. */
export function fuelColorExpression(): unknown[] {
  const expr: unknown[] = ['match', ['get', 'fuel']]
  for (const [fuel, color] of FUEL_COLOR) expr.push(fuel, color)
  expr.push('#898781')
  return expr
}

/** Network line colours (neutral hierarchy so stations carry the hue). */
export const LINE_COLORS = {
  v400: '#e8e6df',
  v275: '#a8a69d',
  v132: '#6f6d66',
  hvdc: '#2dd4bf',
} as const
