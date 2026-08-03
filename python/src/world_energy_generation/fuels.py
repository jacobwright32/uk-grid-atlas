"""Fuel buckets and the carbon factors used to derive an intensity from a mix.

Ten buckets, fixed across all 32 grids. They are coarser than any national
statistical classification on purpose: the point is that ``de`` and ``us`` and
``gb`` can be put on the same axis without a mapping table, which means every
bucket has to exist in every upstream feed's vocabulary.
"""

from __future__ import annotations

__all__ = ["CARBON_FACTORS", "FUELS", "FUEL_LABELS", "carbon_intensity", "is_low_carbon"]

FUELS: tuple[str, ...] = (
    "wind",
    "solar",
    "hydro",
    "nuclear",
    "biomass",
    "gas",
    "coal",
    "geothermal",
    "storage",
    "other",
)
"""Every mix bucket that can appear, in rough merit/interest order.

Not every grid reports every bucket — Switzerland publishes four, Spain nine.
An absent bucket means "not reported", which is not the same as zero, and the
frame builders keep that distinction as ``NaN`` rather than filling it.
"""

FUEL_LABELS: dict[str, str] = {
    "wind": "Wind",
    "solar": "Solar",
    "hydro": "Hydro",
    "nuclear": "Nuclear",
    "biomass": "Biomass",
    "gas": "Gas",
    "coal": "Coal",
    "geothermal": "Geothermal",
    "storage": "Battery storage",
    "other": "Other / unclassified",
}

CARBON_FACTORS: dict[str, float] = {
    "coal": 820.0,
    "gas": 490.0,
    "other": 650.0,
    "biomass": 230.0,
    "solar": 41.0,
    "geothermal": 38.0,
    "hydro": 24.0,
    "nuclear": 12.0,
    "wind": 12.0,
    "storage": 0.0,
}
"""
Lifecycle emission factors in gCO2e/kWh, IPCC AR5 / UNECE-style medians.

Deliberately coarse — a factor per bucket, not per plant. ``other`` is oil and
unclassified thermal, so 650 is a midpoint over a genuinely mixed bag. Storage
is 0 because discharging a battery emits at charge time, which means a grid with
meaningful storage flows will read slightly optimistic here.

Good enough to say "Poland is four times France". Not good enough for compliance
accounting, and you should not present it as measured.
"""

LOW_CARBON: frozenset[str] = frozenset({"wind", "solar", "hydro", "nuclear", "geothermal"})
"""Buckets counted as low-carbon. Biomass is excluded — it is 230 gCO2e/kWh here
and its true accounting is contested enough that lumping it in would be a claim,
not a convenience."""


def is_low_carbon(fuel: str) -> bool:
    """Whether a bucket counts toward a low-carbon share. See :data:`LOW_CARBON`."""
    return fuel in LOW_CARBON


def carbon_intensity(mix: dict[str, float | None]) -> float | None:
    """
    Generation-weighted carbon intensity of one mix, in gCO2e/kWh.

    Takes a ``{bucket: MW}`` mapping as found on a day or hour record. Buckets
    with no factor, no value, or a non-positive value are excluded from *both*
    numerator and denominator, so an unknown bucket dilutes nothing.

    Returns ``None`` when nothing attributable was generating, which is the
    honest answer for an all-``NaN`` hour — distinct from 0.0, which would mean
    a fully carbon-free grid.

    >>> carbon_intensity({"wind": 1000, "coal": 1000})
    416.0
    """
    grams = 0.0
    total = 0.0
    for bucket, value in mix.items():
        factor = CARBON_FACTORS.get(bucket)
        if factor is None or value is None or value <= 0:
            continue
        grams += value * factor
        total += value
    if total <= 0:
        return None
    return round(grams / total, 1)
