/**
 * Types for snapshot-common.mjs, the shared bucket vocabulary the snapshot
 * bakers write into public/live.
 *
 * Partial by design: only the exports the app-side TypeScript actually reaches
 * for are declared. The bakers themselves are plain .mjs run by node and are
 * typechecked by their own tests, not by tsc — this file exists so the client
 * can import the palette it has to mirror rather than keep a second copy that
 * silently drifts (src/lib/history.test.ts). Adding an export here is the
 * cheap part; if you need another one, declare it.
 *
 * Mirrors the pattern src/lib/live-core.d.mts already uses for the other
 * .mjs module shared across the node/browser line.
 */

/** Display metadata for one generation bucket. */
export interface BucketMeta {
  label: string
  /** Hex, `#rrggbb` — the colour the chart and legend draw with. */
  color: string
}

/**
 * bucket key → label + colour, for every bucket a baker may emit.
 * `src/lib/history.ts` keeps a copy as HISTORY_BUCKETS because history files
 * carry keys only; the two are pinned together by a test.
 */
export const BUCKET_META: Record<string, BucketMeta>

/** Colour for a bucket key with no BUCKET_META entry. */
export const FALLBACK_COLOR: string

/** Colour for the interconnector-imports band, which is not a bucket. */
export const IMPORTS_COLOR: string
