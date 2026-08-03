/**
 * Feature-usage events (#97): fire-and-forget GoatCounter events over the
 * beacon index.html already loads. Per-hash view counts existed since day
 * one; this adds the "does anyone use the slider?" signal that should steer
 * what gets built next. No cookies, no ids — an event is one integer.
 */

interface GoatCounter {
  count?: (opts: { path: string; title?: string; event: boolean }) => void
}

/**
 * Count one event, e.g. track('mix-range', 'week') → "mix-range-week".
 * A no-op when the beacon is absent (localhost, blockers, tests) — feature
 * signal must never break the feature.
 */
export function track(event: string, detail?: string): void {
  const gc = (window as unknown as { goatcounter?: GoatCounter }).goatcounter
  try {
    gc?.count?.({ path: detail ? `${event}-${detail}` : event, title: event, event: true })
  } catch {
    // counting is the one job allowed to fail silently
  }
}
