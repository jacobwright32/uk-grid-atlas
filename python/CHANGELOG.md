# Changelog

All notable changes to `world-energy-generation` are recorded here. This project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Two kinds of change matter to callers of a data client, and they are tracked
separately below: changes to *this package's API*, which follow semver, and
changes to the *upstream schema* it reads, which do not — the atlas can add a
field whenever it likes. Anything that alters a number you would publish gets
called out explicitly, even in a patch release.

## [Unreleased]

## [0.2.0] — 2026-08-03

Ten new grids, no API changes. Code written against 0.1.0 keeps working
unchanged; iteration over `GRIDS`, `codes()` or `grids_frame()` now yields 32
rows instead of 22.

### Added

- **Ten grids**: Slovenia (`si`), Hungary (`hu`), Slovakia (`sk`), Croatia
  (`hr`), Bulgaria (`bg`), Greece (`gr`), Romania (`ro`), Bosnia and
  Herzegovina (`ba`), Serbia (`rs`) and North Macedonia (`mk`). All carry the
  full rolling history; all publish a live snapshot.

### Notes on the data, current as of this release

- **`ba` has no wholesale prices.** NOS BiH files no day-ahead prices with
  ENTSO-E, so `price` is `None` on every record and `currency` is `None` —
  the same shape `us` has always had. Its registry entry carries no `note`
  because coverage is national; the data itself states the gap.
- **`rs` publishes per-station output ~12 days behind the calendar.** The mix,
  demand and prices are current; only the per-station series trail.
- **`hr` is mix-only**: HEP publishes no per-unit output at all.
- **Phantom zero demand is now filtered upstream.** MEPSO (`mk`) files literal
  zeros for demand on days it has not metered yet; the atlas now stores those
  as "not reported" rather than zero, so a demand mean can never silently
  include an impossible 0 MW day. No package change was needed — the fix is
  in the feed — but means computed from pre-fix captures of `mk` data may
  differ slightly.
- `gb` remains the one grid without `live()`; `is_partial` still flags exactly
  `gb`, `ie`, `us`, `ca`.

## [0.1.0] — 2026-07-31

First release.

### Added

- `history(code)` — rolling ~31 days of daily means plus the last several days at
  hourly resolution, for all 22 grids. Returns a `History` of `DayRecord` and
  `HourRecord` dataclasses.
- `live(code)` — most recent published snapshot, for the 21 grids that have one.
- `latest(code)` — the last complete day from history, which is the portable way
  to ask "what happened most recently" for all 22 grids including Great Britain.
- A 22-grid registry (`grids()`, `grid()`, `codes()`, `GRIDS`) carrying scope,
  region, timezone, operator and a `note` on the four grids whose coverage is
  narrower than their name suggests (`gb`, `ie`, `us`, `ca`).
- `carbon_intensity()` and the `CARBON_FACTORS` table — generation-weighted
  lifecycle intensity in gCO2e/kWh, derived locally from IPCC AR5 / UNECE
  medians. Also exposed as a property on every day, hour and snapshot.
- Optional pandas builders behind the `[pandas]` extra: `generation()`,
  `prices()`, `demand()`, `grids_frame()`, plus `History.to_frame()` and
  `History.hourly_frame()`.
- `Client` with an in-memory TTL cache, an optional on-disk cache, and an
  overridable base URL (`WORLD_ENERGY_BASE_URL`).
- Typed throughout, with a `py.typed` marker.
- `LiveSnapshot.generated_at` and `History.updated_at` are parsed into tz-aware
  `datetime`s rather than handed back as ISO strings, so they can be compared
  against `datetime.now(timezone.utc)` directly. Upstream stamps them with a
  trailing `Z`, which `datetime.fromisoformat` rejected before Python 3.11, and
  this package supports 3.10. An unparseable stamp becomes `None`: a publisher
  typo in a metadata field should not make a whole grid unreadable.

### Notes on the data, current as of this release

- **An absent fuel bucket means "not reported", never zero.** The frame builders
  keep it as `NaN` and do not fill it.
- `us` is ERCOT + NYISO, not the United States, and publishes no prices.
  `ca` is Ontario. `ie` mixes an all-island generation scope with a
  Republic-only demand scope.
- The `basis` field on live snapshots reads `"entsoe"` for every grid including
  the North American ones. It is a frontend enum, not provenance — use
  `attribution`.
- Upstream history schema versions 2 and 3 both parse. A newer version parses
  with a `UserWarning` rather than failing, because every bump observed so far
  has been additive; an older one is a hard `SchemaError`.

[Unreleased]: https://github.com/jacobwright32/uk-grid-atlas/compare/python-v0.2.0...HEAD
[0.2.0]: https://github.com/jacobwright32/uk-grid-atlas/compare/python-v0.1.0...python-v0.2.0
[0.1.0]: https://github.com/jacobwright32/uk-grid-atlas/releases/tag/python-v0.1.0
