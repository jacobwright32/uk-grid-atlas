<!--
Thanks for this. Delete whatever does not apply — a one-line description and a
note on what you verified is plenty for a small change.
-->

## What this changes

<!-- One or two sentences. Link the issue it closes: "Closes #123". -->

## What I verified

<!--
What you actually ran, not what you intended to. For anything numeric, the
operator's own figure next to this one is the most convincing thing you can put
here.
-->

- [ ] **Atlas:** `npm run lint`, `npm test`, `npm run build` all pass
      <!-- note: `npx tsc --noEmit` typechecks NOTHING here (solution-style tsconfig).
           Use `npm run typecheck`. -->
- [ ] **Python package:** `pytest`, `ruff check .`, `ruff format --check .`, `mypy` all pass
- [ ] Screenshots attached, if anything visual changed

## Data correctness

<!-- Skip this section entirely if the change cannot affect a published number. -->

- [ ] Fuel buckets a grid does not report stay **absent**, not zero, and missing hours stay `null`
- [ ] No grid label claims wider coverage than the data has (`us` is ERCOT + NYISO, `ca` is Ontario)
- [ ] Prices stay in the operator's currency, uncoverted, with the currency carried alongside
- [ ] Derived figures are labelled as derived, and upstream operators are credited
- [ ] No API key, token or credential in the diff
- [ ] If the derivation of a published number changed, `python/CHANGELOG.md` says so

## Anything you want a second opinion on

<!-- Trade-offs you were unsure about are useful to flag rather than hide. -->
