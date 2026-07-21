import { GROUPS, FUEL_TO_GROUP } from './fuels'
import type { GroupId, StationsFC } from './types'

export function allGroupIds(): Set<GroupId> {
  return new Set(GROUPS.map((g) => g.id))
}

/** MapLibre filter expression showing only stations in the enabled groups. */
export function stationFilter(enabled: ReadonlySet<GroupId>): unknown[] {
  const fuels: string[] = []
  for (const g of GROUPS) if (enabled.has(g.id)) fuels.push(...g.fuels)
  return ['in', ['get', 'fuel'], ['literal', fuels]]
}

export interface GroupStats {
  count: number
  capacityMW: number
  /** Sites whose capacity is unknown (excluded from capacityMW). */
  unknownCapacity: number
}

export type StatsByGroup = Map<GroupId, GroupStats>

/** Aggregate station count + known capacity per display group. */
export function computeStats(stations: StationsFC): StatsByGroup {
  const stats: StatsByGroup = new Map()
  for (const g of GROUPS) stats.set(g.id, { count: 0, capacityMW: 0, unknownCapacity: 0 })
  for (const f of stations.features) {
    const group = FUEL_TO_GROUP.get(f.properties.fuel) ?? 'other'
    const s = stats.get(group)
    if (!s) continue
    s.count += 1
    if (f.properties.capacityMW != null) s.capacityMW += f.properties.capacityMW
    else s.unknownCapacity += 1
  }
  return stats
}

export function totalsFor(stats: StatsByGroup, enabled: ReadonlySet<GroupId>): GroupStats {
  const out: GroupStats = { count: 0, capacityMW: 0, unknownCapacity: 0 }
  for (const [id, s] of stats) {
    if (!enabled.has(id)) continue
    out.count += s.count
    out.capacityMW += s.capacityMW
    out.unknownCapacity += s.unknownCapacity
  }
  return out
}
