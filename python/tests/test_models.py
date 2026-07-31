"""Parsing captured atlas JSON into records.

Fixtures are real captured files (see tests/make_fixtures.py), so these tests
fail if the upstream schema moves — which is the point. Hand-written JSON would
only test that the parser agrees with my beliefs about the schema.
"""

from __future__ import annotations

import copy
from datetime import date, datetime, timedelta, timezone

import pytest

from world_energy_generation import (
    HISTORY_VERSION,
    KNOWN_HISTORY_VERSIONS,
    DayRecord,
    History,
    LiveSnapshot,
    SchemaError,
)

from .conftest import FIXTURE_CODES, FIXTURE_LIVE_CODES, RawLoader

# ---- history -------------------------------------------------------------


@pytest.mark.parametrize("code", FIXTURE_CODES)
def test_every_fixture_parses(code: str, raw: RawLoader):
    history = raw.parsed_history(code)
    assert history.code == code
    assert history.days
    assert all(isinstance(d, DayRecord) for d in history.days)


@pytest.mark.parametrize("code", FIXTURE_CODES)
def test_days_are_sorted_ascending(code: str, raw: RawLoader):
    dates = [d.date for d in raw.parsed_history(code).days]
    assert dates == sorted(dates)


def test_day_fields(de: History):
    day = de.day("2026-07-23")
    assert day is not None
    assert day.mix["solar"] == 15421.0
    assert day.total_mw == 53697.0
    assert day.import_mw == 1103.0
    assert day.price == 118.75
    assert day.demand_mw == 53060.0


def test_day_accepts_a_date_object(de: History):
    assert de.day(date(2026, 7, 23)) is de.day("2026-07-23")


def test_day_outside_the_window_is_none(de: History):
    assert de.day("1999-01-01") is None


def test_germany_reports_no_nuclear_bucket(de: History):
    """Not a parser bug — Germany shut its last reactors. Absence must survive parsing."""
    assert "nuclear" not in de.days[-1].mix


def test_switzerland_reports_four_buckets(ch: History):
    assert set(ch.days[-1].mix) <= {"hydro", "nuclear", "solar", "wind"}


def test_currency_comes_from_the_file(raw: RawLoader):
    assert raw.parsed_history("de").currency == "EUR"
    assert raw.parsed_history("gb").currency == "GBP"
    assert raw.parsed_history("ca").currency == "CAD"
    assert raw.parsed_history("us").currency is None


def test_attribution_prefers_the_file_then_the_registry(raw: RawLoader):
    assert raw.parsed_history("ca").attribution == "IESO"  # sourceLabel
    assert raw.parsed_history("gb").attribution.startswith("Elexon")
    assert raw.parsed_history("de").source_label is None  # ENTSO-E grids omit it
    assert raw.parsed_history("de").attribution == "ENTSO-E Transparency Platform"


def test_grid_property_resolves(de: History):
    assert de.grid.name == "Germany"


def test_carbon_intensity_per_day(de: History):
    series = de.carbon_intensity()
    assert len(series) == len(de.days)
    assert all(v is None or 0 < v < 1000 for v in series.values())


def test_nulls_are_dropped_not_coerced():
    """A JSON null in a mix must vanish, not become 0.0."""
    history = History._parse("xx", _minimal(mix={"wind": 100, "coal": None}))
    assert history.days[0].mix == {"wind": 100.0}


def test_booleans_are_not_numbers():
    """isinstance(True, int) is True in Python; the parser has to say otherwise."""
    history = History._parse("xx", _minimal(mix={"wind": True, "coal": 5}))
    assert history.days[0].mix == {"coal": 5.0}


def test_bad_date_is_a_schema_error():
    with pytest.raises(SchemaError, match="not an ISO date"):
        History._parse("xx", _minimal(date_="the third of never"))


def test_non_object_mix_is_a_schema_error():
    with pytest.raises(SchemaError, match="fuel -> MW"):
        History._parse("xx", _minimal(mix=[1, 2, 3]))


def test_malformed_day_entries_are_skipped_not_fatal():
    payload = _minimal()
    payload["days"].append("not a day")  # type: ignore[arg-type]
    assert len(History._parse("xx", payload).days) == 1


# ---- schema versioning ---------------------------------------------------


def test_current_version_is_known():
    assert HISTORY_VERSION in KNOWN_HISTORY_VERSIONS


def test_version_2_still_parses(raw: RawLoader):
    """The captured us fixture is a real v2 file. v3 only added demand."""
    payload = raw.history("us")
    assert payload["version"] == 2
    history = History._parse("us", payload)
    assert history.version == 2
    assert history.days[0].demand_mw is None


def test_newer_version_warns_but_parses():
    """Hard-failing here would break every pinned install the day upstream adds a field."""
    with pytest.warns(UserWarning, match="newer than"):
        history = History._parse("xx", _minimal(version=HISTORY_VERSION + 7))
    assert history.days[0].mix["wind"] == 100.0


