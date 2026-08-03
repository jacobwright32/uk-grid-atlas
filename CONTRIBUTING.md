# Contributing to Grid Atlas

Thanks for looking. This repository holds two things that ship separately:

- **the atlas** — a React + TypeScript + MapLibre web app at the repo root, deployed to GitHub Pages, which also runs the data pipeline that publishes the JSON under `public/live/`
- **`python/`** — [`world-energy-generation`](https://pypi.org/project/world-energy-generation/), a Python client for that published JSON, released to PyPI on its own version line

They live together because they share one contract: the schema of the files in `public/live/`. When that schema changes, both sides change in the same pull request, which is much harder to forget than coordinating two repositories.

Everything below is a suggestion except the tests. Small pull requests get reviewed faster than large ones, and an issue describing a problem is a real contribution even with no code attached.

## The most useful things you could do

Ranked honestly by value to people using this:

**Add a grid.** The single biggest gap. Any transmission operator publishing an open fuel mix is a candidate — AESO (Alberta), Hydro-Québec, PJM, MISO, SPP, CAISO, the Balkan and southeastern European TSOs, Japan's regional utilities, the Australian NEM. Adding one means a fetcher script under `scripts/`, an entry in the country config, and a station bundle if per-plant data exists.

**Report a number that looks wrong.** If a figure here disagrees with what an operator publishes, that is the highest-priority class of bug in the project and specifics beat suspicions — grid, date, field, what this shows, what the source shows. Use the data issue template.

**Improve plant matching.** The pipeline matches ENTSO-E generation units to OpenStreetMap power plants by name and location, and the residue is a long tail of unmatched units. Overrides live in the station registry; a batch of correct ones for a country is genuinely valuable work.

**Fix the upstream data.** Some map errors are OpenStreetMap errors. Correcting a plant's location, capacity or fuel tag in OSM improves this atlas and everything else built on OSM — which is a better outcome than an override here.

## Ground rules on data

These are not style preferences. Every one of them exists because getting it wrong publishes a plausible-looking wrong number, which is worse than publishing nothing.

**Absent is not zero.** A fuel bucket a grid does not report must stay absent, and a missing hour must stay `null`. Germany reports no nuclear because its reactors are shut; Switzerland reports four buckets because that is what it publishes. Filling either with `0` so that columns add up produces a grid that reads cleaner than it is.

**Never widen a scope in a label.** `us` is ERCOT plus NYISO, about a third of US generation. `ca` is Ontario. Do not relabel them "United States" and "Canada" — a column headed "Canada" that means Ontario is how bad numbers end up in someone's paper. If you add a partial grid, say so in its `note`.

**Do not convert currencies.** Prices stay in the currency the operator published, with the currency carried alongside. A single rate applied across a month is a fabrication, and a wrong cross-grid comparison is more dangerous when it looks tidy.

**Attribute the operator, not this project.** ENTSO-E, Elexon, ERCOT, NYISO and IESO measured the electricity. Anything derived here — carbon intensity in particular — must be labelled as derived.

**Never commit an API key.** ENTSO-E and Elexon tokens belong in GitHub Actions secrets, which is where the workflows read them from. If you leak one, revoke it at the source rather than only removing it from a file: a rewritten history does not un-publish a token, and the fork network keeps a copy.

## Working on the atlas

Node 22 and npm.

```bash
npm ci
npm run dev              # http://localhost:5173
```

Before opening a pull request, run what CI runs:

```bash
npm run lint             # oxlint
npm test                 # vitest
npm run build            # tsc -b && vite build
npm run test:e2e         # boots the built site and asserts the map renders
```

One trap worth knowing: the root `tsconfig.json` is a solution-style file (`"files": []` plus project references), so **`npx tsc --noEmit` typechecks nothing and exits 0**. Use `npm run typecheck`, which runs `tsc -b`. This has fooled people before.

`npm run format` runs prettier. It is not a CI gate, so a formatting-only diff on a file you did not otherwise touch just makes review harder — leave those alone.

The pipeline scripts under `scripts/` fetch from live upstream APIs and mostly need a key, so they are not part of the test run. Their unit tests (`scripts/*.test.mjs`) work on captured fixtures and do run.

## Working on the Python package

Python 3.10 or newer. Everything happens inside `python/`.

```bash
cd python
pip install -e '.[pandas]' pytest pytest-cov ruff mypy
```

```bash
pytest                   # ~300 tests, no network, no key
ruff check .
ruff format --check .
mypy
```

The suite runs against committed fixtures served over `file://` URLs, which means it exercises the real fetch-and-parse path — `urljoin`, JSON decoding, cache read and write, error mapping — with no network at all. **If a test you add needs the internet, that is a bug in the test.** Regenerate fixtures with `python tests/make_fixtures.py` when the upstream schema moves; they are real captures rather than hand-written JSON on purpose, because hand-written fixtures encode what the author believes the schema is, which is exactly the thing under test.

Two conventions specific to this package:

- **No new runtime dependencies.** The core is standard library only and `pip install` should take a second. pandas is an optional extra, imported lazily inside `frames.py`, and two tests assert that importing the package neither imports pandas nor touches the network. If something needs a dependency, it probably belongs behind an extra.
- **Type everything.** `mypy --strict` passes and the package ships `py.typed`. Callers get real types, so a regression here is visible in their editor.

If you change how a published number is derived, say so in `CHANGELOG.md` even for a patch release. Someone has that number in a paper.

## Pull requests

Branch off `main`, keep the change focused, and describe what you verified rather than what you intended. Screenshots help for anything visual; for anything numeric, the operator's own figure next to this one is the most convincing thing you can put in a description.

Commits are squashed on merge, so local commit hygiene is not worth agonising over.

By contributing you agree your work is released under the MIT license in `LICENSE`.

## Being decent about it

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Short version: engage with the argument, not the person.
