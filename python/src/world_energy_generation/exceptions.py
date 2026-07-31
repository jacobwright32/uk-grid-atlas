"""Exception types. All inherit :class:`WorldEnergyError`, so one ``except`` catches everything."""

from __future__ import annotations

__all__ = [
    "DataNotPublished",
    "FetchError",
    "GridNotFound",
    "PandasRequired",
    "SchemaError",
    "WorldEnergyError",
]


class WorldEnergyError(Exception):
    """Base for every error this package raises."""


class GridNotFound(WorldEnergyError, KeyError):
    """
    An unknown grid code.

    Subclasses :class:`KeyError` so ``dict``-style handling still works, but the
    message lists valid codes rather than echoing the bad one alone.
    """

    def __init__(self, code: str, valid: list[str]) -> None:
        self.code = code
        self.valid = valid
        super().__init__(f"unknown grid {code!r}; valid codes are {', '.join(valid)}")

    def __str__(self) -> str:  # KeyError would otherwise repr() the message
        return str(self.args[0])


class DataNotPublished(WorldEnergyError):
    """
    The grid exists but this dataset is not served for it.

    Currently only Great Britain's live snapshot, which the atlas compiles into
    its JavaScript bundle instead of publishing as JSON.
    """


class FetchError(WorldEnergyError):
    """The HTTP request failed, timed out, or returned a non-200 status."""

    def __init__(self, url: str, reason: str, status: int | None = None) -> None:
        self.url = url
        self.reason = reason
        self.status = status
        detail = f"HTTP {status}: {reason}" if status is not None else reason
        super().__init__(f"could not fetch {url} ({detail})")


class SchemaError(WorldEnergyError):
    """
    Fetched JSON did not look like what this package expects.

    Usually means the upstream schema moved and this package needs updating —
    the message carries the version it saw so an issue report is actionable.
    """


class PandasRequired(WorldEnergyError, ImportError):
    """A DataFrame was requested but pandas is not installed."""

    def __init__(self, what: str = "this call") -> None:
        super().__init__(
            f"{what} returns a pandas DataFrame, but pandas is not installed.\n"
            "    pip install 'world-energy-generation[pandas]'\n"
            "Every dataset is also available as plain dataclasses with no extra "
            "dependency — see history(), live() and .days / .hourly."
        )
