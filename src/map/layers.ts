import type { LayerSpecification } from 'maplibre-gl'
import { LINE_COLORS, fuelColorExpression } from '../lib/fuels'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Expr = any

/** Capacity-scaled circle radius: big stations read at national zoom. */
function radiusExpression(): Expr {
  const scaled = (k: number, min: number): Expr => [
    'max',
    min,
    ['*', k, ['sqrt', ['coalesce', ['get', 'capacityMW'], 4]]],
  ]
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    4.5,
    scaled(0.16, 1.8),
    7,
    scaled(0.35, 3),
    10,
    scaled(0.8, 4.5),
    13,
    scaled(1.6, 6),
  ]
}

/**
 * Bright overlay sized by live output (feature-state `liveMW`); the base
 * capacity circles dim to ghosts while this is visible. sqrt scaling keeps
 * it comparable with the capacity encoding.
 */
export function liveStationLayer(source: string): LayerSpecification {
  const scaled = (k: number): Expr => [
    '*',
    k,
    ['sqrt', ['max', 0, ['coalesce', ['feature-state', 'liveMW'], 0]]],
  ]
  return {
    id: 'stations-live',
    type: 'circle',
    source,
    layout: { visibility: 'none' },
    paint: {
      'circle-color': fuelColorExpression() as Expr,
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        4.5,
        scaled(0.16),
        7,
        scaled(0.35),
        10,
        scaled(0.8),
        13,
        scaled(1.6),
      ] as Expr,
      'circle-opacity': 0.95,
      'circle-stroke-color': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        '#ffffff',
        '#0d0d0d',
      ] as Expr,
      'circle-stroke-width': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        2,
        0.5,
      ] as Expr,
    },
  }
}

export function stationLayers(source: string): LayerSpecification[] {
  return [
    {
      id: 'stations',
      type: 'circle',
      source,
      paint: {
        'circle-color': fuelColorExpression() as Expr,
        'circle-radius': radiusExpression(),
        'circle-opacity': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          1,
          0.85,
        ] as Expr,
        // Dark separation stroke normally; white ring for pumped storage
        // (secondary encoding) and on hover.
        'circle-stroke-color': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          '#ffffff',
          ['==', ['get', 'fuel'], 'pumped'],
          '#ffffff',
          '#0d0d0d',
        ] as Expr,
        'circle-stroke-width': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          2,
          ['==', ['get', 'fuel'], 'pumped'],
          1.4,
          0.5,
        ] as Expr,
      },
    },
  ]
}

export function transmissionLayers(source: string): LayerSpecification[] {
  const width = (base: number): Expr => [
    'interpolate',
    ['exponential', 1.4],
    ['zoom'],
    4.5,
    base * 0.55,
    9,
    base * 1.6,
    13,
    base * 3.2,
  ]
  return [
    {
      id: 'lines-132',
      type: 'line',
      source,
      filter: ['==', ['get', 'v'], 132],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': LINE_COLORS.v132, 'line-width': width(0.9), 'line-opacity': 0.9 },
    },
    {
      id: 'lines-275',
      type: 'line',
      source,
      filter: ['==', ['get', 'v'], 275],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': LINE_COLORS.v275, 'line-width': width(1.25), 'line-opacity': 0.92 },
    },
    {
      id: 'lines-400',
      type: 'line',
      source,
      filter: ['==', ['get', 'v'], 400],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': LINE_COLORS.v400, 'line-width': width(1.6), 'line-opacity': 0.95 },
    },
  ]
}

export function interconnectorLayers(source: string): LayerSpecification[] {
  return [
    {
      id: 'hvdc',
      type: 'line',
      source,
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': LINE_COLORS.hvdc,
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          4.5,
          ['case', ['>=', ['get', 'capMW'], 1400], 2.1, 1.5] as Expr,
          10,
          ['case', ['>=', ['get', 'capMW'], 1400], 4, 3] as Expr,
        ] as Expr,
        'line-opacity': ['case', ['==', ['get', 'status'], 'construction'], 0.42, 0.85] as Expr,
        'line-dasharray': [2.4, 1.8],
      },
    },
  ]
}

/** Layers the pointer interacts with, topmost first. */
export const INTERACTIVE_LAYERS = [
  'stations-live',
  'stations',
  'hvdc',
  'lines-400',
  'lines-275',
  'lines-132',
]
