"""pandas builders. Skipped wholesale when pandas is absent.

The recurring assertion is that an unreported bucket stays ``NaN``. It is the one
behaviour someone will be tempted to "fix" with ``fillna(0)``, and doing so turns
"Switzerland does not publish wind" into "Switzerland generates no wind".
"""

from __future__ import annotations

import builtins
from typing import Any

import pytest

from world_energy_generation import Client, History, PandasRequired

pd = pytest.importorskip("pandas", reason="pandas is an optional extra")


def test_history_frame_is_one_row_per_day(de: History):
    frame = de.to_frame()
    assert len(frame) == len(de.days)
    assert frame.index.name == "date"
    assert frame.index.is_monotonic_increasing


def test_history_frame_columns(de: History):
    frame = de.to_frame()
    for column in ("total_mw", "import_mw", "demand_mw", "price", "carbon_intensity"):
        assert column in frame.columns
    assert "wind" in frame.columns


def test_fuel_columns_come_first_and_in_canonical_order(de: History):
    from world_energy_generation import FUELS

    frame = de.to_frame()
    fuels = [c for c in frame.columns if c in set(FUELS)]
    assert fuels == [f for f in FUELS if f in set(fuels)]


def test_unreported_bucket_is_absent_not_zero(ch: History):
    """Switzerland does not report gas. A gas column of zeros would be a fabrication."""
    frame = ch.to_frame()
    assert "gas" not in frame.columns
    assert "coal" not in frame.columns


def test_germany_has_no_nuclear_column(de: History):
    assert "nuclear" not in de.to_frame().columns


def test_partially_reported_bucket_is_nan_on_the_missing_days():
    """A bucket some days report and others do not must read NaN, never 0."""
    history = History._parse(
        "xx",
        {
            "version": 3,
            "currency": "EUR",
            "days": [
                {"date": "2026-07-01", "mix": {"wind": 100, "coal": 50}},
                {"date": "2026-07-02", "mix": {"wind": 120}},
            ],
            "hourly": [],
        },
    )
    frame = history.to_frame()
    assert frame["coal"].iloc[0] == 50.0
    assert pd.isna(frame["coal"].iloc[1])
    assert frame["coal"].sum() == 50.0  # pandas skips NaN; a 0 would still be 50 here
    assert frame["coal"].mean() == 50.0  # but a 0 would make this 25 — the real damage


def test_unknown_upstream_bucket_lands_at_the_right_hand_end():
    history = History._parse(
        "xx",
        {
            "version": 3,
            "currency": "EUR",
            "days": [{"date": "2026-07-01", "mix": {"wind": 100, "fusion": 5}}],
            "hourly": [],
        },
    )
    columns = list(history.to_frame().columns)
    assert columns.index("wind") < columns.index("fusion")


def test_frame_carries_provenance_in_attrs(de: History):
    attrs = de.to_frame().attrs
    assert attrs["code"] == "de"
    assert attrs["currency"] == "EUR"


def test_hourly_frame_is_24_rows_per_day(de: History):
    frame = de.hourly_frame()
    assert len(frame) == 24 * len(de.hourly)
    assert frame.index.name == "timestamp"


def test_hourly_frame_index_is_hourly_and_ordered(de: History):
    index = de.hourly_frame().index
    assert index.is_monotonic_increasing
    assert (index[1] - index[0]) == pd.Timedelta(hours=1)


def test_hourly_frame_is_naive(de: History):
    """Localising a nominal-local index would imply a precision this data lacks."""
    assert de.hourly_frame().index.tz is None


def test_flow_columns_are_prefixed(de: History):
    frame = de.hourly_frame()
    flows = [c for c in frame.columns if c.startswith("flow_")]
    if flows:  # not every grid publishes border flows
        assert not set(flows) & {"wind", "solar", "price"}


def test_tidy_generation_is_long(client: Client):
    import world_energy_generation as weg

    frame = weg.generation("de", client=client)
    assert list(frame.columns) == ["grid", "date", "fuel", "mw"]
    assert frame["grid"].unique().tolist() == ["de"]
    assert frame["mw"].notna().all(), "long format should omit gaps, not encode them"


def test_tidy_generation_across_grids(client: Client):
    import world_energy_generation as weg

    frame = weg.generation(["de", "ch"], client=client)
    assert set(frame["grid"]) == {"de", "ch"}
    swiss = set(frame.loc[frame.grid == "ch", "fuel"])
    assert "gas" not in swiss


def test_tidy_generation_hourly(client: Client):
    import world_energy_generation as weg

    frame = weg.generation("de", client=client, hourly=True)
    assert "timestamp" in frame.columns
    assert len(frame) > len(weg.generation("de", client=client))


def test_prices_carry_their_currency(client: Client):
    import world_energy_generation as weg

    frame = weg.prices(["de", "ca"], client=client)
    assert set(frame["currency"]) == {"EUR", "CAD"}


def test_prices_omit_grids_without_them(client: Client):
    """us publishes no prices; a row of NaN would invite a mean over nothing."""
    import world_energy_generation as weg

    frame = weg.prices(["de", "us"], client=client)
    assert "us" not in set(frame["grid"])


def test_demand_frame(client: Client):
    import world_energy_generation as weg

    frame = weg.demand("de", client=client)
    assert list(frame.columns) == ["grid", "date", "demand_mw"]
    assert (frame["demand_mw"] > 0).all()


def test_grids_frame_needs_no_network():
    import world_energy_generation as weg

    frame = weg.grids_frame()
    assert len(frame) == len(weg.GRIDS)
    assert frame.index.name == "code"
    assert frame.loc["gb", "has_live"] is False or not frame.loc["gb", "has_live"]


def test_empty_result_still_has_the_right_columns():
    """An empty frame with no columns breaks callers that groupby unconditionally."""
    from world_energy_generation.frames import prices

    history = History._parse("xx", {"version": 3, "days": [], "hourly": []})
    empty = _stub_client(history)
    frame = prices("de", client=empty)
    assert frame.empty
    assert list(frame.columns) == ["grid", "date", "price", "currency"]


def test_pandas_required_when_pandas_is_hidden(monkeypatch: pytest.MonkeyPatch, de: History):
    """The error has to name the extra, not surface an ImportError from three frames deep."""
    real_import = builtins.__import__

    def blocked(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "pandas":
            raise ImportError("No module named 'pandas'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked)
    with pytest.raises(PandasRequired) as exc:
        de.to_frame()
    message = str(exc.value)
    assert "world-energy-generation[pandas]" in message
    assert "dataclasses" in message, "should point at the no-dependency alternative"


def _stub_client(history: History) -> Any:
    class Stub:
        def history(self, code: str) -> History:
            return history

    return Stub()
