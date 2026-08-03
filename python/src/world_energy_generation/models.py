"""Typed records for the two published datasets.

These are plain frozen dataclasses with no dependencies, so the package is
usable without pandas. Anything DataFrame-shaped lives in :mod:`.frames` and is
reached through the ``to_frame()`` methods here.

A note on missing values, because it is the thing most likely to bite: upstream
distinguishes "not reported" from "zero", and so does this. A fuel bucket absent
from ``mix`` was never reported by that grid. A ``None`` in an hourly series is
an hour the publisher did not cover. Neither is a zero, and summing them as zero
will quietly understate a grid.
"""

from __future__ import annotations

import warnings
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date as _date
from datetime import datetime as _datetime
from datetime import timezone as _timezone
from typing import Any

from .exceptions import SchemaError
from .fuels import carbon_intensity

__all__ = [
    "HISTORY_VERSION",
    "KNOWN_HISTORY_VERSIONS",
    "Coverage",
    "DayRecord",
    "GridCoverage",
    "History",
    "HourRecord",
    "LiveSnapshot",
]

HISTORY_VERSION = 3
"""Newest history schema version this package was written against."""

KNOWN_HISTORY_VERSIONS: frozenset[int] = frozenset({2, 3})
"""
Versions known to parse correctly.

Version 2 is v3 minus demand — ``days[].demandMW`` and ``hourly[].demand`` were
added in 3, and everything else was unchanged. Both parse here, because the
difference is additive and absent demand is already modelled as ``None``.

A *newer* version than :data:`HISTORY_VERSION` also parses, with a
:class:`UserWarning`, on the same reasoning: upstream's one schema bump so far
was purely additive, and hard-failing would break every pinned install the day
the atlas adds a field. Read the warning, then upgrade. Anything older than the
oldest known version raises :class:`~.exceptions.SchemaError` instead — fields
this package requires may simply not be there.
"""


def _as_date(value: Any, where: str) -> _date:
    if not isinstance(value, str):
        raise SchemaError(f"{where}: expected an ISO date string, got {type(value).__name__}")
    try:
        return _date.fromisoformat(value)
    except ValueError as exc:
        raise SchemaError(f"{where}: {value!r} is not an ISO date") from exc


def _as_datetime(value: Any) -> _datetime | None:
    """
    Parse an upstream ISO timestamp into a tz-aware datetime, or ``None``.

    Deliberately lenient: this is metadata about when a file was written, and a
    publisher typo in it must not make an entire grid unreadable. A value that
    will not parse comes back as ``None``.

    Two details the standard library will not do for you on every supported
    Python: upstream stamps these ``...Z``, which :meth:`datetime.fromisoformat`
    only accepts from 3.11, and a naive string is assumed to be UTC — which it is,
    for every file the atlas publishes.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = _datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=_timezone.utc)


def _clean_mix(raw: Any, where: str) -> dict[str, float]:
    """Drop nulls and non-numerics; keep absence as absence."""
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise SchemaError(f"{where}: expected an object of fuel -> MW")
    out: dict[str, float] = {}
    for key, value in raw.items():
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out[str(key)] = float(value)
    return out


def _series(raw: Any, where: str, length: int = 24) -> list[float | None]:
    """Normalise an hourly series to exactly ``length`` slots, padding with None."""
    if raw is None:
        return [None] * length
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        raise SchemaError(f"{where}: expected a list of {length} hourly values")
    out: list[float | None] = [
        float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None for v in raw
    ]
    if len(out) < length:
        out.extend([None] * (length - len(out)))
    return out[:length]


@dataclass(frozen=True)
class DayRecord:
    """One calendar day of daily-average figures."""

    date: _date
    mix: dict[str, float]
    """Mean output per fuel bucket, MW. Absent bucket = not reported by this grid."""
    total_mw: float | None
    """Publisher's total generation. May exceed ``sum(mix)`` where buckets are withheld."""
    import_mw: float | None
    """Net imports, MW. Negative means the grid was a net exporter."""
    price: float | None
    """Day-ahead wholesale price in the file's currency, per MWh."""
    demand_mw: float | None
    """Mean load, MW. ``None`` where the publisher reports no load for this scope."""

    @property
    def carbon_intensity(self) -> float | None:
        """Generation-weighted gCO2e/kWh for this day. See :func:`~.fuels.carbon_intensity`."""
        return carbon_intensity(self.mix)  # type: ignore[arg-type]

    @classmethod
    def _parse(cls, raw: Mapping[str, Any], where: str) -> DayRecord:
        return cls(
            date=_as_date(raw.get("date"), where),
            mix=_clean_mix(raw.get("mix"), f"{where}.mix"),
            total_mw=_num(raw.get("totalMW")),
            import_mw=_num(raw.get("importMW")),
            price=_num(raw.get("price")),
            demand_mw=_num(raw.get("demandMW")),
        )


