"""Registry invariants.

Most of these are guardrails against a careless edit to the GRIDS tuple rather
than tests of logic — a duplicated code or a silently dropped grid is the kind of
mistake that produces a plausible-looking wrong answer downstream.
"""

from __future__ import annotations

import dataclasses

import pytest

from world_energy_generation import GRIDS, Grid, GridNotFound, codes, grid, grids


def test_grid_count():
    assert len(GRIDS) == 26


def test_codes_are_unique():
    assert len(codes()) == len(set(codes()))


@pytest.mark.parametrize("g", GRIDS, ids=lambda g: g.code)
def test_code_shape(g: Grid):
    assert g.code == g.code.lower()
    assert len(g.code) == 2
    assert g.code.isalpha()


@pytest.mark.parametrize("g", GRIDS, ids=lambda g: g.code)
def test_every_grid_has_a_name_and_an_operator(g: Grid):
    assert g.name.strip()
    assert g.operator.strip()


@pytest.mark.parametrize("g", GRIDS, ids=lambda g: g.code)
def test_region_is_one_of_two(g: Grid):
    assert g.region in {"europe", "north-america"}


def test_gb_is_the_only_grid_without_live():
    assert [g.code for g in GRIDS if not g.has_live] == ["gb"]


def test_regions_split():
    assert len(grids(region="europe")) == 24
    assert [g.code for g in grids(region="north-america")] == ["us", "ca"]


@pytest.mark.parametrize(
    ("alias", "expected"),
    [
        ("eu", "europe"),
        ("EU", "europe"),
        ("na", "north-america"),
        ("North America", "north-america"),
    ],
)
def test_region_aliases(alias: str, expected: str):
    assert grids(region=alias) == grids(region=expected)


def test_unknown_region_is_empty_not_an_error():
    assert grids(region="antarctica") == []


def test_live_only_filter_drops_gb():
    assert "gb" not in [g.code for g in grids(live_only=True)]
    assert len(grids(live_only=True)) == 25


def test_lookup_is_case_and_space_insensitive():
    assert grid("DE") is grid("de") is grid("  de  ")


def test_unknown_code_lists_the_valid_ones():
    with pytest.raises(GridNotFound) as exc:
        grid("xx")
    message = str(exc.value)
    assert "xx" in message
    assert "de" in message and "gb" in message


def test_grid_not_found_is_catchable_as_keyerror():
    """Subclassing KeyError has to actually work for dict-ish callers."""
    with pytest.raises(KeyError):
        grid("nope")


def test_grid_not_found_str_is_not_repr_quoted():
    """KeyError.__str__ would repr the message; the override stops that."""
    with pytest.raises(GridNotFound) as exc:
        grid("xx")
    assert not str(exc.value).startswith('"')


def test_partial_grids_are_flagged_and_explained():
    partial = {g.code for g in GRIDS if g.is_partial}
    assert partial == {"gb", "ie", "us", "ca"}
    for code in partial:
        assert len(grid(code).note) > 20, f"{code} is flagged partial but barely explains why"


def test_names_do_not_overclaim_national_coverage():
    """A column headed 'Canada' that means Ontario is how bad numbers get published."""
    assert "Ontario" in grid("ca").name
    assert grid("us").name != "United States"
    assert "all-island" in grid("ie").name


def test_us_has_no_single_timezone():
    assert grid("us").timezone is None
    assert all(g.timezone for g in GRIDS if g.code != "us")


def test_operators_match_the_known_upstreams():
    assert grid("gb").operator.startswith("Elexon")
    assert grid("ca").operator == "IESO"
    assert grid("us").operator == "ERCOT + NYISO"
    assert grid("fr").operator == "ENTSO-E Transparency Platform"


def test_grids_are_immutable():
    with pytest.raises(dataclasses.FrozenInstanceError):
        grid("de").name = "Deutschland"  # type: ignore[misc]