def test_older_than_known_is_rejected():
    with pytest.raises(SchemaError, match="older than"):
        History._parse("xx", _minimal(version=1))


def test_missing_version_is_rejected():
    with pytest.raises(SchemaError, match="not an integer"):
        History._parse("xx", _minimal(version=None))


def test_string_version_is_rejected():
    """'3' is what a hand-edited or re-serialised file looks like."""
    with pytest.raises(SchemaError, match="not an integer"):
        History._parse("xx", _minimal(version="3"))


# ---- hourly --------------------------------------------------------------


@pytest.mark.parametrize("code", FIXTURE_CODES)
def test_every_series_is_exactly_24_slots(code: str, raw: RawLoader):
    for record in raw.parsed_history(code).hourly:
        for bucket, series in record.mix_series.items():
            assert len(series) == 24, f"{code} {record.date} {bucket}"
        assert len(record.prices) == 24
        assert len(record.import_series) == 24
        assert len(record.demand_series) == 24


def test_hour_returns_a_flat_mapping(de: History):
    hour = de.hourly[-1].hour(12)
    assert "wind" in hour
    assert set(hour) >= {"import_mw", "demand_mw", "price"}


def test_hour_bounds_are_enforced(de: History):
    record = de.hourly[-1]
    with pytest.raises(IndexError):
        record.hour(24)
    with pytest.raises(IndexError):
        record.hour(-1)


def test_short_series_is_padded_with_none_not_zero():
    payload = _minimal()
    payload["hourly"] = [{"date": "2026-07-23", "mixSeries": {"wind": [1, 2, 3]}}]
    record = History._parse("xx", payload).hourly[0]
    assert record.mix_series["wind"][:3] == [1.0, 2.0, 3.0]
    assert record.mix_series["wind"][3:] == [None] * 21


def test_long_series_is_truncated():
    """A 25-hour DST day upstream must not desynchronise every downstream index."""
    payload = _minimal()
    payload["hourly"] = [{"date": "2026-07-23", "mixSeries": {"wind": list(range(25))}}]
    record = History._parse("xx", payload).hourly[0]
    assert len(record.mix_series["wind"]) == 24


def test_hourly_demand_reads_the_demand_key(raw: RawLoader):
    """Upstream calls it `demand` in hourly and `demandMW` in days. Easy to get wrong."""
    record = raw.parsed_history("de").hourly[-1]
    assert any(v is not None for v in record.demand_series)


def test_absent_hourly_series_is_all_none():
    payload = _minimal()
    payload["hourly"] = [{"date": "2026-07-23", "mixSeries": {}}]
    record = History._parse("xx", payload).hourly[0]
    assert record.prices == [None] * 24
    assert record.demand_series == [None] * 24


# ---- live ----------------------------------------------------------------


@pytest.mark.parametrize("code", FIXTURE_LIVE_CODES)
def test_live_fixtures_parse(code: str, raw: RawLoader):
    snap = raw.parsed_live(code)
    assert snap.code == code
    assert snap.mix, f"{code} produced an empty mix"
    assert all(isinstance(v, float) for v in snap.mix.values())


def test_live_reads_totals_out_of_the_nested_mix(raw: RawLoader):
    snap = raw.parsed_live("de")
    assert snap.total_mw and snap.total_mw > 0
    assert snap.basis == "entsoe"


def test_live_mix_comes_from_the_fuels_rows(raw: RawLoader):
    """`mix.fuels` is a list of {key, label, mw}, not an object. Easy to model wrong."""
    payload = raw.live("de")
    expected = {r["key"]: float(r["mw"]) for r in payload["mix"]["fuels"]}
    assert raw.parsed_live("de").mix == expected


def test_live_falls_back_to_mixrows(raw: RawLoader):
    """mixRows is the display shape carrying the same numbers under a different key."""
    payload = copy.deepcopy(raw.live("de"))
    expected = {r["key"]: float(r["nowMW"]) for r in payload["mixRows"]}
    payload["mix"] = {k: v for k, v in payload["mix"].items() if k != "fuels"}
    assert LiveSnapshot._parse("de", payload).mix == expected


def test_live_mix_accepts_a_plain_object_too():
    """Insurance against upstream simplifying rows into an object."""
    payload = {"version": 1, "date": "2026-07-23", "mix": {"fuels": {"wind": 100, "coal": 50}}}
    assert LiveSnapshot._parse("xx", payload).mix == {"wind": 100.0, "coal": 50.0}


def test_live_mix_of_the_wrong_type_is_a_schema_error():
    payload = {"version": 1, "date": "2026-07-23", "mix": {"fuels": "wind=100"}}
    with pytest.raises(SchemaError, match="fuel rows"):
        LiveSnapshot._parse("xx", payload)


def test_live_basis_is_not_provenance(raw: RawLoader):
    """Ontario reads 'entsoe' upstream. Anyone treating basis as a source is wrong."""
    assert raw.parsed_live("ca").basis == "entsoe"
    assert raw.parsed_live("ca").attribution == "IESO"


