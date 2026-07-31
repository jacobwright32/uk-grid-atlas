"""Fuel buckets and the carbon-intensity derivation.

The arithmetic is trivial; what these tests are really pinning down is the
treatment of gaps. Every ``None``-vs-zero decision in here is one someone could
"simplify" into a wrong published number.
"""

from __future__ import annotations

import pytest

from world_energy_generation import (
    CARBON_FACTORS,
    FUEL_LABELS,
    FUELS,
    LOW_CARBON,
    carbon_intensity,
    is_low_carbon,
)


def test_ten_buckets_no_duplicates():
    assert len(FUELS) == 10
    assert len(set(FUELS)) == 10


def test_every_bucket_is_labelled_and_has_a_factor():
    assert set(FUEL_LABELS) == set(FUELS)
    assert set(CARBON_FACTORS) == set(FUELS)


def test_no_stray_keys_in_the_tables():
    """A factor for a bucket that cannot appear is dead weight and misleads readers."""
    assert set(CARBON_FACTORS) <= set(FUELS)
    assert set(FUELS) >= LOW_CARBON


def test_factors_are_ordered_as_physics_demands():
    f = CARBON_FACTORS
    assert f["coal"] > f["gas"] > f["biomass"] > f["solar"] > f["hydro"] >= f["nuclear"]
    assert f["storage"] == 0.0


def test_low_carbon_excludes_biomass():
    """Deliberate: biomass is 230 g here, and its accounting is contested."""
    assert not is_low_carbon("biomass")
    assert {"wind", "solar", "hydro", "nuclear", "geothermal"} == LOW_CARBON


def test_low_carbon_rejects_nonsense():
    assert not is_low_carbon("unicorns")


def test_worked_example():
    """Half wind (12) half coal (820) -> 416."""
    assert carbon_intensity({"wind": 1000, "coal": 1000}) == 416.0


def test_single_fuel_returns_its_factor():
    assert carbon_intensity({"coal": 500}) == 820.0


def test_weighting_is_by_output_not_by_bucket_count():
    """Nine tenths wind and a tenth coal must not read as an average of two factors."""
    result = carbon_intensity({"wind": 9000, "coal": 1000})
    assert result == pytest.approx(92.8, abs=0.1)


def test_empty_mix_is_none_not_zero():
    """0.0 would claim a carbon-free grid. None says 'nothing to go on'."""
    assert carbon_intensity({}) is None


def test_all_none_mix_is_none():
    assert carbon_intensity({"wind": None, "coal": None}) is None


def test_zero_only_mix_is_none():
    assert carbon_intensity({"wind": 0, "coal": 0}) is None


def test_unknown_bucket_dilutes_nothing():
    """An unrecognised fuel is excluded from numerator *and* denominator."""
    known = carbon_intensity({"coal": 1000})
    assert carbon_intensity({"coal": 1000, "fusion": 5000}) == known


def test_negative_values_are_excluded():
    """Storage charging can go negative upstream; it must not credit the grid."""
    assert carbon_intensity({"coal": 1000, "storage": -400}) == 820.0


def test_absent_bucket_is_not_a_zero():
    """Switzerland reporting no gas must not read cleaner than a grid reporting gas=0."""
    absent = carbon_intensity({"hydro": 1000})
    explicit_zero = carbon_intensity({"hydro": 1000, "gas": 0})
    assert absent == explicit_zero == 24.0  # both honest: zero gas contributes nothing


def test_storage_makes_a_grid_read_optimistic():
    """Documented caveat, pinned so it cannot change silently."""
    assert carbon_intensity({"coal": 1000, "storage": 1000}) == 410.0
