"""The grid registry: which power systems this package can fetch, and what they are.

A "grid" here is whatever the upstream publisher treats as one balancing scope,
which is not always one country. Ireland is the all-island SEM market covering
two jurisdictions; ``us`` is a partial CONUS view assembled from the ISOs that
publish openly; ``ca`` is Ontario alone rather than all of Canada. The names
below say so, because a column labelled "Canada" that means Ontario is a bug
waiting to be published in someone's paper.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

__all__ = ["GRIDS", "Grid", "codes", "grid", "grids"]


@dataclass(frozen=True)
class Grid:
    """One power system available from the atlas."""

    code: str
    """Two-letter lowercase key used in every URL and API call (``"de"``)."""

    name: str
    """Human-readable scope, honest about partial coverage."""

    region: str
    """``"europe"`` or ``"north-america"``."""

    timezone: str | None
    """
    Nominal local timezone, for display and for locating a grid in the day.

    This is *not* a promise about how ``date`` values are bucketed: day
    boundaries come from the upstream publisher, and for the multi-zone grids
    that is a market convention rather than wall-clock local midnight. ``None``
    where the scope spans several zones (``us``).
    """

    has_live: bool
    """
    Whether ``live(code)`` works.

    True for 31 of 32. Great Britain is the exception: its snapshot is compiled
    into the atlas's JavaScript bundle rather than served as standalone JSON, so
    there is no URL to fetch. ``history("gb")`` works normally.
    """

    operator: str = "ENTSO-E Transparency Platform"
    """
    Who actually publishes this grid's numbers — the attribution to cite.

    Needed because the data files are inconsistent here: only ``gb``, ``ca`` and
    ``us`` carry a ``sourceLabel``, and the ``basis`` field on live snapshots
    reads ``"entsoe"`` for *every* grid including the North American ones, which
    is a frontend enum rather than provenance. Where a file does carry a
    ``sourceLabel`` it wins; this is the fallback, taken from the atlas's own
    source table.
    """

    note: str = ""
    """Caveat worth surfacing to anyone about to do arithmetic on this grid."""

    @property
    def is_partial(self) -> bool:
        """True where the grid covers less than the name's country suggests."""
        return bool(self.note)


# Ordered roughly as the atlas presents them: GB first, then the ENTSO-E grids
# west to east, then North America.
_ENTSOE = "ENTSO-E Transparency Platform"

GRIDS: tuple[Grid, ...] = (
    Grid(
        "gb",
        "United Kingdom",
        "europe",
        "Europe/London",
        False,
        operator="Elexon (BMRS / Insights)",
        note="Live snapshot is bundled into the web app, not published as JSON; "
        "history is available.",
    ),
    Grid(
        "ie",
        "Ireland (all-island)",
        "europe",
        "Europe/Dublin",
        True,
        operator=_ENTSOE,
        note="Generation covers the all-island SEM market (Republic + Northern "
        "Ireland); demand is EirGrid's control area, so the Republic only.",
    ),
    Grid("pt", "Portugal", "europe", "Europe/Lisbon", True),
    Grid("es", "Spain", "europe", "Europe/Madrid", True),
    Grid("fr", "France", "europe", "Europe/Paris", True),
    Grid("be", "Belgium", "europe", "Europe/Brussels", True),
    Grid("nl", "Netherlands", "europe", "Europe/Amsterdam", True),
    Grid("de", "Germany", "europe", "Europe/Berlin", True),
    Grid("ch", "Switzerland", "europe", "Europe/Zurich", True),
    Grid("it", "Italy", "europe", "Europe/Rome", True),
    Grid("at", "Austria", "europe", "Europe/Vienna", True),
    Grid("cz", "Czechia", "europe", "Europe/Prague", True),
    Grid("si", "Slovenia", "europe", "Europe/Ljubljana", True),
    Grid("hu", "Hungary", "europe", "Europe/Budapest", True),
    Grid("sk", "Slovakia", "europe", "Europe/Bratislava", True),
    Grid("hr", "Croatia", "europe", "Europe/Zagreb", True),
    Grid("bg", "Bulgaria", "europe", "Europe/Sofia", True),
    Grid("gr", "Greece", "europe", "Europe/Athens", True),
    Grid("ro", "Romania", "europe", "Europe/Bucharest", True),
    # ba carries no note on purpose: coverage is national (is_partial stays
    # False) — it just has no day-ahead prices, which the data itself says
    # via currency being null and price None on every record.
    Grid("ba", "Bosnia and Herzegovina", "europe", "Europe/Sarajevo", True),
    Grid("rs", "Serbia", "europe", "Europe/Belgrade", True),
    Grid("mk", "North Macedonia", "europe", "Europe/Skopje", True),
    Grid("pl", "Poland", "europe", "Europe/Warsaw", True),
    Grid("dk", "Denmark", "europe", "Europe/Copenhagen", True),
    Grid("no", "Norway", "europe", "Europe/Oslo", True),
    Grid("se", "Sweden", "europe", "Europe/Stockholm", True),
    Grid("fi", "Finland", "europe", "Europe/Helsinki", True),
    Grid("ee", "Estonia", "europe", "Europe/Tallinn", True),
    Grid("lv", "Latvia", "europe", "Europe/Riga", True),
    Grid("lt", "Lithuania", "europe", "Europe/Vilnius", True),
    Grid(
        "us",
        "United States (Texas + New York)",
        "north-america",
        None,
        True,
        operator="ERCOT + NYISO",
        note="Only the two ISOs that publish fuel mix openly — roughly a third of "
        "US generation, not a national figure. No US ISO publishes per-plant "
        "output openly, so this grid is mix-only and has no prices.",
    ),
    Grid(
        "ca",
        "Canada (Ontario)",
        "north-america",
        "America/Toronto",
        True,
        operator="IESO",
        note="Ontario (IESO) only, not national. Prices are Ontario zonal, in CAD.",
    ),
)

_BY_CODE: dict[str, Grid] = {g.code: g for g in GRIDS}


def grids(region: str | None = None, *, live_only: bool = False) -> list[Grid]:
    """
    Every grid, optionally filtered.

    >>> [g.code for g in grids(region="north-america")]
    ['us', 'ca']
    """
    out: Iterator[Grid] = iter(GRIDS)
    if region is not None:
        want = region.strip().lower()
        aliases = {"eu": "europe", "na": "north-america", "north america": "north-america"}
        want = aliases.get(want, want)
        out = (g for g in out if g.region == want)
    if live_only:
        out = (g for g in out if g.has_live)
    return list(out)


def grid(code: str) -> Grid:
    """
    Look up one grid by code, case-insensitively.

    Raises :class:`~world_energy_generation.exceptions.GridNotFound` with the
    valid codes listed, because a typo here is the most likely first mistake
    anyone makes with this package.
    """
    from .exceptions import GridNotFound

    key = code.strip().lower()
    try:
        return _BY_CODE[key]
    except KeyError:
        raise GridNotFound(code, sorted(_BY_CODE)) from None


def codes() -> list[str]:
    """All grid codes, in registry order."""
    return [g.code for g in GRIDS]
