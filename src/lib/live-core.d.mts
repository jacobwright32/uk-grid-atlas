/** Types for live-core.mjs (shared browser/node aggregation). */

export interface B1610Row {
  bmUnit: string
  settlementPeriod: number
  /** MWh per half-hour */
  quantity: number
}

export interface PNRow {
  bmUnit: string
  timeFrom: string
  timeTo: string
  levelFrom: number
  levelTo: number
}

export interface StationDay {
  /** 48 half-hour average-MW values; null where unreported. */
  series: (number | null)[]
  periods: number
  avgMW: number
  peakMW: number
  energyGWh: number
}

export interface MixFuel {
  key: string
  label: string
  mw: number
}

export interface MixSnapshot {
  time: string
  fuels: MixFuel[]
  interconnectors: Record<string, number>
  totalMW: number
  importMW: number
}

export declare const MWH_HH_TO_MW: number
export declare const INT_TO_IC: Record<string, string>
export declare const MIX_FUELS: [string, string][]

export declare function aggregateDay(
  rows: B1610Row[],
  byUnit: Record<string, string>,
): Map<string, StationDay>

export declare function aggregatePN(
  rows: PNRow[],
  byUnit: Record<string, string>,
): Map<string, number>

export declare function parseOutturn(payload: unknown): MixSnapshot | null

export interface MixDaySeries {
  /** FUELINST fuelType → 48 half-hourly MW values (null = no reading). */
  fuels: Record<string, (number | null)[]>
  imports: (number | null)[]
}

export declare function parseOutturnDay(payload: unknown): MixDaySeries | null

export declare function currentSettlement(now?: Date): {
  settlementDate: string
  settlementPeriod: number
}

export declare function daysBefore(isoDate: string, n: number): string

export declare function chunk<T>(arr: T[], size: number): T[][]
