/** Pure helpers shared by the data pipeline — kept import-safe for tests. */

/**
 * Parse "1,200 MW" / "49.9MW" / "2 GW" / "750 kW" / "1,2 MW" (European
 * decimal comma) / bare numbers → MW.
 */
export function parseCapacityMW(raw, decimalComma = false) {
  if (!raw || typeof raw !== 'string') return null
  let s = raw.trim().toLowerCase()
  if (decimalComma) {
    // Continental locale: any digit,digit comma is a decimal ("12,870MW" =
    // 12.87 MW). Dots stay decimals too — OSM mappers overwhelmingly use
    // them that way even in dot-as-thousands locales.
    s = s.replace(/(\d),(\d+)/g, '$1.$2')
  } else {
    // English locale: ",###" is a thousands separator; ",#"/",##" is a
    // (rare) decimal slip.
    s = s.replace(/(\d),(\d{3})(?!\d)/g, '$1$2').replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2')
  }
  const m = s.match(/([\d.]+)\s*(gw|mw|kw|w)?/)
  if (!m) return null
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  const unit = m[2]
  if (unit === 'gw') return n * 1000
  if (unit === 'mw') return n
  if (unit === 'kw') return n / 1000
  if (unit === 'w') return n / 1e6
  // No unit. OSM values are usually MW, but continental solar/biogas is
  // often tagged in bare kW(p): nothing on Earth is a bare ">2000 MW" site,
  // so large bare numbers are kW; astronomical ones are watts.
  if (n > 100000) return n / 1e6
  if (n > 2000) return n / 1000
  return n
}

/** "400000;132000" → highest transmission class (400 / 275 / 132) or null. */
export function parseVoltClass(v) {
  if (!v) return null
  let best = null
  for (const part of String(v).split(';')) {
    const n = parseInt(part.trim(), 10)
    if (!Number.isFinite(n)) continue
    if (n >= 380000) best = Math.max(best ?? 0, 400)
    else if (n >= 264000) best = Math.max(best ?? 0, 275)
    else if (n >= 110000) best = Math.max(best ?? 0, 132)
  }
  return best
}

/** Ramer–Douglas–Peucker simplification (iterative), eps in degrees. */
export function simplify(points, eps) {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [ax, ay] = points[a]
    const [bx, by] = points[b]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    let maxD = 0
    let idx = -1
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i]
      let d
      if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
        d = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2
      }
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (Math.sqrt(maxD) > eps && idx > 0) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  return points.filter((_, i) => keep[i])
}

/** Centripetal-ish Catmull–Rom through waypoints → smooth polyline. */
export function smooth(waypoints, samplesPerSeg = 12) {
  if (waypoints.length < 3) return waypoints
  const pts = [waypoints[0], ...waypoints, waypoints[waypoints.length - 1]]
  const out = []
  for (let i = 0; i < pts.length - 3; i++) {
    const [p0, p1, p2, p3] = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3]]
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg
      const t2 = t * t
      const t3 = t2 * t
      out.push([
        0.5 *
          (2 * p1[0] +
            (-p0[0] + p2[0]) * t +
            (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
            (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 *
          (2 * p1[1] +
            (-p0[1] + p2[1]) * t +
            (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
            (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ])
    }
  }
  out.push(waypoints[waypoints.length - 1])
  return out.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4])
}

/**
 * Remove ±360° longitude jumps from a ring (antimeridian crossings).
 * Natural Earth rings that cross 180° jump straight to -180°, which fill
 * renderers draw as a world-wide horizontal slab. Unwrapping makes the
 * longitudes continuous (they may exceed ±180) so the ring can then be
 * clipped by a plain rectangle.
 */
export function unwrapRing(ring) {
  if (ring.length < 2) return ring.slice()
  const out = [ring[0].slice()]
  let offset = 0
  for (let i = 1; i < ring.length; i++) {
    const dx = ring[i][0] - ring[i - 1][0]
    if (dx > 180) offset -= 360
    else if (dx < -180) offset += 360
    out.push([ring[i][0] + offset, ring[i][1]])
  }
  return out
}

/**
 * Sutherland–Hodgman clip of a closed ring against an axis-aligned box
 * [minX, minY, maxX, maxY]. Returns a closed ring (first point repeated
 * last) or null if nothing remains.
 */
export function clipRingToBox(ring, [minX, minY, maxX, maxY]) {
  const closed =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  let pts = closed ? ring.slice(0, -1) : ring.slice()
  const inside = [
    (p) => p[0] >= minX,
    (p) => p[0] <= maxX,
    (p) => p[1] >= minY,
    (p) => p[1] <= maxY,
  ]
  const cross = [
    (a, b) => [minX, a[1] + ((b[1] - a[1]) * (minX - a[0])) / (b[0] - a[0])],
    (a, b) => [maxX, a[1] + ((b[1] - a[1]) * (maxX - a[0])) / (b[0] - a[0])],
    (a, b) => [a[0] + ((b[0] - a[0]) * (minY - a[1])) / (b[1] - a[1]), minY],
    (a, b) => [a[0] + ((b[0] - a[0]) * (maxY - a[1])) / (b[1] - a[1]), maxY],
  ]
  for (let e = 0; e < 4 && pts.length; e++) {
    const out = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      const aIn = inside[e](a)
      const bIn = inside[e](b)
      if (aIn) {
        out.push(a)
        if (!bIn) out.push(cross[e](a, b))
      } else if (bIn) {
        out.push(cross[e](a, b))
      }
    }
    pts = out
  }
  if (pts.length < 3) return null
  return [...pts, pts[0].slice()]
}

/** Ray-cast point in ring. */
export function inRing(pt, ring) {
  const [x, y] = pt
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
