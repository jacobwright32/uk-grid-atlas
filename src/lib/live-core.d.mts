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
  /** 46 | 48 | 50 half-hour average-MW values; null where unreported (#5). */
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

/** Settlement periods in a GB day: 50 on the October clocks-back day, 46 on
 *  the March clocks-forward day, 48 otherwise (#5). */
export declare function periodsInDay(date: string): 46 | 48 | 50

/** UTC instant of the Europe/London midnight opening settlement day `date`. */
export declare function londonDayStartMs(date: string): number

/** 1-based settlement period of `utcMs` within settlement day `date`. */
export declare function settlementPeriodAt(date: string, utcMs: number): number

/** Europe/London calendar date ("YYYY-MM-DD") at a given instant. */
export declare function londonDate(utcMs: number): string

export declare function aggregateDay(
  rows: B1610Row[],
  byUnit: Record<string, string>,
  /** Settlement date — sizes the series exactly on clock-change days (#5). */
  date?: string,
): Map<string, StationDay>

export declare function aggregatePN(
  rows: PNRow[],
  byUnit: Record<string, string>,
): Map<string, number>

export declare function parseOutturn(payload: unknown): MixSnapshot | null

export interface MixDaySeries {
  /** FUELINST fuelType → half-hourly MW values, one per settlement period of
   *  the day (46 | 48 | 50); null = no reading. */
  fuels: Record<string, (number | null)[]>
  imports: (number | null)[]
  /** Per-interconnector series, keyed by map link id (+ = import). */
  interconnectors: Record<string, (number | null)[]>
}

export declare function parseOutturnDay(
  payload: unknown,
  /** Settlement date; derived from the first readable snapshot when omitted. */
  date?: string,
): MixDaySeries | null

export interface PriceDay {
  currency: string
  /** Per-interval price series (GB half-hours — 46 | 48 | 50 — or 24 EU hours). */
  series: (number | null)[]
  zones: number
}

export declare function aggregateMID(
  rows: unknown,
  /** Settlement date — sizes the series exactly on clock-change days (#5). */
  date?: string,
): PriceDay | null

export declare function currentSettlement(now?: Date): {
  settlementDate: string
  settlementPeriod: number
}

export declare function daysBefore(isoDate: string, n: number): string

export declare function chunk<T>(arr: T[], size: number): T[][]
