"""pandas builders. Optional — nothing else in the package imports this eagerly.

Every function here raises :class:`~.exceptions.PandasRequired` with install
instructions if pandas is absent, rather than an ``ImportError`` from three
frames deep.

One rule runs through all of it: **a bucket a grid does not report stays NaN.**
It is tempting to ``fillna(0)`` so the columns add up, and it is wrong — Swiss
wind is not zero, it is unpublished, and a mean over zeros is a fabricated
number. If you want zeros you can ask for them; the default will not guess.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import TYPE_CHECKING, Any

from .exceptions import PandasRequired
from .fuels import FUELS

if TYPE_CHECKING:  # pragma: no cover
    from .models import History

__all__ = [
    "demand",
    "generation",
    "grids_frame",
    "history_frame",
    "hourly_frame",
    "prices",
]


def _pandas(what: str) -> Any:
    try:
        import pandas as pd
    except ImportError as exc:  # pragma: no cover - depends on install extras
        raise PandasRequired(what) from exc
    return pd


def _fuel_order(seen: Iterable[str]) -> list[str]:
    """Known buckets in canonical order, then anything new, alphabetically.

    Upstream could add a bucket before this package knows about it. Sorting the
    unknown tail rather than dropping it means a new fuel shows up in the frame
    on the day it appears, just at the right-hand end.
    """
    seen = set(seen)
    known = [f for f in FUELS if f in seen]
    return known + sorted(seen - set(FUELS))


def history_frame(history: History) -> Any:
    """
    One row per day, indexed by date.

    Columns: one per reported fuel bucket in MW, then ``total_mw``,
    ``import_mw``, ``demand_mw``, ``price``, ``carbon_intensity``.

    >>> history("de").to_frame().tail(3)["wind"]   # doctest: +SKIP
    """
    pd = _pandas("history_frame()")
    buckets = _fuel_order(b for d in history.days for b in d.mix)
    rows = []
    for day in history.days:
        row: dict[str, Any] = {b: day.mix.get(b) for b in buckets}
        row.update(
            total_mw=day.total_mw,
            import_mw=day.import_mw,
            demand_mw=day.demand_mw,
            price=day.price,
            carbon_intensity=day.carbon_intensity,
        )
        rows.append(row)
    frame = pd.DataFrame(rows, index=pd.DatetimeIndex([d.date for d in history.days], name="date"))
    frame.attrs.update(
        code=history.code,
        currency=history.currency,
        source_label=history.source_label,
        updated_at=history.updated_at,
    )
    return frame


def hourly_frame(history: History) -> Any:
    """
    One row per hour, indexed by naive local timestamp — 24 rows per hourly day,
    so currently 168-192.

    The index is built as ``date + hour`` from the publisher's own day buckets,
    so it is *nominal* local time: on the two DST changeover days a grid's day
    is 23 or 25 hours upstream, and this frame still shows 24 slots. Do not
    localise it and expect the arithmetic to survive; if you need true instants,
    take them from the upstream API rather than inferring them here.

    Interconnector flows are prefixed ``flow_`` so they never collide with a
    fuel column.
    """
    pd = _pandas("hourly_frame()")
    buckets = _fuel_order(b for h in history.hourly for b in h.mix_series)
    links = sorted({k for h in history.hourly for k in h.flow_series})

    index: list[Any] = []
    rows: list[dict[str, Any]] = []
    for record in history.hourly:
        midnight = pd.Timestamp(record.date)
        for hour in range(24):
            index.append(midnight + pd.Timedelta(hours=hour))
            row: dict[str, Any] = {
                b: (record.mix_series[b][hour] if b in record.mix_series else None) for b in buckets
            }
            row.update(
                import_mw=record.import_series[hour],
                demand_mw=record.demand_series[hour],
                price=record.prices[hour],
            )
            for link in links:
                series = record.flow_series.get(link)
                row[f"flow_{link}"] = series[hour] if series else None
            rows.append(row)

    frame = pd.DataFrame(rows, index=pd.DatetimeIndex(index, name="timestamp"))
    frame.attrs.update(
        code=history.code,
        currency=history.currency,
        source_label=history.source_label,
        updated_at=history.updated_at,
    )
    return frame


# ---- multi-grid tidy frames ---------------------------------------------


def _resolve(codes: str | Sequence[str] | None) -> list[str]:
    from .grids import codes as all_codes

    if codes is None:
        return all_codes()
    if isinstance(codes, str):
        return [codes]
    return list(codes)


def _histories(codes: str | Sequence[str] | None, client: Any) -> list[History]:
    from .client import default_client

    fetch = client or default_client()
    return [fetch.history(code) for code in _resolve(codes)]


def generation(
    codes: str | Sequence[str] | None = None,
    *,
    client: Any = None,
    hourly: bool = False,
) -> Any:
    """
    Tidy generation across one, several, or all grids.

    Long format — ``grid``, ``date`` (or ``timestamp``), ``fuel``, ``mw`` — which
    is what you want for grouping and plotting. Pass nothing for all 32, which is
    22 HTTP requests, so let the client cache do its job.

    Rows for buckets a grid does not report are omitted rather than emitted as
    NaN: in long format an absent row *is* the absence, and carrying explicit
    nulls would only invite someone to sum them.

    >>> generation(["de", "fr"]).groupby(["grid", "fuel"]).mw.mean()  # doctest: +SKIP
    """
    pd = _pandas("generation()")
    frames = []
    for history in _histories(codes, client):
        if hourly:
            for record in history.hourly:
                midnight = pd.Timestamp(record.date)
                for bucket, series in record.mix_series.items():
                    for hour, value in enumerate(series):
                        if value is None:
                            continue
                        frames.append(
                            {
                                "grid": history.code,
                                "timestamp": midnight + pd.Timedelta(hours=hour),
                                "fuel": bucket,
                                "mw": value,
                            }
                        )
        else:
            for day in history.days:
                for bucket, value in day.mix.items():
                    frames.append(
                        {"grid": history.code, "date": day.date, "fuel": bucket, "mw": value}
                    )
    time_col = "timestamp" if hourly else "date"
    frame = pd.DataFrame(frames, columns=["grid", time_col, "fuel", "mw"])
    if not frame.empty:
        frame[time_col] = pd.to_datetime(frame[time_col])
    return frame.sort_values(["grid", time_col, "fuel"], ignore_index=True)


def prices(
    codes: str | Sequence[str] | None = None,
    *,
    client: Any = None,
) -> Any:
    """
    Daily day-ahead prices across grids: ``grid``, ``date``, ``price``, ``currency``.

    **Currencies are not converted.** Ontario is CAD, GB is GBP, the ENTSO-E
    grids are EUR. The column is carried alongside so a naive cross-grid mean is
    at least visibly wrong rather than invisibly wrong.
    """
    pd = _pandas("prices()")
    rows = [
        {
            "grid": history.code,
            "date": day.date,
            "price": day.price,
            "currency": history.currency,
        }
        for history in _histories(codes, client)
        for day in history.days
        if day.price is not None
    ]
    frame = pd.DataFrame(rows, columns=["grid", "date", "price", "currency"])
    if not frame.empty:
        frame["date"] = pd.to_datetime(frame["date"])
    return frame.sort_values(["grid", "date"], ignore_index=True)


def demand(
    codes: str | Sequence[str] | None = None,
    *,
    client: Any = None,
) -> Any:
    """
    Daily mean load across grids: ``grid``, ``date``, ``demand_mw``.

    Scope follows the publisher, not the border — see each grid's ``note``.
    Ireland's demand is EirGrid's control area while its generation is
    all-island, so a demand-minus-generation residual for ``ie`` is not a
    net-import figure.
    """
    pd = _pandas("demand()")
    rows = [
        {"grid": history.code, "date": day.date, "demand_mw": day.demand_mw}
        for history in _histories(codes, client)
        for day in history.days
        if day.demand_mw is not None
    ]
    frame = pd.DataFrame(rows, columns=["grid", "date", "demand_mw"])
    if not frame.empty:
        frame["date"] = pd.to_datetime(frame["date"])
    return frame.sort_values(["grid", "date"], ignore_index=True)


def grids_frame() -> Any:
    """The registry as a DataFrame, indexed by code. No network access."""
    pd = _pandas("grids_frame()")
    from .grids import GRIDS

    return pd.DataFrame(
        [
            {
                "code": g.code,
                "name": g.name,
                "region": g.region,
                "timezone": g.timezone,
                "has_live": g.has_live,
                "is_partial": g.is_partial,
                "note": g.note,
            }
            for g in GRIDS
        ]
    ).set_index("code")
