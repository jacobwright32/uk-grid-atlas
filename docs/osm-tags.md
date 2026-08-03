# OSM tags the Grid Atlas pipeline reads

This is the authoritative list of every OpenStreetMap tag the pipeline
consumes, what each one drives on the map, and what breaks when it is
missing. It is derived from the code, not from memory: the Overpass query
builders in `scripts/fetch-overpass.mjs`, the tag reads and taxonomies in
`scripts/build-data.mjs`, and the three `scripts/pbf-extract-*.py`
extractors. If the code and this page disagree, the code is right and this
page is a bug.

Mappers in a hurry want the short version in the README's
[note for OSM mappers](../README.md#improving-the-data-a-note-for-osm-mappers) —
six tags, ranked by how much they help. This page is the long version: the
exact selectors, every literal value the queries filter on, and the
complete `plant:source` value table.

## What the queries select

Two ingest paths feed the same builder. Fourteen countries have Overpass
queries in `fetch-overpass.mjs`; the remaining eighteen are reachable only by
extracting a Geofabrik `.osm.pbf` locally (see
[the PBF section of the README](../README.md#extracting-from-a-geofabrik-pbf)).
Both paths emit the same Overpass-shaped JSON, so `build-data.mjs` reads
tags identically either way — everything below applies to both.

**Generation** comes from `power=plant`, as nodes, ways _and_ relations, inside
the country's `ISO3166-1` admin area:

```
area["ISO3166-1"="ES"][admin_level=2]->.cc;
( node["power"="plant"](area.cc); way["power"="plant"](area.cc);
  relation["power"="plant"](area.cc); );
out tags center;
```

Anything mapped as a bare `power=generator` is invisible to this query — that
is the gap the generator path below fills. Offshore farms sit outside every
admin area, so they are picked up by explicit sea boxes that additionally
filter on `plant:source`, and which select **ways and relations only**:

```
way["power"="plant"]["plant:source"~"wind"](52.0,0.8,56.5,3.4);
relation["power"="plant"]["plant:source"~"wind"](52.0,0.8,56.5,3.4);
```

An offshore wind farm mapped as a single node in open water therefore never
appears. Draw it as an area.

**Transmission** comes from `power=line` ways whose `voltage` matches a
per-country alternation, either inside the admin area or inside a bbox chunk.
GB is the exception: its 400/275 kV layer is fetched as twelve regional boxes
(busy public Overpass servers reject one whole-country query), and its 132 kV
layer uses an `ISO3166-2` sub-national area at `admin_level=4`:

```
area["ISO3166-2"="GB-SCT"][admin_level=4]->.sct;
( way["power"="line"]["voltage"~"132000"](area.sct); );
out tags geom;
```

The `voltage` filter is a regex substring match, so a way tagged
`voltage=400000;220000` matches a query for either value. These are the exact
alternations per country:

| Grid                   | `power=line` `voltage` regex      | Extra query                   |
| ---------------------- | --------------------------------- | ----------------------------- |
| `gb`                   | `400000\|275000` (12 bbox chunks) | `132000` within `GB-SCT`      |
| `no`                   | `420000\|400000\|380000\|300000`  | `132000` (3 bbox chunks each) |
| `se`                   | `400000\|380000\|220000`          | `130000\|132000`              |
| `fi`                   | `400000\|380000\|220000`          | `110000`                      |
| `pl`, `ch`, `at`, `cz` | `400000\|380000\|220000`          | —                             |
| `es`                   | `400000\|380000\|220000`          | — (2 bbox chunks)             |
| `it`                   | `380000\|400000\|220000`          | — (3 bbox chunks)             |
| `pt`                   | `400000\|380000\|220000\|150000`  | —                             |
| `ee`, `lv`, `lt`       | `330000\|110000`                  | —                             |

Nothing below the lowest listed voltage is fetched at all, in any country. A
correctly tagged 110 kV line in Poland is not missing from the map by
accident — Poland's regional 110 kV layer is deliberately out of scope.

## Every tag the builder consumes

`build-data.mjs` reads exactly these keys off `el.tags`. Everything else in
the extract is discarded, so there is no hidden third tier of tags that
quietly matter.

| Tag                            | On                | What it drives                                                                                  |
| ------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------- |
| `plant:output:electricity`     | `power=plant`     | Dot radius (√-scaled), national GW totals, load factors on the hover card, search ranking       |
| `name`                         | `power=plant`     | Card title, station search, and the join key for every live-output feed                         |
| `name:en`                      | `power=plant`     | Fallback when `name` is absent — the only reason a non-Latin-script plant gets a usable label   |
| `plant:source`                 | `power=plant`     | Fuel group: dot colour, legend group, filter membership; shown verbatim as "Source" on the card |
| `plant:method`                 | `power=plant`     | Only `pumped` matters — it moves a hydro site into the pumped-storage class (white ring)        |
| `operator`                     | plant + line      | "Operator" row on the hover card                                                                |
| `start_date`                   | `power=plant`     | "Since" row on the hover card                                                                   |
| `voltage`                      | `power=line`      | Voltage class, and therefore whether the line renders at all                                    |
| `name`                         | `power=line`      | "Name" row on the line card                                                                     |
| `circuits`                     | `power=line`      | Parsed to an integer, but see the caveat below                                                  |
| `generator:source`             | `power=generator` | Selects wind turbines for the clustering pass (`generator:method` is the fallback)              |
| `generator:output:electricity` | `power=generator` | Per-turbine rating, summed into the synthetic farm's capacity                                   |

The `power=generator` rows apply only to the eleven grids rebuilt from
individually mapped turbines — Finland, Austria, Estonia, Canada, Hungary,
Croatia, Bulgaria, Greece, Romania, Serbia and North Macedonia. That pass
also reads `name` and `operator` off each turbine; the full story is
[below](#the-powergenerator-family).

Two caveats a maintainer should know. `circuits` is parsed off each way and is
in the PMTiles schema and the line hover card, but `mergeLines` in
`build-data.mjs` — the step that joins OSM's chopped-up way fragments back
into continuous circuits — resets it to `null` on every output feature, so no
non-null `circuits` value reaches a shipped bundle today. Tagging it is still
worth doing; the map just cannot show it yet. And `plant:method` is written
into `stations.json` as `method` but read by nothing in the UI: it affects the
pumped-storage classification at build time and nothing else. `photovoltaic`
versus `thermal` on a solar plant is not currently distinguished anywhere.

`name` and `operator` on lines survive the merge only when they are unanimous
across the whole joined chain — a chain of ways with three different names
comes out unnamed. That is a deliberate choice, not a bug: a merged 80 km
circuit has no single correct name.

## `plant:source` → fuel group

Twenty-seven `plant:source` values map onto twelve fuel groups. The primary
value wins: `plant:source` is lowercased and split on `;`, and only the first
part is looked up, so `plant:source=gas;oil` is gas. The raw string is still
shown in full on the hover card (`Gas · Oil`).

| Fuel group   | `plant:source` values recognised                                       |
| ------------ | ---------------------------------------------------------------------- |
| `nuclear`    | `nuclear`                                                              |
| `gas`        | `gas`, `methane`, `abandoned_mine_methane`, `mine gas`                 |
| `coal`       | `coal`, `lignite`, `oil_shale`                                         |
| `oil`        | `oil`, `diesel`, `kerosene`                                            |
| `wind`       | `wind` — then split into onshore/offshore, see below                   |
| `solar`      | `solar`                                                                |
| `hydro`      | `hydro` — plus `plant:method` for the pumped split, see below          |
| `bioenergy`  | `biomass`, `biofuel`, `biogas`, `landfill_gas`, `wastewater`, `sludge` |
| `waste`      | `waste`                                                                |
| `storage`    | `battery`, `liquid_air`, `flywheel`                                    |
| `marine`     | `tidal`, `wave`                                                        |
| `geothermal` | `geothermal`                                                           |

Anything else — an unrecognised value, or no `plant:source` at all — falls
through to a name-sniffing heuristic that looks for `solar`, `zonnepark`,
`zonneweide`, `wind`, `hydro`, `battery`, `storage`, `biomass`, `biogas`, or a
geothermal stem (`geotherm`, `geotermic`, `geotermia`, `jarðvarma`) in the
plant's name. If the name gives nothing away either, the site lands in
**Other / unknown** — grey, and useless for every fuel-level statistic on the
page. Tagging `plant:source` is the cheapest way to move a site out of that
bucket.

Three derived classes exist that no OSM value maps to directly:

- **`pumped`** — a `hydro` site whose `plant:method` contains `pumped`. It
  gets the white ring that marks storage as a secondary encoding. A handful of
  British schemes (Dinorwig, Ffestiniog, Cruachan, Foyers, Coire Glas) are
  additionally hard-coded by name, because their OSM `plant:method` has
  historically come and gone.
- **`wind_onshore` / `wind_offshore`** — every `wind` site is split by a
  point-in-polygon test against the Natural Earth 1:10m coastline, not by any
  tag. `offshore=yes` is not read. Getting the geometry right is what puts a
  farm in the correct legend group.

## How capacity is parsed

`plant:output:electricity` goes through `parseCapacityMW`
(`scripts/pipeline-utils.mjs`), which accepts `460 MW`, `49.9MW`, `2 GW`,
`750 kW`, `1,200 MW` and — in the eighteen continental grids that set
`decimalComma` — `1,2 MW` as 1.2 MW. GB, Ireland, the US and Canada read
`1,200` as 1200 instead. **Always tag an explicit unit.** A bare number is
guessed at: above 100000 it is assumed to be watts, above 2000 kilowatts,
otherwise megawatts. That guess is right most of the time and wrong
memorably.

A second guard catches unit-less kWp tags on small sites: any solar, onshore
wind, bioenergy, waste, storage or marine site over 1500 MW is divided by
1000, on the reasoning that no single one of those exceeds ~1.5 GW anywhere on
Earth. It runs _after_ the onshore/offshore split, so genuinely multi-GW
offshore farms like Dogger Bank are left alone.

## `voltage` → line class → tier

A line's `voltage` is split on `;`, each part parsed as an integer, and each
integer run through the country's `classify` ladder; the **highest** class any
part yields wins, and a way that yields none is dropped. The classes are
nominal kV labels, not the raw tag: a Dutch line tagged `voltage=380000`
becomes class `380`, and a French line tagged `220000` becomes class `225`,
because that is what RTE calls that network.

The map then buckets those classes into exactly three rendered tiers —
backbone, secondary, regional — which is what the sidebar's network toggles
switch. Several grids leave the third tier empty by design.

| Grid             | `classify` thresholds (volts → class)      | Tier 1  | Tier 2  | Tier 3  |
| ---------------- | ------------------------------------------ | ------- | ------- | ------- |
| `gb`             | ≥380k→400, ≥264k→275, ≥110k→132            | 400     | 275     | 132     |
| `nl`             | ≥340k→380, ≥200k→220, ≥140k→150, ≥100k→110 | 380     | 220     | 150+110 |
| `be`             | ≥340k→380, ≥200k→220, ≥140k→150            | 380     | 220     | 150     |
| `ie`             | ≥380k→400, ≥264k→275, ≥200k→220, ≥100k→110 | 400     | 275+220 | 110     |
| `dk`             | ≥380k→400, ≥140k→150, ≥125k→132            | 400     | 150+132 | —       |
| `fr`             | ≥380k→400, ≥200k→225                       | 400     | 225     | —       |
| `de`             | ≥340k→380, ≥200k→220                       | 380     | 220     | —       |
| `ch`, `at`       | ≥340k→380, ≥200k→220                       | 380     | 220     | —       |
| `cz`             | ≥380k→400, ≥200k→220                       | 400     | 220     | —       |
| `pl`, `es`       | ≥380k→400, ≥200k→220                       | 400     | 220     | —       |
| `it`             | ≥340k→380, ≥200k→220                       | 380     | 220     | —       |
| `no`             | ≥380k→420, ≥264k→300, ≥110k→132            | 420     | 300     | 132     |
| `se`             | ≥380k→400, ≥200k→220, ≥110k→130            | 400     | 220     | 130     |
| `fi`             | ≥380k→400, ≥200k→220, ≥100k→110            | 400     | 220     | 110     |
| `pt`             | ≥380k→400, ≥200k→220, ≥140k→150            | 400     | 220     | 150     |
| `ee`, `lv`, `lt` | ≥300k→330, ≥100k→110                       | 330     | 110     | —       |
| `si`, `hr`, `ba` | ≥380k→400, ≥200k→220, ≥100k→110            | 400     | 220     | 110     |
| `sk`, `rs`, `ro` | ≥380k→400, ≥200k→220, ≥100k→110            | 400     | 220     | 110     |
| `hu`             | ≥500k→drop, ≥380k→400, ≥200k→220           | 400     | 220     | —       |
| `bg`             | ≥500k→drop, ≥380k→400, ≥200k→220, ≥100k→110 | 400     | 220     | 110     |
| `gr`             | ≥380k→400, ≥140k→150                       | 400     | 150     | —       |
| `mk`             | ≥380k→400, 200–380k→drop, ≥100k→110        | 400     | 110     | —       |
| `us`             | ≥700k→765, ≥450k→500, ≥300k→345, ≥200k→230 | 765+500 | 345     | 230     |
| `ca`             | ≥650k→735, ≥440k→500, ≥280k→315, ≥200k→230 | 735+500 | 315     | 230     |

Because the thresholds are inclusive floors, an unusual voltage still lands
somewhere sensible: a 287 kV line in Canada classifies as 315, a 132 kV line
in Sweden as 130. What the ladder cannot rescue is a missing or
non-numeric `voltage` — that line is dropped silently, whatever `power=line`
says.

## The `power=generator` family

Some mapping communities never draw a `power=plant` around a wind farm; they
map every turbine as a `power=generator` and stop there, which makes whole
GW-scale fleets invisible to the plants query. Eleven grids — Finland,
Austria, Estonia, Canada and most of the 2026 Balkan adds (hu, hr, bg, gr,
ro, rs, mk) — are rebuilt with a compensating pass:

`scripts/pbf-extract-generators.py` pulls every element where `power=generator`
and either `generator:source` or `generator:method` contains `wind`, as nodes
or ways (a way turbine is anchored on its first node). `scripts/cluster-wind.mjs`
then reads `generator:output:electricity`, `name` and `operator` off those
turbines, single-linkage clusters them within 1.5 km, drops clusters under
three turbines and any turbine already inside a mapped `power=plant`, and
writes out synthetic stations tagged `plant:source=wind` with a summed
`plant:output:electricity`. From there they are ordinary plants.

Two tags carry that pass. `generator:output:electricity` per turbine is what
makes the farm's capacity real rather than absent — and per-turbine ratings
are clamped hard (any value over 20 MW is divided by 1000 until plausible,
since no turbine on Earth is bigger), so `2000` is read as 2 MW. And `name`,
because the cluster's name is the most common name stem among its turbines
after stripping unit suffixes: `Kooninkulma 4`, `Kooninkulma 7` and
`Kooninkulma WTG 9` become a farm called _Kooninkulma_. Unnamed turbines
produce a farm called "Wind farm" or, at best, "<operator> wind farm".

Drawing a real `power=plant` polygon around the farm beats all of this. The
clustering exists because the polygon is missing.

## What happens when a tag is missing

Nothing errors — the site simply degrades, usually invisibly. In rough order
of how much is lost:

**No `name`** (and no `name:en`) is the most expensive omission. The station is
labelled "Unnamed site", and every consumer that keys on names drops it: it
cannot be found in station search, it is excluded from the ENTSO-E unit
matcher and from the GB BMU map, so it can never light up on the live layer no
matter how much power it is generating, and it is excluded from name-based
de-duplication, so a duplicate mapping of the same plant survives as two dots.

**No `plant:output:electricity`** means the dot is drawn as if the site were
4 MW — the floor value — so a 1.8 GW station renders as a speck. It contributes
nothing to the headline GW total (which is why the sidebar calls it "recorded
capacity"), its hover card reads "not recorded", no load factor can be
computed even when live output exists, and it sorts last in search results.

**No `plant:source`** falls through to the name heuristic and then to
**Other / unknown**: grey, outside every fuel group, invisible to fuel
filters, absent from the mix statistics.

**No `plant:method`** on a pumped-storage scheme means it is rendered as plain
hydro, with no white ring, unless it is one of the five hard-coded British
names.

**No `voltage`** on a `power=line`, or a value that parses to no class, drops
the way entirely.

**No `operator` / `start_date`** just omits a row from the hover card.

## The highest-leverage things to add

Ranked by what they actually buy, given all of the above:

1. **A `power=plant` polygon** around a generator-mapped wind farm. It replaces
   a synthetic guess with real geometry, a real name and a real capacity, and
   it is the only fix that removes a site from the clustering heuristic.
2. **`plant:output:electricity`, with units.** One tag fixes the dot size, the
   national total and the load factor at once.
3. **`name`** — the key to the entire live-output layer.
4. **`plant:source`**, then **`plant:method`** where a hydro site pumps.
5. **`voltage`** on any transmission line that is on the map but the wrong
   colour, or absent when it should not be.
6. **Correct coastline-relative geometry** for offshore farms, since the
   onshore/offshore split is computed, not tagged — and an offshore farm mapped
   as a node in open water is not fetched at all.

Every station's hover card links straight to its OSM element, so a wrong
capacity is two clicks from fixed. [MapYourGrid](https://mapyourgrid.org) and
[Open Infrastructure Map](https://openinframap.org) are the reference points
for grid-mapping conventions; nothing here departs from them.

## Where this lives in the code

| Concern                                      | File                                                |
| -------------------------------------------- | --------------------------------------------------- |
| Overpass selectors, per-country `QUERIES`    | `scripts/fetch-overpass.mjs`                        |
| Tag reads, `FUEL_GROUPS`, `classify` ladders | `scripts/build-data.mjs` (`COUNTRIES`, `fuelGroup`) |
| Capacity and voltage parsing                 | `scripts/pipeline-utils.mjs`                        |
| PBF plant / line / generator extraction      | `scripts/pbf-extract-{plants,lines,generators}.py`  |
| Turbine → synthetic farm clustering          | `scripts/cluster-wind.mjs`                          |
| Fuel colours, legend groups, labels          | `src/lib/fuels.ts`                                  |
| Rendered voltage tiers per country           | `src/lib/countries.ts`                              |
| Hover-card rows                              | `src/map/popup.ts`                                  |