@dataclass(frozen=True)
class HourRecord:
    """One day at hourly resolution. Every series is exactly 24 slots."""

    date: _date
    mix_series: dict[str, list[float | None]]
    """Per-bucket hourly output, MW. 24 slots each."""
    import_series: list[float | None]
    demand_series: list[float | None]
    prices: list[float | None]
    flow_series: dict[str, list[float | None]] = field(default_factory=dict)
    """Per-interconnector hourly flow, MW, keyed by the atlas's link id."""

    def hour(self, index: int) -> dict[str, float | None]:
        """
        One hour as a flat mapping, for iterating without index gymnastics.

        >>> rec.hour(13)["wind"]        # doctest: +SKIP
        4120.0
        """
        if not 0 <= index < 24:
            raise IndexError(f"hour must be 0-23, got {index}")
        out: dict[str, float | None] = {
            bucket: series[index] for bucket, series in self.mix_series.items()
        }
        out["import_mw"] = self.import_series[index]
        out["demand_mw"] = self.demand_series[index]
        out["price"] = self.prices[index]
        return out

    @classmethod
    def _parse(cls, raw: Mapping[str, Any], where: str) -> HourRecord:
        mix_raw = raw.get("mixSeries") or {}
        if not isinstance(mix_raw, Mapping):
            raise SchemaError(f"{where}.mixSeries: expected an object of fuel -> series")
        return cls(
            date=_as_date(raw.get("date"), where),
            mix_series={str(k): _series(v, f"{where}.mixSeries.{k}") for k, v in mix_raw.items()},
            import_series=_series(raw.get("importSeries"), f"{where}.importSeries"),
            demand_series=_series(raw.get("demand"), f"{where}.demand"),
            prices=_series(raw.get("prices"), f"{where}.prices"),
            flow_series={
                str(k): _series(v, f"{where}.flowSeries.{k}")
                for k, v in (raw.get("flowSeries") or {}).items()
            },
        )


