"""The public surface itself.

A name in ``__all__`` that does not resolve, or a documented example that no
longer runs, is a bug users hit before they hit anything else.
"""

from __future__ import annotations

import importlib
import pkgutil

import pytest

import world_energy_generation as weg


def test_version_is_a_release_string():
    assert weg.__version__.count(".") >= 2
    assert all(part.isdigit() or part[0].isdigit() for part in weg.__version__.split("."))


@pytest.mark.parametrize("name", weg.__all__)
def test_everything_in_all_resolves(name: str):
    assert hasattr(weg, name), f"__all__ promises {name} but the module does not have it"


def test_no_duplicates_in_all():
    assert len(weg.__all__) == len(set(weg.__all__))


def test_the_headline_names_are_exported():
    for name in ("history", "live", "latest", "grids", "grid", "Client"):
        assert name in weg.__all__


def test_every_error_is_catchable_as_one_base():
    for name in ("GridNotFound", "DataNotPublished", "FetchError", "SchemaError", "PandasRequired"):
        assert issubclass(getattr(weg, name), weg.WorldEnergyError)


def test_importing_the_package_does_not_import_pandas():
    """A zero-dependency package must not pay for an optional extra at import time."""
    import subprocess
    import sys

    code = "import sys, world_energy_generation; print('pandas' in sys.modules)"
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == "False"


def test_importing_the_package_makes_no_network_call():
    """Constructing the default client lazily is the difference between a library and a nuisance."""
    import subprocess
    import sys

    code = (
        "import urllib.request\n"
        "def boom(*a, **k): raise AssertionError('import made a request')\n"
        "urllib.request.urlopen = boom\n"
        "import world_energy_generation\n"
        "print('ok')"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == "ok"


def test_every_submodule_imports_cleanly():
    for info in pkgutil.iter_modules(weg.__path__):
        importlib.import_module(f"{weg.__name__}.{info.name}")


def test_docstring_advertises_the_gotchas():
    """These three caveats are the difference between useful and dangerous. Keep them."""
    doc = weg.__doc__ or ""
    assert "not reported" in doc
    assert "Ontario" in doc
    assert "compliance" in doc
