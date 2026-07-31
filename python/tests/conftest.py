"""Shared fixtures. Nothing here touches the network.

The client is pointed at ``tests/fixtures/`` via a ``file://`` base URL, which
means the tests exercise the real ``Client._json`` path — urljoin, caching, error
mapping — rather than a stub that would let a transport bug through.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from world_energy_generation import Client, History, LiveSnapshot

FIXTURES = Path(__file__).parent / "fixtures"
#: Mirrors the published tree, so ``FIXTURES.as_uri()`` is a drop-in base URL.
PUBLISHED = FIXTURES / "live"

#: Grids captured in tests/fixtures. See tests/make_fixtures.py for why these five.
FIXTURE_CODES = ["de", "ch", "gb", "ca", "us"]
FIXTURE_LIVE_CODES = ["de", "ch", "ca", "us"]  # gb publishes no live JSON


@pytest.fixture
def base_url() -> str:
    return FIXTURES.as_uri() + "/"


@pytest.fixture
def client(base_url: str, tmp_path: Path) -> Client:
    """A client reading fixtures off disk, with an isolated cache directory."""
    return Client(base_url, cache_dir=tmp_path / "cache")


@pytest.fixture
def raw() -> RawLoader:
    return RawLoader()


class RawLoader:
    """Loads fixture JSON straight off disk, for parser tests that need no client."""

    def history(self, code: str) -> dict:
        return json.loads((PUBLISHED / "history" / f"{code}.json").read_text("utf-8"))

    def live(self, code: str) -> dict:
        return json.loads((PUBLISHED / f"{code}.json").read_text("utf-8"))

    def parsed_history(self, code: str) -> History:
        return History._parse(code, self.history(code))

    def parsed_live(self, code: str) -> LiveSnapshot:
        return LiveSnapshot._parse(code, self.live(code))


@pytest.fixture
def de(raw: RawLoader) -> History:
    """Germany: eight buckets, EUR prices, no nuclear since 2023."""
    return raw.parsed_history("de")


@pytest.fixture
def ch(raw: RawLoader) -> History:
    """Switzerland: four buckets. The grid that punishes fillna(0)."""
    return raw.parsed_history("ch")
