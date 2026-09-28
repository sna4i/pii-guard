"""Runs the JS vector validator from the pytest suite.

The validator at ``scripts/validate_vectors.js`` exercises the pure-JS
masking engine (``browser-extension/engine/*.js``) against the JSON
vectors in ``tests/vectors/``. This test wraps it so ``make test``
(which builds the Docker ``test`` target) fails whenever a vector
regresses, putting the JS port under CI.

The test is skipped when Node.js 18+ is not installed locally — the
production ``Dockerfile`` ``test`` stage installs Node 20, so CI still
enforces the vectors; a developer on a laptop without Node can run the
Python suite without needing to install Node.

See :mod:`tests.conftest` for the rest of the fixture surface.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
VALIDATOR = ROOT / "scripts" / "validate_vectors.js"


def _node_available() -> bool:
    """Return True when a usable ``node`` binary is on ``PATH``."""
    return shutil.which("node") is not None


@pytest.mark.skipif(
    not _node_available(),
    reason="Node.js not installed — install Node 18+ to exercise JS vectors",
)
def test_js_vectors_pass() -> None:
    """Every case in ``tests/vectors/*.json`` must pass the JS engine."""
    assert VALIDATOR.exists(), f"validator missing: {VALIDATOR}"
    env = dict(os.environ)
    # Keep the working directory at the repo root so the validator's
    # relative paths (``browser-extension/engine/...``) resolve.
    result = subprocess.run(
        ["node", str(VALIDATOR)],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        pytest.fail(
            "JS vector validator reported failures.\n"
            f"--- stdout ---\n{result.stdout}\n"
            f"--- stderr ---\n{result.stderr}"
        )
    # Sanity: the validator emits a "Result: N / N passed" line we can
    # surface in the pytest log on success too. Not a hard assertion
    # (the exit code already gates success); just useful for CI output.
    assert "passed" in result.stdout, result.stdout
