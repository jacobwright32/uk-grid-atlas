"""Transport, caching and error mapping.

No network. The client is pointed at a ``file://`` base URL, so the real
``_json`` / ``_get`` path runs — urljoin, JSON decode, cache read and write —
against fixture bytes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from world_energy_generation import (
    DEFAULT_BASE_URL,
    Client,
    DataNotPublished,
    FetchError,
    GridNotFound,
    default_client,
    set_default_client,
)

from .conftest import FIXTURES


def test_default_base_url_points_at_the_atlas():
    assert DEFAULT_BASE_URL.startswith("https://")
    assert DEFAULT_BASE_URL.endswith("/"), "urljoin drops the last path segment without this"


def test_missing_trailing_slash_is_repaired():
    assert Client("https://example.test/atlas").base_url == "https://example.test/atlas/"


def test_env_var_overrides_the_default(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("WORLD_ENERGY_BASE_URL", "https://fork.test/data/")
    assert Client().base_url == "https://fork.test/data/"


def test_explicit_argument_beats_the_env_var(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("WORLD_ENERGY_BASE_URL", "https://fork.test/data/")
    assert Client("https://explicit.test/").base_url == "https://explicit.test/"


def test_history_round_trip(client: Client):
    history = client.history("de")
    assert history.code == "de"
    assert len(history.days) == 4  # fixtures are truncated


def test_history_works_for_gb(client: Client):
    """The whole reason history is the recommended surface."""
    assert client.history("gb").currency == "GBP"


def test_live_round_trip(client: Client):
    assert client.live("ca").mix


def test_live_for_gb_explains_itself(client: Client):
    with pytest.raises(DataNotPublished) as exc:
        client.live("gb")
    message = str(exc.value)
    assert "history" in message, "the error should name the working alternative"
    assert "bundled" in message


def test_unknown_code_fails_before_any_request(client: Client):
    with pytest.raises(GridNotFound):
        client.history("xx")


def test_memory_cache_serves_the_second_call(client: Client):
    first = client.history("de")
    client._get = _explode  # type: ignore[method-assign]
    second = client.history("de")
    assert second.days[-1].date == first.days[-1].date


def test_ttl_zero_always_refetches(base_url: str):
    client = Client(base_url, ttl=0)
    calls = []
    original = client._get
    client._get = lambda url: (calls.append(url), original(url))[1]  # type: ignore[method-assign]
    client.history("de")
    client.history("de")
    assert len(calls) == 2


def test_disk_cache_is_written_and_reused(base_url: str, tmp_path: Path):
    cache = tmp_path / "cache"
    Client(base_url, cache_dir=cache).history("de")
    written = list(cache.glob("*.json"))
    assert written, "nothing landed in the cache directory"

    # A fresh client shares no memory, so a hit here must come off disk.
    fresh = Client(base_url, cache_dir=cache)
    fresh._get = _explode  # type: ignore[method-assign]
    assert fresh.history("de").code == "de"


def test_corrupt_disk_cache_is_a_miss_not_a_crash(base_url: str, tmp_path: Path):
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "live_history_de.json").write_text("{ this is not json", "utf-8")
    assert Client(base_url, cache_dir=cache).history("de").code == "de"


def test_unwritable_cache_does_not_break_a_read(base_url: str, tmp_path: Path):
    """A read-only cache directory is a nuisance, not a failure."""
    blocker = tmp_path / "blocked"
    blocker.write_text("I am a file, not a directory", "utf-8")
    assert Client(base_url, cache_dir=blocker).history("de").code == "de"


def test_clear_cache_drops_memory(client: Client):
    client.history("de")
    assert client._memory
    client.clear_cache()
    assert not client._memory


def test_clear_cache_can_delete_disk(base_url: str, tmp_path: Path):
    cache = tmp_path / "cache"
    client = Client(base_url, cache_dir=cache)
    client.history("de")
    client.clear_cache(disk=True)
    assert list(cache.glob("*.json")) == []


def test_missing_file_becomes_a_fetch_error(tmp_path: Path):
    client = Client(tmp_path.as_uri() + "/")
    with pytest.raises(FetchError) as exc:
        client.history("de")
    assert "de.json" in str(exc.value)


def test_non_json_body_becomes_a_fetch_error(tmp_path: Path):
    """What a captive portal or a proxy error page looks like from here."""
    (tmp_path / "live" / "history").mkdir(parents=True)
    (tmp_path / "live" / "history" / "de.json").write_text("<html>Gateway Timeout</html>", "utf-8")
    client = Client(tmp_path.as_uri() + "/")
    with pytest.raises(FetchError, match="not valid JSON"):
        client.history("de")


def test_json_array_body_becomes_a_fetch_error(tmp_path: Path):
    (tmp_path / "thing.json").write_text("[1, 2, 3]", "utf-8")
    client = Client(tmp_path.as_uri() + "/")
    with pytest.raises(FetchError, match="expected a JSON object"):
        client._json("thing.json")


def test_fetch_error_carries_the_url_and_reason():
    error = FetchError("https://example.test/x.json", "boom", status=503)
    assert error.url == "https://example.test/x.json"
    assert error.status == 503
    assert "503" in str(error)


def test_default_client_is_shared():
    set_default_client(None)
    try:
        assert default_client() is default_client()
    finally:
        set_default_client(None)


def test_default_client_can_be_replaced(base_url: str):
    replacement = Client(base_url)
    set_default_client(replacement)
    try:
        import world_energy_generation as weg

        assert weg.history("de").code == "de"
        assert default_client() is replacement
    finally:
        set_default_client(None)


def test_module_level_functions_accept_an_explicit_client(client: Client):
    import world_energy_generation as weg

    assert weg.history("de", client=client).code == "de"
    assert weg.live("de", client=client).code == "de"
    assert weg.latest("gb", client=client) is not None


def test_latest_is_the_last_day(client: Client):
    import world_energy_generation as weg

    history = client.history("de")
    assert weg.latest("de", client=client).date == history.days[-1].date


def test_cache_key_does_not_collide_across_datasets(base_url: str, tmp_path: Path):
    """live/de.json and live/history/de.json must not share a cache filename."""
    client = Client(base_url, cache_dir=tmp_path / "cache")
    live = client.live("de")
    history = client.history("de")
    assert live.code == history.code == "de"
    names = {p.name for p in (tmp_path / "cache").glob("*.json")}
    assert len(names) == 2, names


def _explode(url: str) -> dict:
    raise AssertionError(f"transport should not have been used, but fetched {url}")


def test_fixture_files_are_valid_json():
    """Cheap guard: a truncation bug in make_fixtures.py would surface here first."""
    for path in FIXTURES.rglob("*.json"):
        json.loads(path.read_text("utf-8"))