@dataclass(frozen=True)
class History:
    """
    A grid's rolling history: around 31 daily records and the last several days
    (currently 7-8) at hourly resolution.

    The window rolls — the atlas refreshes every six hours and drops the oldest
    day — so this is a moving view, not an archive. Neither length is guaranteed:
    read ``len(days)`` rather than assuming 31, and note that a newly added grid
    starts with far fewer. If you need a fixed period, persist what you fetch.
    """

    code: str
    currency: str | None
    """
    Currency of ``price``, e.g. ``"EUR"``. ``"CAD"`` for Ontario, ``"GBP"`` for GB,
    ``"USD"`` for ``us`` (day-ahead, mean of ERCOT hub + NYISO zones).
    """
    source_label: str | None
    """
    Upstream attribution string exactly as published, or ``None``.

    Populated only for ``gb``, ``ca`` and ``us``; the ENTSO-E grids publish it as
    null. Use :attr:`attribution`, which falls back to the registry, rather than
    reading this directly.
    """
    updated_at: _datetime | None
    """
    When the publisher wrote this file, tz-aware (UTC), or ``None``.

    ``None`` means the field was absent or unparseable, not that the file is old.
    """
    days: list[DayRecord]
    hourly: list[HourRecord]
    version: int = HISTORY_VERSION

    @property
    def grid(self) -> Any:
        """The :class:`~.grids.Grid` this history belongs to."""
        from .grids import grid as _lookup

        return _lookup(self.code)

    @property
    def attribution(self) -> str:
        """
        Who to credit for these numbers.

        The file's own ``sourceLabel`` when it has one, otherwise the operator
        from the registry. Cite this rather than this package — the package moved
        the bytes, the TSO measured them.

        >>> history("de").attribution        # doctest: +SKIP
        'ENTSO-E Transparency Platform'
        """
        return self.source_label or str(self.grid.operator)

    def day(self, when: str | _date) -> DayRecord | None:
        """One day by ISO string or ``date``; ``None`` if outside the window."""
        target = when if isinstance(when, _date) else _date.fromisoformat(when)
        return next((d for d in self.days if d.date == target), None)

    def window(
        self,
        since: str | _date | None = None,
        until: str | _date | None = None,
    ) -> History:
        """
        A copy trimmed to ``since``..``until`` (ISO strings or ``date``, both
        inclusive), applied to daily and hourly records alike.

        Client-side sugar over the one rolling file the atlas publishes —
        asking for dates older than the window yields an empty result, not an
        archive fetch.
        """
        lo = _date.fromisoformat(since) if isinstance(since, str) else since
        hi = _date.fromisoformat(until) if isinstance(until, str) else until

        def keep(d: _date) -> bool:
            return (lo is None or d >= lo) and (hi is None or d <= hi)

        return History(
            code=self.code,
            currency=self.currency,
            source_label=self.source_label,
            updated_at=self.updated_at,
            days=[d for d in self.days if keep(d.date)],
            hourly=[h for h in self.hourly if keep(h.date)],
            version=self.version,
        )

    def carbon_intensity(self) -> dict[_date, float | None]:
        """Derived gCO2e/kWh per day, in date order."""
        return {d.date: d.carbon_intensity for d in self.days}

    def to_frame(self) -> Any:
        """One row per day: fuel columns in MW, plus price, demand, total, imports."""
        from .frames import history_frame

        return history_frame(self)

    def hourly_frame(self) -> Any:
        """One row per hour, indexed by timestamp. 24 rows per hourly day."""
        from .frames import hourly_frame

        return hourly_frame(self)

    @classmethod
    def _parse(cls, code: str, raw: Mapping[str, Any]) -> History:
        version = _check_version(code, raw.get("version"))
        days = [
            DayRecord._parse(d, f"{code}.days[{i}]")
            for i, d in enumerate(raw.get("days") or [])
            if isinstance(d, Mapping)
        ]
        hourly = [
            HourRecord._parse(h, f"{code}.hourly[{i}]")
            for i, h in enumerate(raw.get("hourly") or [])
            if isinstance(h, Mapping)
        ]
        return cls(
            code=code,
            currency=_str_or_none(raw.get("currency")),
            source_label=_str_or_none(raw.get("sourceLabel")),
            updated_at=_as_datetime(raw.get("updatedAt")),
            days=sorted(days, key=lambda d: d.date),
            hourly=sorted(hourly, key=lambda h: h.date),
            version=version,
        )


