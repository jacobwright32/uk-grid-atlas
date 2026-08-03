# world-energy-generation

Electricity generation, prices, cross-border flows and demand for **32 power grids** across Europe and North America, as typed Python. No API key, no account, no required dependencies.

```bash
pip install world-energy-generation
```

```python
import world_energy_generation as weg

day = weg.latest("de")
print(day.date, day.mix["wind"], day.carbon_intensity)
# 2026-07-30 11901.0 270.6
```

The numbers come from the JSON published by [Grid Atlas](https://jacobwright32.github.io/uk-grid-atlas/), which aggregates Elexon/BMRS, the ENTSO-E Transparency Platform, ERCOT, NYISO and IESO into one shape and republishes it on GitHub Pages. This package is the Python client for that feed: it fetches, validates, caches and types it, and optionally hands you pandas DataFrames.

## Why this exists

Every grid operator publishes fuel-mix data in its own schema, on its own cadence, behind its own registration flow. ENTSO-E wants a token. Elexon wants a different one. ERCOT publishes a CSV whose columns move. Getting a comparable time series across a dozen countries is a week of plumbing before you can ask your actual question.

The atlas already did that plumbing and publishes the result as static JSON. This package makes it importable:

```python
weg.generation(["de", "fr", "no"]).groupby(["grid", "fuel"]).mw.mean()
```

## Install

```bash
pip install world-energy-generation              # zero dependencies
pip install 'world-energy-generation[pandas]'    # + DataFrame builders
```

Requires Python 3.10 or newer. The core package imports nothing outside the standard library — `urllib.request` is entirely adequate for reading static JSON, and a data package that drags in a transitive HTTP stack to fetch a public file is being rude about it. pandas is an extra because plenty of callers want the dataclasses and nothing else.

## The two datasets

### `history(code)` — rolling ~31 days, all 32 grids

Daily means for about 31 days, plus the last several days at hourly resolution. This is the uniform surface; reach for it first.

```python
h = weg.history("de")

len(h.days)              # 31
len(h.hourly)            # 7   (varies — read it, don't assume)
h.currency               # 'EUR'
h.attribution            # 'ENTSO-E Transparency Platform'

d = h.days[-1]
d.date                   # datetime.date(2026, 7, 30)
d.mix                    # {'wind': 11901.0, 'solar': 17696.0, 'gas': 4985.0, ...}
d.total_mw               # 54164.0
d.import_mw              # 1114.0    net imports, negative when exporting
d.demand_mw              # 55622.0
d.price                  # 125.18    day-ahead mean, in h.currency
d.carbon_intensity       # 270.6     gCO2e/kWh, derived (see below)
```

The window rolls: the atlas drops the oldest day on each refresh, so persist what you fetch if you need a fixed period. (Sample outputs throughout this file are real values captured on 2026-07-30 — yours will differ, because the window has moved since.)

Hourly records carry 24-slot series:

```python
hour = h.hourly[-1]
hour.mix_series["wind"]       # [8210.0, 7940.0, ... ] 24 values, None where unreported
hour.prices                   # 24 day-ahead prices
hour.flow_series["alegro"]    # 24 values on the DE-BE interconnector
hour.demand_series            # 24 values
```

### `live(code)` — most recent snapshot, 31 grids

```python
snap = weg.live("fr")
snap.generated_at        # datetime, tz-aware
snap.total_mw            # 58585.0
snap.carbon_intensity    # 33.8   France, mostly nuclear
snap.mix["nuclear"]      # 42300.0
```

"Live" means the last committed refresh, roughly six-hourly — check `.generated_at` before calling anything here current.

Great Britain is the one grid with no live JSON: its snapshot is compiled into the atlas's JavaScript bundle rather than served as a file, so `live("gb")` raises `DataNotPublished` and points you at `history("gb")`, which works normally. If you want the most recent figure for any grid without special-casing GB, use `latest(code)` — it reads the last complete day out of history.

### `coverage()` — what each grid measurably publishes

```python
cov = weg.coverage()
cov["ba"].prices                     # False — NOS BiH files no day-ahead prices
cov["rs"].per_station_live           # 11
cov["de"].flows                      # "hvdc" — mapped links only
cov["pt"].flows                      # "net"  — measured over every border
cov.to_frame().query("~prices")      # the grids with no published prices
```

Computed by the atlas workflow *from the published files* at every bake — a per-grid answer to "why is this field `None`?" that is checked, not promised. `flows` tells you how much to trust `import_mw`: `"net"` is the signed position over every border, `"hvdc"` counts mapped interconnectors only, `"none"` means the figure is absent because nothing is measured.

Windowed reads trim the rolling history client-side, inclusive on both ends:

```python
weg.history("de", since="2026-07-20", until="2026-07-27")
```

## The `weg` command

The same data without opening Python — installed with the package, zero dependencies:

```console
$ weg live de                 # current mix, price, est. carbon
$ weg history gb --days 3     # recent settled days
$ weg coverage                # the full coverage matrix
$ weg grids                   # the registry
```

Read-only, plain text, `--base-url` for forks. Script against the library rather than parsing this output.

## Three things to know before you publish a number

**1. An absent fuel bucket was not reported. It is not zero.**

Switzerland publishes four buckets (hydro, nuclear, solar, wind). Germany publishes eight, and `nuclear` is not among them — the reactors are shut. Spain publishes nine. A bucket missing from `mix` means the operator did not report it, which is a different claim from reporting zero, and the difference will wreck any mean you take.

The frame builders keep this as `NaN` and will not fill it:

```python
weg.history("ch").to_frame().columns
# ['wind', 'solar', 'hydro', 'nuclear', 'total_mw', 'import_mw', 'demand_mw', 'price', 'carbon_intensity']
```

If you want zeros, ask for them explicitly. The default will not guess on your behalf.

**2. Two grids cover less than their names suggest.**

`us` is ERCOT plus NYISO — roughly a third of US generation, not a national figure. No US ISO publishes per-plant output openly, so that grid is mix-only and carries no prices at all (`currency` is `None`). `ca` is Ontario (IESO) alone, with prices in CAD. `ie` is the all-island SEM market for generation but EirGrid's control area for demand, so a demand-minus-generation residual for Ireland is not a net-import figure.

Every grid carries a `note` saying so, and `is_partial` flags the four that need one:

```python
weg.grid("us").note
# 'Only the two ISOs that publish fuel mix openly — roughly a third of US
#  generation, not a national figure. ...'

[g.code for g in weg.grids() if g.is_partial]   # ['gb', 'ie', 'us', 'ca']
```

**3. Carbon intensity is derived here, not measured upstream.**

`carbon_intensity` is a generation-weighted mean of IPCC AR5 / UNECE lifecycle medians in gCO2e/kWh: coal 820, gas 490, other 650, biomass 230, solar 41, geothermal 38, hydro 24, nuclear 12, wind 12, storage 0. Good enough to compare grids and track trends, not good enough for compliance reporting or for arguing about a specific plant.

Buckets with no factor, no value, or a non-positive value are excluded from both the numerator and the denominator, so an unknown fuel dilutes nothing. Where nothing attributable was generating, the result is `None` rather than `0.0` — zero would be a claim of a carbon-free grid, and `None` says "nothing to go on". Note that `storage` at 0 makes a grid read slightly optimistic during discharge, since the emissions belong to whatever charged it.

## The 32 grids

```python
weg.codes()
# ['gb', 'ie', 'pt', 'es', 'fr', 'be', 'nl', 'de', 'ch', 'it', 'at', 'cz',
#  'si', 'hu', 'sk', 'hr', 'bg', 'gr', 'ro', 'ba', 'rs', 'mk', 'pl',
#  'dk', 'no', 'se', 'fi', 'ee', 'lv', 'lt', 'us', 'ca']
```

| Code | Scope | Live | Operator |
|------|-------|:----:|----------|
| `gb` | United Kingdom | – | Elexon (BMRS / Insights) |
| `ie` | Ireland, all-island | ✓ | ENTSO-E |
| `pt` `es` `fr` `be` `nl` `de` `ch` `it` `at` `cz` `si` `hu` `sk` `hr` `bg` `gr` `ro` `ba` `rs` `mk` `pl` | Portugal, Spain, France, Belgium, Netherlands, Germany, Switzerland, Italy, Austria, Czechia, Slovenia, Hungary, Slovakia, Croatia, Bulgaria, Greece, Romania, Bosnia and Herzegovina, Serbia, North Macedonia, Poland | ✓ | ENTSO-E |
| `dk` `no` `se` `fi` `ee` `lv` `lt` | Denmark, Norway, Sweden, Finland, Estonia, Latvia, Lithuania | ✓ | ENTSO-E |
| `us` | United States: Texas + New York only | ✓ | ERCOT + NYISO |
| `ca` | Canada: Ontario only | ✓ | IESO |

Filter the registry rather than hardcoding lists:

```python
weg.grids(region="north-america")        # us, ca
weg.grids(live_only=True)                # the 31 with live JSON
weg.grids_frame()                        # the whole registry as a DataFrame
```

## pandas

Four tidy builders, all long-format and ready for `groupby`:

```python
weg.generation(["de", "fr"])      # grid, date, fuel, mw
weg.generation("de", hourly=True) # grid, timestamp, fuel, mw
weg.prices(["de", "gb"])          # grid, date, price, currency
weg.demand()                      # all 32: grid, date, demand_mw
```

Plus wide frames on a single history:

```python
weg.history("de").to_frame()          # one row per day, DatetimeIndex
weg.history("de").hourly_frame()      # 24 rows per hourly day
```

```
               wind    solar     gas  total_mw   price  carbon_intensity
date
2026-07-27  22624.0  13482.0  3508.0   56243.0   97.40             194.1
2026-07-28   8166.0  19425.0  4120.0   50209.0  118.62             260.5
2026-07-29   7366.0  20293.0  5093.0   52219.0  126.05             274.3
2026-07-30  11901.0  17696.0  4985.0   54164.0  125.18             270.6
```

**Currencies are never converted.** Ontario is CAD, GB is GBP, the ENTSO-E grids are EUR, and `us` has no prices at all. `prices()` carries the currency on every row so that a naive cross-grid mean is at least visibly wrong rather than invisibly wrong.

The hourly index is *nominal local time*, built as `date + hour` from the publisher's own day buckets. On the two DST changeover days a grid's day is 23 or 25 hours upstream and this frame still shows 24 slots — do not localise it and expect the arithmetic to survive. If you need true instants, take them from the upstream API.

Calling a frame builder without pandas installed raises `PandasRequired` with the install command, rather than an `ImportError` from three frames deep.

## Caching and the base URL

Every fetch goes through a `Client` with a 15-minute in-memory TTL, so repeated calls in one analysis session hit memory rather than the network. The atlas refreshes roughly every six hours, so the TTL is about being polite to GitHub Pages rather than about freshness.

For a longer or persistent cache:

```python
from world_energy_generation import Client, set_default_client

set_default_client(Client(cache_dir="~/.cache/weg", ttl=3600))
```

A corrupt or unwritable cache file is treated as a miss, never as an error.

The default base URL is `https://jacobwright32.github.io/uk-grid-atlas/`, which is coupled to the atlas's repo name. If it ever moves, override it without waiting for a release — `Client(base_url=...)`, or the `WORLD_ENERGY_BASE_URL` environment variable.

## Errors

Everything inherits `WorldEnergyError`, so one `except` catches the lot.

| Exception | Means |
|-----------|-------|
| `GridNotFound` | Unknown code. Lists the valid ones. Also a `KeyError`. |
| `DataNotPublished` | Grid exists, dataset isn't served for it — currently only `live("gb")`. |
| `FetchError` | HTTP failure, timeout, non-200, or a body that wasn't JSON. |
| `SchemaError` | Upstream JSON didn't look like an atlas file. Carries the version it saw. |
| `PandasRequired` | A DataFrame was asked for and pandas is absent. Also an `ImportError`. |

Schema versions are handled tolerantly on purpose: a version this release knows parses silently, a *newer* one parses with a `UserWarning`, and only an older-than-supported version is a hard error. Every observed upstream bump so far has been purely additive, and hard-failing on an unknown version would break every pinned install on the day the atlas adds a field.

## Attribution

Cite the operators who measured the electricity, not this package, which only moved the bytes. `history.attribution` and `snapshot.attribution` give the right string per grid:

```python
weg.history("gb").attribution     # 'Elexon'
weg.history("ca").attribution     # 'IESO'
weg.history("fr").attribution     # 'ENTSO-E Transparency Platform'
```

One trap worth naming: the `basis` field on a live snapshot reads `"entsoe"` for *every* grid, including Ontario and the US ISOs. It is a frontend rendering enum, not provenance. Use `attribution`.

## Contributing

Issues and pull requests welcome — see [CONTRIBUTING.md](https://github.com/jacobwright32/uk-grid-atlas/blob/main/CONTRIBUTING.md). The most useful contributions are usually a grid the atlas doesn't cover yet, or a case where this parser disagrees with what an operator actually published.

The test suite runs entirely offline against captured fixtures of the real published JSON, so `pytest` needs no network and no key:

```bash
git clone https://github.com/jacobwright32/uk-grid-atlas
cd uk-grid-atlas/python
pip install -e '.[pandas]' pytest ruff mypy
pytest && ruff check . && mypy
```

The fixtures are real captures rather than hand-written JSON, deliberately: hand-written fixtures encode what the author *believes* the schema is, which is exactly the thing under test.

## License

MIT. The data is republished from public sources under their own terms — ENTSO-E, Elexon, ERCOT, NYISO and IESO each have their own, and none of them are this package's to relicense.
