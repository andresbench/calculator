"""Single YAML loader for the project, using libyaml when available."""

from __future__ import annotations

from functools import cache
from pathlib import Path


@cache
def _loader() -> tuple[object, object]:
    """Import PyYAML lazily and return (module, loader class)."""
    try:
        import yaml
    except ImportError as exc:
        raise RuntimeError(
            "PyYAML is required to build the bundle (timings, aliases, SP layer): pip install PyYAML"
        ) from exc
    loader = yaml.CSafeLoader if getattr(yaml, "__with_libyaml__", False) else yaml.SafeLoader
    return yaml, loader


def load_yaml(path: Path) -> object:
    """Load YAML from a UTF-8 file."""
    yaml, loader = _loader()
    with path.open(encoding="utf-8") as handle:
        return yaml.load(handle, Loader=loader)


def loads_yaml(text: str) -> object:
    """Load YAML from a string."""
    yaml, loader = _loader()
    return yaml.load(text, Loader=loader)
