"""
world-energy-generation — electricity generation, price, flow and demand data
for 28 power grids across Europe and North America, as typed Python.

Reads the JSON published by Grid Atlas (https://jacobwright32.github.io/uk-grid-atlas/),
which in turn aggregates Elexon/BMRS, ENTSO-E, ERCOT, NYISO and IESO. No API key,
no account, no required dependencies.

    >>> import world_energy_generation as weg
    >>> h = weg.history("de")                       # doctest: +SKIP
    >>> h.days[-1].mix["wind"]                      # doctest: +SKIP
    18422.4
    >>> h.days[-1].carbon_intensity                 # doctest: +SKIP
    311.7
    >>> weg.generation(["de", "fr"])                # doctest: +SKIP  (needs pandas)

Two datasets:

``history(code)``
    A rolling ~31 days of daily means plus the last several days (7-8) at hourly
    resolution. Available for all 28 grids. This is the uniform surface — reach
    for it first.

``live(code)``
    The most recent snapshot. Available for 27 grids; Great Britain's is
    compiled into the atlas web app rather than published as JSON, so
    ``live("gb")`` raises :class:`DataNotPublished` and points you at history.

Three things to know before you publish a number from this:

1. A fuel bucket absent from a mix was **not reported**, not zero. Switzerland
   publishes four buckets, Spain nine. The frame builders keep that as ``NaN``
   and will not fill it.
2. ``us`` is ERCOT plus NYISO, not the contiguous United States, and ``ca`` is
   Ontario. Every grid carries a ``note``; ``weg.grid("us").note`` says so.
3. Carbon intensity is derived here from coarse lifecycle factors, not measured
   upstream. Fine for comparing grids, not for compliance.

Cite the upstream operators rather than this package: ``history.attribution``
gives the right string per grid (ENTSO-E for the European grids, Elexon for GB,
IESO for Ontario, ERCOT + NYISO for the US).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .client import (
    DEFAULT_BASE_URL,
    Client,
    default_client,
    set_default_client,
)
from .exceptions import (
    DataNotPublished,
    FetchError,
    GridNotFound,
    PandasRequired,
    SchemaError,
    WorldEnergyError,
)
from .fuels import (
    CARBON_FACTORS,
    FUEL_LABELS,
    FUELS,
    LOW_CARBON,
    carbon_intensity,
    is_low_carbon,
)
from .grids import GRIDS, Grid, codes, grid, grids
from .models import (
    HISTORY_VERSION,
    KNOWN_HISTORY_VERSIONS,
    DayRecord,
    History,
    HourRecord,
    LiveSnapshot,
)

__version__ = "0.1.0"

# Grouped by what a reader is looking for rather than alphabetically, which is
# why RUF022 is silenced here: this list doubles as a table of contents.
__all__ = [  # noqa: RUF022
    # datasets
    "history",
    "live",
    "latest",
    # tidy frames (need pandas)
    "generation",
    "prices",
    "demand",
    "grids_frame",
    # registry
    "Grid",
    "GRIDS",
    "grids",
    "grid",
    "codes",
    # records
    "History",
    "DayRecord",
    "HourRecord",
    "LiveSnapshot",
    "HISTORY_VERSION",
    "KNOWN_HISTORY_VERSIONS",
    # fuels
    "FUELS",
    "FUEL_LABELS",
    "CARBON_FACTORS",
    "LOW_CARBON",
    "carbon_intensity",
    "is_low_carbon",
    # transport
    "Client",
    "DEFAULT_BASE_URL",
    "default_client",
    "set_default_client",
    # errors
    "WorldEnergyError",
    "GridNotFound",
    "DataNotPublished",
    "FetchError",
    "SchemaError",
    "PandasRequired",
    "__version__",
]


def history(code: str, *, client: Client | None = None) -> History:
    """
    Rolling ~31-day history for one grid. Available for all 28.

    >>> history("no").days[-1].mix["hydro"]     # doctest: +SKIP
    12844.0

    The window rolls and the atlas drops the oldest day on each refresh, so
    persist what you fetch if you need a fixed period.
    """
    return (client or default_client()).history(code)


def live(code: str, *, client: Client | None = None) -> LiveSnapshot:
    """
    Most recent snapshot for one grid. Available for 27 of 28.

    Raises :class:`DataNotPublished` for ``"gb"``, whose snapshot is bundled into
    the atlas's JavaScript rather than served as JSON — use :func:`history`.

    "Live" means last committed refresh, roughly six-hourly. Check
    ``.generated_at`` before calling anything here current.
    """
    return (client or default_client()).live(code)


def latest(code: str, *, client: Client | None = None) -> DayRecord | None:
    """
    Most recent complete day for one grid, from history. ``None`` if empty.

    Works for all 22 including Great Britain, which is the point — it is the
    portable way to ask "what happened most recently" without special-casing
    the one grid with no live JSON.
    """
    days = history(code, client=client).days
    return days[-1] if days else None


def generation(
    codes: str | Sequence[str] | None = None,
    *,
    client: Client | None = None,
    hourly: bool = False,
) -> Any:
    """Tidy generation across grids as a DataFrame. See :func:`.frames.generation`."""
    from .frames import generation as _generation

    return _generation(codes, client=client, hourly=hourly)


def prices(codes: str | Sequence[str] | None = None, *, client: Client | None = None) -> Any:
    """Daily prices across grids as a DataFrame. See :func:`.frames.prices`."""
    from .frames import prices as _prices

    return _prices(codes, client=client)


def demand(codes: str | Sequence[str] | None = None, *, client: Client | None = None) -> Any:
    """Daily mean load across grids as a DataFrame. See :func:`.frames.demand`."""
    from .frames import demand as _demand

    return _demand(codes, client=client)


def grids_frame() -> Any:
    """The 22-grid registry as a DataFrame. See :func:`.frames.grids_frame`."""
    from .frames import grids_frame as _grids_frame

    return _grids_frame()
