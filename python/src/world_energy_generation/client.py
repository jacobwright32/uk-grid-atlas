"""HTTP access to the published atlas data, with caching.

Zero dependencies by design: :mod:`urllib.request` from the standard library is
entirely adequate for four static JSON endpoints, and a data package that pulls
in a transitive HTTP stack to read a public file is being rude about it.

The atlas refreshes roughly every six hours, so the default 15-minute TTL is
about being polite to GitHub Pages rather than about freshness — repeated calls
in one analysis session hit memory, not the network.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import time
import urllib.error
import urllib.request
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

from .exceptions import DataNotPublished, FetchError
from .grids import grid
from .models import Coverage, History, LiveSnapshot

__all__ = ["DEFAULT_BASE_URL", "Client", "default_client", "set_default_client"]

DEFAULT_BASE_URL = "https://jacobwright32.github.io/uk-grid-atlas/"
"""
Where the data lives.

Coupled to the atlas's GitHub Pages path, which is in turn coupled to the repo
name. If that ever moves, override it — per call via ``Client(base_url=...)``,
or globally with the ``WORLD_ENERGY_BASE_URL`` environment variable — rather
than waiting for a release.
"""

_USER_AGENT = "world-energy-generation (+https://pypi.org/project/world-energy-generation/)"


class Client:
    """
    Fetches and caches atlas JSON.

    Most callers never construct one — the package-level
    :func:`world_energy_generation.history` and
    :func:`world_energy_generation.live` share a default. Make your own to point
    at a fork, lengthen the cache, or persist between runs:

    >>> c = Client(cache_dir="~/.cache/weg", ttl=3600)   # doctest: +SKIP
    >>> c.history("de").days[-1].price                   # doctest: +SKIP
    """

    def __init__(
        self,
        base_url: str | None = None,
        *,
        ttl: float = 900.0,
        timeout: float = 30.0,
        cache_dir: str | Path | None = None,
        retries: int = 2,
    ) -> None:
        raw = base_url or os.environ.get("WORLD_ENERGY_BASE_URL") or DEFAULT_BASE_URL
        self.base_url = raw if raw.endswith("/") else raw + "/"
        self.ttl = ttl
        self.timeout = timeout
        self.cache_dir = Path(cache_dir).expanduser() if cache_dir else None
        #: Extra attempts after a transient failure (0 = fail on first error).
        self.retries = max(0, int(retries))
        self._memory: dict[str, tuple[float, Mapping[str, Any]]] = {}

    # ---- public datasets -------------------------------------------------

    def history(
        self,
        code: str,
        *,
        since: str | _dt.date | None = None,
        until: str | _dt.date | None = None,
    ) -> History:
        """
        Rolling 31-day history for one grid. Available for all 32.

        ``since``/``until`` (ISO strings or ``date``, both inclusive) trim the
        window client-side — the atlas publishes one rolling file, so this is
        a convenience filter, not a deeper archive.
        """
        g = grid(code)
        h = History._parse(g.code, self._json(f"live/history/{g.code}.json"))
        if since is not None or until is not None:
            return h.window(since=since, until=until)
        return h

    def live(self, code: str) -> LiveSnapshot:
        """
        Latest snapshot for one grid.

        Raises :class:`~.exceptions.DataNotPublished` for Great Britain, whose
        snapshot is compiled into the web app rather than served as JSON.
        """
        g = grid(code)
        if not g.has_live:
            raise DataNotPublished(
                f"{g.name} publishes no standalone live snapshot — {g.note} "
                f'Use history("{g.code}") instead.'
            )
        return LiveSnapshot._parse(g.code, self._json(f"live/{g.code}.json"))

    def coverage(self) -> Coverage:
        """
        Measured publication coverage for every grid.

        What each feed actually contains — per-station live counts, prices,
        demand, how trade is measured, history depth — computed by the atlas
        workflow from the published files at every bake.

        Raises :class:`~.exceptions.FetchError` (404) against an atlas older
        than the coverage surface; everything else works without it.
        """
        return Coverage._parse(self._json("live/coverage.json"))

    def clear_cache(self, *, disk: bool = False) -> None:
        """Drop memoised responses. Set ``disk=True`` to also delete cached files."""
        self._memory.clear()
        if disk and self.cache_dir and self.cache_dir.is_dir():
            for path in self.cache_dir.glob("*.json"):
                path.unlink(missing_ok=True)

    # ---- transport -------------------------------------------------------

    def _json(self, path: str) -> Mapping[str, Any]:
        now = time.monotonic()
        hit = self._memory.get(path)
        if hit is not None and now - hit[0] < self.ttl:
            return hit[1]

        disk = self._disk_path(path)
        if disk is not None and disk.is_file():
            age = time.time() - disk.stat().st_mtime
            if age < self.ttl:
                try:
                    cached = json.loads(disk.read_text("utf-8"))
                    if not isinstance(cached, dict):
                        raise ValueError("cached payload was not a JSON object")
                    self._memory[path] = (now, cached)
                    return cached
                except (OSError, ValueError):
                    pass  # corrupt cache is not an error, just a miss

        payload = self._get(urljoin(self.base_url, path))
        self._memory[path] = (now, payload)
        if disk is not None:
            try:
                disk.parent.mkdir(parents=True, exist_ok=True)
                disk.write_text(json.dumps(payload), "utf-8")
            except OSError:
                pass  # an unwritable cache must not break a read
        return payload

    def _disk_path(self, path: str) -> Path | None:
        if self.cache_dir is None:
            return None
        return self.cache_dir / path.replace("/", "_")

    #: Sleeps before the second and third attempt at a transiently-failed GET.
    _RETRY_DELAYS: tuple[float, ...] = (0.5, 1.5)

    def _get(self, url: str) -> Mapping[str, Any]:
        """
        One GET with up to two retries on *transient* failures — 5xx, 429,
        network errors and timeouts. A 404 is a fact about the dataset, not a
        blip, and fails immediately. Retries matter most to the frame
        builders: one hiccup in a 32-grid sweep used to discard the other 31.
        """
        body: bytes | None = None
        delays = self._RETRY_DELAYS[: self.retries]
        for delay in (*delays, None):
            try:
                body = self._get_once(url)
                break
            except FetchError as exc:
                transient = exc.status is None or exc.status == 429 or exc.status >= 500
                if delay is None or not transient:
                    raise
                time.sleep(delay)
        assert body is not None  # the loop either broke with a body or raised

        try:
            payload = json.loads(body)
        except ValueError as exc:
            raise FetchError(url, f"response was not valid JSON: {exc}") from exc
        if not isinstance(payload, dict):
            raise FetchError(url, f"expected a JSON object, got {type(payload).__name__}")
        return payload

    def _get_once(self, url: str) -> bytes:
        request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return bytes(response.read())
        except urllib.error.HTTPError as exc:
            hint = ""
            if exc.code == 404:
                hint = (
                    " — the grid may not publish this dataset, or the base URL may "
                    "have moved (see DEFAULT_BASE_URL)"
                )
            raise FetchError(url, f"{exc.reason}{hint}", status=exc.code) from exc
        except urllib.error.URLError as exc:
            raise FetchError(url, f"network error: {exc.reason}") from exc
        except TimeoutError as exc:
            raise FetchError(url, f"timed out after {self.timeout}s") from exc


_default: Client | None = None


def default_client() -> Client:
    """The shared client used by the module-level functions."""
    global _default
    if _default is None:
        _default = Client()
    return _default


def set_default_client(client: Client | None) -> None:
    """
    Replace the shared client, or pass ``None`` to reset.

    Useful for pointing a whole script at a fork or a longer cache without
    threading a client through every call.
    """
    global _default
    _default = client