@dataclass(frozen=True)
class LiveSnapshot:
    """
    The most recent snapshot for one grid, refreshed roughly every six hours.

    "Live" is the atlas's word, and it means "last committed refresh" — not
    real-time. ``generated_at`` is the honest timestamp; check it before
    describing anything here as current.
    """

    code: str
    date: _date
    generated_at: _datetime | None
    """
    When this snapshot was written, tz-aware (UTC), or ``None``.

    Compare it against :func:`datetime.now(timezone.utc)` before calling anything
    here current — a stale refresh looks exactly like a fresh one otherwise.
    """
    basis: str | None
    """
    The atlas's internal pipeline tag, e.g. ``"entsoe"``.

    **Not provenance.** It reads ``"entsoe"`` for all 31 grids that publish a
    snapshot, including Ontario (IESO) and the US ISOs, because upstream it is a
    frontend enum rather than a source field. For attribution use
    :attr:`attribution`.
    """
    mix: dict[str, float]
    """Latest per-bucket output, MW."""
    total_mw: float | None
    import_mw: float | None
    currency: str | None
    price: float | None
    demand_mw: float | None
    source_label: str | None
    mix_series: dict[str, list[float | None]] = field(default_factory=dict)
    demand_series: list[float | None] = field(default_factory=list)
    prices: list[float | None] = field(default_factory=list)

    @property
    def carbon_intensity(self) -> float | None:
        """Generation-weighted gCO2e/kWh at snapshot time."""
        return carbon_intensity(self.mix)  # type: ignore[arg-type]

    @property
    def grid(self) -> Any:
        """The :class:`~.grids.Grid` this snapshot belongs to."""
        from .grids import grid as _lookup

        return _lookup(self.code)

    @property
    def attribution(self) -> str:
        """Who to credit — the file's ``sourceLabel``, else the registry operator."""
        return self.source_label or str(self.grid.operator)

    @classmethod
    def _parse(cls, code: str, raw: Mapping[str, Any]) -> LiveSnapshot:
        snap = raw.get("mix") if isinstance(raw.get("mix"), Mapping) else {}
        # Two shapes carry the same numbers. `mix.fuels` is a list of
        # {key, label, mw}; `mixRows` is the display list, {key, label, color,
        # nowMW, capMW}. Prefer the former, fall back to the latter.
        fuels = _rows_to_mix((snap or {}).get("fuels"), "mw", f"{code}.mix.fuels")
        if not fuels:
            fuels = _rows_to_mix(raw.get("mixRows"), "nowMW", f"{code}.mixRows")
        prices_raw = raw.get("prices") if isinstance(raw.get("prices"), Mapping) else {}
        price_series = _series((prices_raw or {}).get("series"), f"{code}.prices.series")
        demand_series = _series(raw.get("demandSeries"), f"{code}.demandSeries")
        return cls(
            code=code,
            date=_as_date(raw.get("date"), f"{code}.date"),
            generated_at=_as_datetime(raw.get("generatedAt")),
            basis=_str_or_none(raw.get("basis")),
            mix=fuels,
            total_mw=_num((snap or {}).get("totalMW")),
            import_mw=_num((snap or {}).get("importMW")),
            currency=_str_or_none((prices_raw or {}).get("currency")),
            price=_mean(price_series),
            demand_mw=_mean(demand_series),
            source_label=_str_or_none(raw.get("sourceLabel")),
            mix_series={
                str(k): _series(v, f"{code}.mixSeries.{k}")
                for k, v in (raw.get("mixSeries") or {}).items()
            },
            demand_series=demand_series,
            prices=price_series,
        )


def _rows_to_mix(raw: Any, value_key: str, where: str) -> dict[str, float]:
    """Fold a list of ``{key, <value_key>}`` rows into a ``{bucket: MW}`` mapping.

    Also accepts a plain mapping, so a future upstream simplification from rows
    to an object does not break the parser.
    """
    if raw is None:
        return {}
    if isinstance(raw, Mapping):
        return _clean_mix(raw, where)
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        raise SchemaError(f"{where}: expected a list of fuel rows or an object of fuel -> MW")
    out: dict[str, float] = {}
    for row in raw:
        if not isinstance(row, Mapping):
            continue
        key, value = row.get("key"), row.get(value_key)
        if isinstance(key, str) and isinstance(value, (int, float)) and not isinstance(value, bool):
            out[key] = float(value)
    return out


_warned_versions: set[int] = set()


def _check_version(code: str, version: Any) -> int:
    """Accept known versions, tolerate newer ones with a warning, reject older."""
    if isinstance(version, bool) or not isinstance(version, int):
        raise SchemaError(
            f"history/{code}.json has version {version!r}, which is not an integer. "
            "This does not look like an atlas history file — check the base URL."
        )
    if version in KNOWN_HISTORY_VERSIONS:
        return int(version)
    if version > HISTORY_VERSION:
        if version not in _warned_versions:
            _warned_versions.add(version)
            warnings.warn(
                f"history/{code}.json is schema version {version}, newer than the {HISTORY_VERSION} "
                "this world-energy-generation release was written against. Parsing anyway "
                "(past bumps were additive), but new fields will be ignored — upgrade the package.",
                UserWarning,
                stacklevel=4,
            )
        return int(version)
    raise SchemaError(
        f"history/{code}.json is schema version {version}, older than the oldest "
        f"version this package can read ({min(KNOWN_HISTORY_VERSIONS)}). "
        "This is probably a stale cached or mirrored copy; refetch from the atlas."
    )


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _str_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _mean(series: Sequence[float | None]) -> float | None:
    """Mean over covered slots only — an uncovered hour must not read as zero."""
    covered = [v for v in series if v is not None]
    if not covered:
        return None
    return round(sum(covered) / len(covered), 2)


