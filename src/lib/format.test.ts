import { describe, expect, it } from 'vitest'
import { fmtGW, fmtMW, humanise } from './format'

describe('fmtMW', () => {
  it('rounds large values to whole MW with thousands separator', () => {
    expect(fmtMW(3260)).toBe('3,260 MW')
  })
  it('keeps one decimal below 100 MW', () => {
    expect(fmtMW(49.94)).toBe('49.9 MW')
  })
  it('em-dash for unknown', () => {
    expect(fmtMW(null)).toBe('—')
    expect(fmtMW(undefined)).toBe('—')
    expect(fmtMW(Number.NaN)).toBe('—')
  })
})

describe('fmtGW', () => {
  it('GW with one decimal', () => {
    expect(fmtGW(14200)).toBe('14.2 GW')
  })
  it('MW below 1 GW', () => {
    expect(fmtGW(850)).toBe('850 MW')
  })
})

describe('humanise', () => {
  it('title-cases and splits multi values', () => {
    expect(humanise('landfill_gas;biogas')).toBe('Landfill gas · Biogas')
  })
  it('null passthrough', () => {
    expect(humanise(null)).toBeNull()
  })
})
