"""Tests for the config / admin-token bootstrap logic.

These tests intentionally avoid touching MaskingService or any Presidio
code — they exercise ``get_admin_token()`` in isolation so failures here
point directly at the secret-resolution path.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Settings, get_admin_token, get_settings


@pytest.fixture(autouse=True)
def _reset_caches(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Ensure each test starts with fresh caches and an isolated token path.

    ``get_settings()`` and ``get_admin_token()`` are both ``@lru_cache``d
    so prior test runs (or even import-time fixtures) would pollute later
    assertions without an explicit reset.
    """
    monkeypatch.delenv("ADMIN_TOKEN", raising=False)
    monkeypatch.setenv("ADMIN_TOKEN_PATH", str(tmp_path / "admin_token"))
    get_settings.cache_clear()
    get_admin_token.cache_clear()
    yield
    get_settings.cache_clear()
    get_admin_token.cache_clear()


def test_admin_token_is_auto_generated_and_persisted(tmp_path: Path) -> None:
    token_file = tmp_path / "admin_token"
    assert not token_file.exists(), "precondition: fixture gives a clean path"

    first = get_admin_token()

    # Reasonable entropy for a URL-safe 32-byte secret.
    assert len(first) >= 32
    assert token_file.exists()
    assert token_file.read_text(encoding="utf-8").strip() == first


def test_admin_token_is_cached_within_process() -> None:
    first = get_admin_token()
    second = get_admin_token()
    # @lru_cache should return the same string object, not just equal.
    assert first is second


def test_admin_token_persists_across_cache_clears(tmp_path: Path) -> None:
    """Simulate a fresh process: clearing the cache should re-read the file
    and return the same value, not regenerate a new one."""
    first = get_admin_token()
    get_admin_token.cache_clear()
    second = get_admin_token()
    assert first == second


def test_env_admin_token_wins_over_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ADMIN_TOKEN", "explicit-value-from-env")
    get_settings.cache_clear()
    get_admin_token.cache_clear()
    assert get_admin_token() == "explicit-value-from-env"


def test_legacy_change_me_triggers_auto_generation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An old .env with the placeholder ``change-me`` must NOT be honored —
    it should fall through to the auto-generate path."""
    monkeypatch.setenv("ADMIN_TOKEN", "change-me")
    get_settings.cache_clear()
    get_admin_token.cache_clear()
    token = get_admin_token()
    assert token != "change-me"
    assert (tmp_path / "admin_token").read_text(encoding="utf-8").strip() == token


def test_token_file_is_chmod_600_when_generated(tmp_path: Path) -> None:
    """Generated token file should be owner-read/write only. On filesystems
    that don't support chmod (FAT, some bind mounts) the code tolerates
    an OSError — but on tmp_path it should succeed."""
    get_admin_token()
    mode = (tmp_path / "admin_token").stat().st_mode & 0o777
    assert mode == 0o600, f"expected 0o600, got {oct(mode)}"
