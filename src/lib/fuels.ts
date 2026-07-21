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
  { id: 'hydro', label: 'Hydro · pumped · tidal', color: '#1899ac', fuels: ['hydro', 'pumped', 'marine'] },
  { id: 'bioenergy', label: 'Bioenergy & waste', color: '#d95926', fuels: ['bioenergy', 'waste'] },
  { id: 'coal', label: 'Coal', color: '#8a8a85', fuels: ['coal'] },
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
  other: 'Other',
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
