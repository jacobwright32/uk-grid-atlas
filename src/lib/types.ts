import type { FeatureCollection, LineString, Point } from 'geojson'

/** Granular fuel identifiers emitted by the data pipeline. */
export type FuelId =
  | 'gas'
  | 'nuclear'
  | 'wind_offshore'
  | 'wind_onshore'
  | 'solar'
  | 'hydro'
  | 'pumped'
  | 'marine'
  | 'bioenergy'
  | 'waste'
  | 'storage'
  | 'oil'
  | 'coal'
  | 'other'

/** Display groups — what the legend/filters operate on. */
export type GroupId =
  | 'wind_offshore'
  | 'wind_onshore'
  | 'solar'
  | 'gas'
  | 'nuclear'
  | 'hydro'
  | 'bioenergy'
  | 'storage'
  | 'oil'
  | 'other'

export interface StationProps {
  id: string
  name: string
  fuel: FuelId
  source: string | null
  method: string | null
  capacityMW: number | null
  operator: string | null
  start: string | null
  osmType: 'node' | 'way' | 'relation'
}

export interface LineProps {
  /** Voltage class in kV. */
  v: 400 | 275 | 132
  name: string | null
  operator: string | null
  circuits: number | null
}

export interface InterconnectorProps {
  id: string
  name: string
  to: string
  capMW: number
  year: number
  kv: number
  kind: 'interconnector' | 'reinforcement'
  status: 'operational' | 'construction'
}

export type StationsFC = FeatureCollection<Point, StationProps>
export type LinesFC = FeatureCollection<LineString, LineProps>
export type InterconnectorsFC = FeatureCollection<LineString, InterconnectorProps>

export interface GridMeta {
  generated: string
  stationCount: number
  lineCount: number
  attribution: string
}

export interface GridData {
  stations: StationsFC
  transmission: LinesFC
  interconnectors: InterconnectorsFC
  basemap: FeatureCollection
  meta: GridMeta
}

export interface NetworkToggles {
  v400: boolean
  v275: boolean
  v132: boolean
  hvdc: boolean
  construction: boolean
}
