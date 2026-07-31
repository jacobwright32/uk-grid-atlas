"""Regenerate tests/fixtures/ from a local checkout of the atlas repo.

Not run by the test suite — fixtures are committed. Run it when the upstream
schema moves:

    python tests/make_fixtures.py ~/dev/dashboard

Truncates each file to a few days so the fixtures stay small enough to read in a
diff, while keeping real values and real gaps. The point of using captured real
data rather than hand-written JSON is that hand-written JSON encodes what I
believe the schema is, which is exactly the thing under test.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Chosen to span the awkward cases, not for tidiness:
#   de  rich European grid, 8 buckets, EUR prices
#   ch  sparse — four buckets, so absent != zero has something to bite on
#   gb  history only, GBP, the one grid with no live JSON
#   ca  CAD prices, IESO sourceLabel, North America
#   us  mix-only, no prices, no currency, partial coverage
GRIDS = ["de", "ch", "gb", "ca", "us"]
DAYS = 4
HOURLY = 2


def main(repo: Path) -> int:
    src = repo / "public" / "live"
    if not (src / "history").is_dir():
        print(f"no atlas data under {src}", file=sys.stderr)
        return 1

    # Mirror the published URL layout exactly — fixtures/live/history/de.json —
    # so a path bug in the client shows up here rather than only in production.
    out = Path(__file__).parent / "fixtures" / "live"
    (out / "history").mkdir(parents=True, exist_ok=True)

    for code in GRIDS:
        raw = json.loads((src / "history" / f"{code}.json").read_text("utf-8"))
        raw["days"] = (raw.get("days") or [])[-DAYS:]
        raw["hourly"] = (raw.get("hourly") or [])[-HOURLY:]
        for hour in raw["hourly"]:
            hour.pop("perStation", None)  # large, and not modelled
        _write(out / "history" / f"{code}.json", raw)

        live = src / f"{code}.json"
        if live.is_file():
            snap = json.loads(live.read_text("utf-8"))
            snap.pop("perStation", None)
            snap.pop("today", None)
            _write(out / f"{code}.json", snap)

    print(f"wrote fixtures for {', '.join(GRIDS)}")
    return 0


def _write(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, separators=(",", ":")), "utf-8")


if __name__ == "__main__":
    raise SystemExit(main(Path(sys.argv[1] if len(sys.argv) > 1 else "../dashboard").expanduser()))
