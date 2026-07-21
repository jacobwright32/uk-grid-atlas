/**
 * basemap.mjs — region coastline builder shared by build-data.mjs and
 * build-basemap.mjs (the standalone regenerator).
 *
 * Each region has two rectangles:
 *   select — a polygon is included if any outer-ring vertex falls inside
 *            (mainland continents ride in via any coastal vertex; the box
 *            also decides which standalone islands are worth shipping).
 *   box    — the generous geometric clip actually applied to the rings.
 *            Kept inside [-180, 180] so no shipped ring ever crosses the
 *            antimeridian: rings are unwrapped first, then rectangle-clipped
 *            (fixes the world-wide fill slabs from Chukotka's 180° crossing).
 */
import { clipRingToBox, simplify, unwrapRing } from './pipeline-utils.mjs'

export const REGIONS = {
  eu: {
    file: 'basemap.json',
    eps: 0.004,
    // Iceland, the Baltic islands, Corsica/Sardinia/Sicily, the Canaries and
    // Madagascar are separate Natural Earth polygons — the select box is
    // sized so they ship alongside the Eurasia/Africa mainland.
    select: [-25, -27, 51, 67],
    box: [-35, -36, 180, 84.5],
  },
  na: {
    file: 'basemap_na.json',
    eps: 0.006,
    // Wide enough that Greenland, the Canadian Arctic islands, the Caribbean
    // and Hawaiʻi ship with the Americas mainland.
    select: [-170, 5, -50, 84],
    box: [-180, -60, -10, 84.5],
  },
}

const round4 = ([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]

/**
 * Unwrapping is relative to a ring's first vertex, so a ring that crosses
 * 180° early can come out shifted a whole world east or west (Europe at
 * +370°). Returns the multiple-of-360 shift that recentres the unwrapped
 * ring on [-180, 180].
 */
function worldShift(ring) {
  let minX = Infinity
  let maxX = -Infinity
  for (const [x] of ring) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
  }
  return -360 * Math.round((minX + maxX) / 2 / 360)
}

const shifted = (ring, dx) => (dx === 0 ? ring : ring.map(([x, y]) => [x + dx, y]))

/** Natural Earth land FeatureCollection → one region's basemap GeoJSON. */
export function buildRegionBasemap(landFC, region) {
  const { select, box, eps } = REGIONS[region]
  const features = []
  for (const f of landFC.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    for (const poly of polys) {
      const outer = poly[0]
      const selected = outer.some(
        ([x, y]) => x >= select[0] && x <= select[2] && y >= select[1] && y <= select[3],
      )
      if (!selected) continue
      const outerU = unwrapRing(outer)
      const dx = worldShift(outerU)
      const clippedOuter = clipRingToBox(shifted(outerU, dx), box)
      if (!clippedOuter) continue
      const outerSimplified = simplify(clippedOuter, eps)
      if (outerSimplified.length < 4) continue
      const rings = [outerSimplified.map(round4)]
      for (const hole of poly.slice(1)) {
        // Holes ride on the outer ring's world copy, so reuse its shift.
        const clipped = clipRingToBox(shifted(unwrapRing(hole), dx), box)
        if (!clipped) continue
        const simplified = simplify(clipped, eps)
        if (simplified.length >= 4) rings.push(simplified.map(round4))
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: rings },
        properties: {},
      })
    }
  }
  return { type: 'FeatureCollection', features }
}
