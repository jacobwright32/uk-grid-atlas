"""``weg`` — the package's data, one terminal command away.

Deliberately small: four read-only subcommands over the same client the
library exposes, zero dependencies, plain aligned text. It exists because
"``weg live de``" is the fastest possible demonstration of what the package
is for — not because anyone should build tooling on its output. Script
against the library, not this.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

from . import __version__
from .client import Client
from .exceptions import WorldEnergyError
from .fuels import FUEL_LABELS
from .grids import GRIDS, grid


def _fmt_mw(value: float | None) -> str:
    if value is None:
        return "—"
    if abs(value) >= 1000:
        return f"{value / 1000:,.1f} GW"
    return f"{value:,.0f} MW"


def _fmt_price(value: float | None, currency: str | None) -> str:
    if value is None:
        return "—"
    return f"{value:,.0f} {currency or '?'}/MWh"


def _table(rows: list[list[str]], header: list[str]) -> str:
    """Plain aligned columns — no dependency earns its keep for this."""
    table = [header, *rows]
    widths = [max(len(r[i]) for r in table) for i in range(len(header))]
    lines = []
    for n, row in enumerate(table):
        lines.append("  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip())
        if n == 0:
            lines.append("  ".join("-" * w for w in widths))
    return "\n".join(lines)


def _cmd_grids(_args: argparse.Namespace, _client: Client) -> int:
    rows = [[g.code, g.name, "yes" if g.has_live else "history-only", g.note or ""] for g in GRIDS]
    print(_table(rows, ["code", "name", "live", "note"]))
    return 0


def _cmd_live(args: argparse.Namespace, client: Client) -> int:
    g = grid(args.grid)
    if not g.has_live:
        # Same guidance the library gives, without the traceback.
        latest = client.history(g.code).days[-1:]
        print(f"{g.name} publishes no standalone live snapshot — latest settled day instead:")
        for day in latest:
            _print_day(g.name, day)
        return 0
    snap = client.live(g.code)
    print(
        f"{g.name} — {snap.date} (baked {snap.generated_at:%Y-%m-%d %H:%M} UTC)"
        if snap.generated_at
        else f"{g.name} — {snap.date}"
    )
    total = snap.total_mw or sum(v for v in snap.mix.values() if v)
    for bucket, mw in sorted(snap.mix.items(), key=lambda kv: -(kv[1] or 0)):
        if not mw:
            continue
        share = f"{100 * mw / total:3.0f}%" if total else "   ?"
        print(f"  {FUEL_LABELS.get(bucket, bucket):<22}{_fmt_mw(mw):>10}  {share}")
    print(f"  {'total':<22}{_fmt_mw(total):>10}")
    if snap.import_mw is not None:
        direction = "net imports" if snap.import_mw >= 0 else "net exports"
        print(f"  {direction:<22}{_fmt_mw(abs(snap.import_mw)):>10}")
    if snap.price is not None:
        print(f"  {'price (day avg)':<22}{_fmt_price(snap.price, snap.currency):>10}")
    intensity = snap.carbon_intensity
    if intensity is not None:
        print(f"  {'est. carbon':<22}{f'{intensity:,.0f} g/kWh':>10}")
    return 0


def _print_day(name: str, day: Any) -> None:
    top = max(day.mix.items(), key=lambda kv: kv[1] or 0) if day.mix else None
    bits = [f"total {_fmt_mw(day.total_mw)}"]
    if top:
        bits.append(f"top {FUEL_LABELS.get(top[0], top[0])} {_fmt_mw(top[1])}")
    if day.price is not None:
        bits.append(f"price {day.price:,.0f}/MWh")
    if day.demand_mw is not None:
        bits.append(f"demand {_fmt_mw(day.demand_mw)}")
    print(f"  {day.date}  {' · '.join(bits)}")


def _cmd_history(args: argparse.Namespace, client: Client) -> int:
    g = grid(args.grid)
    h = client.history(g.code)
    days = h.days[-args.days :] if args.days else h.days
    print(f"{g.name} — {len(days)} of {len(h.days)} days ({h.attribution})")
    for day in days:
        _print_day(g.name, day)
    return 0


def _cmd_coverage(_args: argparse.Namespace, client: Client) -> int:
    cov = client.coverage()
    rows = []
    for g in cov:
        rows.append(
            [
                g.code,
                g.source,
                str(g.per_station_live)
                if g.per_station_live
                else ("browser" if g.browser_live else "—"),
                "yes" if g.prices else "—",
                "yes" if g.demand else "—",
                {"net": "every border", "hvdc": "HVDC only", "none": "—"}[g.flows],
                f"{g.history_days}d/{g.hourly_days}h",
            ]
        )
    print(_table(rows, ["code", "source", "stations", "prices", "demand", "net trade", "history"]))
    if cov.generated_at:
        print(f"\nmeasured from the published files at {cov.generated_at:%Y-%m-%d %H:%M} UTC")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="weg",
        description="Electricity generation, prices, flows and demand for 32 grids — "
        "read-only views over the world-energy-generation package.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument("--base-url", help="read a fork or mirror instead of the atlas")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("grids", help="the 32-grid registry").set_defaults(fn=_cmd_grids)

    live = sub.add_parser("live", help="latest snapshot for one grid")
    live.add_argument("grid", help="grid code, e.g. de")
    live.set_defaults(fn=_cmd_live)

    hist = sub.add_parser("history", help="recent settled days for one grid")
    hist.add_argument("grid", help="grid code, e.g. de")
    hist.add_argument("--days", type=int, default=7, help="how many recent days (default 7)")
    hist.set_defaults(fn=_cmd_history)

    sub.add_parser("coverage", help="what every grid publishes").set_defaults(fn=_cmd_coverage)

    args = parser.parse_args(argv)
    client = Client(args.base_url) if args.base_url else Client()
    try:
        return int(args.fn(args, client))
    except WorldEnergyError as exc:
        print(f"weg: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover — `python -m` convenience
    sys.exit(main())