def test_live_price_is_a_mean_over_covered_hours_only():
    payload = {
        "version": 1,
        "date": "2026-07-23",
        "mix": {"fuels": {"wind": 100}},
        "prices": {"currency": "EUR", "series": [10, None, 20] + [None] * 21},
    }
    assert LiveSnapshot._parse("xx", payload).price == 15.0  # not 30/24


def test_live_price_is_none_when_nothing_is_covered():
    payload = {"version": 1, "date": "2026-07-23", "mix": {"fuels": {"wind": 100}}}
    assert LiveSnapshot._parse("xx", payload).price is None


def test_us_live_has_no_currency(raw: RawLoader):
    """The US ISOs here publish fuel mix but no prices."""
    assert raw.parsed_live("us").currency is None


# ---- timestamps ----------------------------------------------------------
#
# The library's promise is that you can compare these against
# ``datetime.now(timezone.utc)`` without unwrapping anything. Upstream stamps
# them ``...Z``, which `fromisoformat` refused before 3.11, so the parsing is
# ours and needs pinning.


@pytest.mark.parametrize("code", FIXTURE_LIVE_CODES)
def test_live_generated_at_is_an_aware_datetime(code: str, raw: RawLoader):
    stamp = raw.parsed_live(code).generated_at
    assert isinstance(stamp, datetime)
    assert stamp.tzinfo is not None, "a naive stamp cannot be compared to now(utc)"
    assert stamp.utcoffset() == timedelta(0)


@pytest.mark.parametrize("code", FIXTURE_CODES)
def test_history_updated_at_is_an_aware_datetime(code: str, raw: RawLoader):
    stamp = raw.parsed_history(code).updated_at
    assert isinstance(stamp, datetime)
    assert stamp.tzinfo is not None


def test_zulu_suffix_parses_on_every_supported_python():
    """`datetime.fromisoformat` only accepted a trailing Z from 3.11; we target 3.10."""
    payload = {"version": 1, "date": "2026-07-23", "mix": {"fuels": {"wind": 1}}}
    snap = LiveSnapshot._parse("xx", {**payload, "generatedAt": "2026-07-25T13:40:50.203Z"})
    assert snap.generated_at == datetime(2026, 7, 25, 13, 40, 50, 203000, tzinfo=timezone.utc)


def test_naive_timestamp_is_assumed_utc():
    """Every file the atlas publishes is UTC, so a stamp missing its offset still is."""
    payload = {"version": 1, "date": "2026-07-23", "mix": {"fuels": {"wind": 1}}}
    snap = LiveSnapshot._parse("xx", {**payload, "generatedAt": "2026-07-25T13:40:50"})
    assert snap.generated_at == datetime(2026, 7, 25, 13, 40, 50, tzinfo=timezone.utc)


def test_explicit_offset_is_preserved_not_clobbered():
    payload = {"version": 1, "date": "2026-07-23", "mix": {"fuels": {"wind": 1}}}
    snap = LiveSnapshot._parse("xx", {**payload, "generatedAt": "2026-07-25T15:40:50+02:00"})
    assert snap.generated_at == datetime(2026, 7, 25, 13, 40, 50, tzinfo=timezone.utc)
    assert snap.generated_at.utcoffset() == timedelta(hours=2)


@pytest.mark.parametrize(
    "bad", ["", "   ", "not a date", "2026-13-45T99:00:00Z", 1753449650, None, {"at": "now"}]
)
def test_unparseable_timestamp_is_none_not_an_error(bad: object):
    """
    A publisher typo in a metadata field must not make a whole grid unreadable.

    This is the one place the package is deliberately lenient rather than strict:
    every *number* is validated, but the note about when the file was written is
    not worth failing a fetch over.
    """
    payload = {"version": 1, "date": "2026-07-23", "mix": {"fuels": {"wind": 1}}}
    assert LiveSnapshot._parse("xx", {**payload, "generatedAt": bad}).generated_at is None
    assert History._parse("xx", {**_minimal(), "updatedAt": bad}).updated_at is None


def test_absent_timestamp_is_none():
    assert (
        LiveSnapshot._parse(
            "xx", {"version": 1, "date": "2026-07-23", "mix": {"fuels": {"wind": 1}}}
        ).generated_at
        is None
    )
    assert History._parse("xx", _minimal()).updated_at is None


def test_frame_attrs_carry_the_parsed_datetime(de: History):
    """`frame.attrs['updated_at']` is the same object the model exposes, not a string."""
    pytest.importorskip("pandas")
    frame = de.to_frame()
    assert frame.attrs["updated_at"] == de.updated_at
    assert isinstance(frame.attrs["updated_at"], datetime)


# ---- helper --------------------------------------------------------------


def _minimal(*, version: object = HISTORY_VERSION, date_: str = "2026-07-23", mix: object = None):
    """Smallest payload History._parse accepts, for isolating one behaviour at a time."""
    return {
        "version": version,
        "currency": "EUR",
        "days": [{"date": date_, "mix": {"wind": 100} if mix is None else mix}],
        "hourly": [],
    }
