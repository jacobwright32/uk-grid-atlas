"""The ``weg`` command: read-only views, zero deps, fixture-fed.

Each test drives ``main()`` with ``--base-url`` pointed at the fixture tree —
the same file:// trick the client tests use, so the whole argparse → client →
format path runs for real with no network.
"""

from __future__ import annotations

import pytest

from world_energy_generation._cli import main


def run(capsys: pytest.CaptureFixture[str], *argv: str, base_url: str) -> tuple[int, str, str]:
    code = main(["--base-url", base_url, *argv])
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def test_grids_lists_the_registry(capsys: pytest.CaptureFixture[str], base_url: str):
    code, out, _ = run(capsys, "grids", base_url=base_url)
    assert code == 0
    assert "code" in out and "gb" in out and "de" in out
    assert "history-only" in out  # gb's live column tells the truth


def test_live_prints_a_mix(capsys: pytest.CaptureFixture[str], base_url: str):
    code, out, _ = run(capsys, "live", "de", base_url=base_url)
    assert code == 0
    assert "Germany" in out
    assert "total" in out
    assert "g/kWh" in out  # the derived intensity line


def test_live_for_gb_degrades_to_the_latest_day(capsys: pytest.CaptureFixture[str], base_url: str):
    code, out, _ = run(capsys, "live", "gb", base_url=base_url)
    assert code == 0
    assert "no standalone live snapshot" in out
    assert "total" in out  # …but it still shows numbers rather than an error


def test_history_respects_days(capsys: pytest.CaptureFixture[str], base_url: str):
    code, out, _ = run(capsys, "history", "ch", "--days", "2", base_url=base_url)
    assert code == 0
    assert "2 of 4 days" in out


def test_coverage_matrix(capsys: pytest.CaptureFixture[str], base_url: str):
    code, out, _ = run(capsys, "coverage", base_url=base_url)
    assert code == 0
    assert "net trade" in out
    assert "browser" in out  # gb's stations column
    assert "HVDC only" in out  # de


def test_unknown_grid_is_a_clean_error(capsys: pytest.CaptureFixture[str], base_url: str):
    code, out, err = run(capsys, "live", "zz", base_url=base_url)
    assert code == 1
    assert out == ""
    assert "weg:" in err and "zz" in err


def test_version_flag(capsys: pytest.CaptureFixture[str]):
    from world_energy_generation import __version__

    with pytest.raises(SystemExit) as exc:
        main(["--version"])
    assert exc.value.code == 0
    assert __version__ in capsys.readouterr().out