@dataclass(frozen=True)
class GridCoverage:
    """
    What one grid measurably publishes. Every field here was computed by the
    atlas workflow from the published files themselves at bake time — "prices
    is False" means the feed carried none, not that the app hides them.
    """

    code: str
    source: str
    """Pipeline label — "ENTSO-E", "Elexon", "IESO", "ERCOT + NYISO"."""
    snapshot: bool
    """Whether a standalone live JSON exists (False only for ``gb``)."""
    browser_live: bool
    """True for grids whose live layer is fetched by the browser (``gb``)."""
    generated_at: _datetime | None
    metered_date: _date | None
    per_station_live: int
    """Stations with any per-unit output in the latest snapshot."""
    intraday: bool
    """Today-so-far mix present (fresher than the metered day)."""
    prices: bool
    demand: bool
    flows: str
    """
    Trade measurement: ``"net"`` — the signed position over *every* border;
    ``"hvdc"`` — mapped HVDC links only; ``"none"`` — nothing measured.
    """
    links: int
    """Mapped HVDC links with per-link flow series."""
    history_days: int
    hourly_days: int
    per_station_history_days: int
    price_days: int
    demand_days: int
    currency: str | None

    @classmethod
    def _parse(cls, code: str, raw: Mapping[str, Any]) -> GridCoverage:
        def _int(value: Any) -> int:
            n = _num(value)
            return int(n) if n is not None else 0

        metered = raw.get("meteredDate")
        try:
            metered_date = _date.fromisoformat(metered) if isinstance(metered, str) else None
        except ValueError:
            metered_date = None
        flows = raw.get("flows")
        return cls(
            code=code,
            source=_str_or_none(raw.get("source")) or "ENTSO-E",
            snapshot=bool(raw.get("snapshot")),
            browser_live=bool(raw.get("browserLive")),
            generated_at=_as_datetime(raw.get("generatedAt")),
            metered_date=metered_date,
            per_station_live=_int(raw.get("perStationLive")),
            intraday=bool(raw.get("intraday")),
            prices=bool(raw.get("prices")),
            demand=bool(raw.get("demand")),
            flows=flows if flows in ("net", "hvdc", "none") else "none",
            links=_int(raw.get("links")),
            history_days=_int(raw.get("historyDays")),
            hourly_days=_int(raw.get("hourlyDays")),
            per_station_history_days=_int(raw.get("perStationHistoryDays")),
            price_days=_int(raw.get("priceDays")),
            demand_days=_int(raw.get("demandDays")),
            currency=_str_or_none(raw.get("currency")),
        )


@dataclass(frozen=True)
class Coverage:
    """
    Measured publication coverage for every grid (``live/coverage.json``).

    The per-grid answer to "why does Bosnia show no prices?" — because the
    feed publishes none, and this file proves it was checked. Rebaked with
    every snapshot refresh, so the claims are as fresh as the data.
    """

    generated_at: _datetime | None
    grids: dict[str, GridCoverage]
    version: int = 1

    def __getitem__(self, code: str) -> GridCoverage:
        """Coverage for one grid, accepting any registry alias."""
        from .grids import grid as _lookup

        return self.grids[_lookup(code).code]

    def __iter__(self) -> Any:
        return iter(self.grids.values())

    def __len__(self) -> int:
        return len(self.grids)

    def to_frame(self) -> Any:
        """One row per grid. Needs pandas."""
        from .frames import coverage_frame

        return coverage_frame(self)

    @classmethod
    def _parse(cls, raw: Mapping[str, Any]) -> Coverage:
        grids_raw = raw.get("grids")
        grids: dict[str, GridCoverage] = {}
        if isinstance(grids_raw, Mapping):
            for code, entry in grids_raw.items():
                if isinstance(entry, Mapping):
                    grids[str(code)] = GridCoverage._parse(str(code), entry)
        version = raw.get("version")
        return cls(
            generated_at=_as_datetime(raw.get("generatedAt")),
            grids=grids,
            version=int(version) if isinstance(version, int) else 1,
        )
