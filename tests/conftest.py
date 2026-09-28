"""Shared pytest fixtures for the mask-mcp test suite.

Before this module existed the same ``DummyConfigRepository`` /
``DummyAuditRepository`` pair was copy-pasted into every test file that
needed to instantiate :class:`app.services.masking_service.MaskingService`
without touching the real on-disk repositories. Lifting them here keeps
the individual test files readable and avoids drift the next time
``ConfigRepository`` grows a new constructor argument.

The helpers are exposed in two forms because the existing tests need
both shapes:

- **classes** — ``DummyConfigRepository(config=<custom>)`` is used by
  tests that pass a non-default :class:`RuntimeConfig` in. Those tests
  ``from conftest import DummyConfigRepository`` directly.
- **fixtures** — ``dummy_config_repo`` / ``dummy_audit_repo`` are
  plain default-constructed instances, suitable for tests that only
  need the happy-path ``filter_enabled=True`` baseline.

pytest auto-discovers ``conftest.py`` at collection time, so no
registration in ``pyproject.toml`` is required.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import pytest

from app.models.schemas import RuntimeConfig
from app.services.repositories import AuditRepository, ConfigRepository


class DummyConfigRepository(ConfigRepository):
    """In-memory ``ConfigRepository`` suitable for unit tests.

    Accepts an optional :class:`RuntimeConfig` so tests that need a
    non-default configuration (e.g. ``min_score=0.95``) can pass one
    in at construction time. Defaults to ``filter_enabled=True`` to
    match the most common test scenario.
    """

    def __init__(self, config: Optional[RuntimeConfig] = None) -> None:
        self._config = config or RuntimeConfig(filter_enabled=True)
        self.path = Path("/tmp/runtime_config_test.json")

    def load(self) -> RuntimeConfig:
        return self._config

    def save(self, config: RuntimeConfig) -> RuntimeConfig:
        self._config = config
        return config


class DummyAuditRepository(AuditRepository):
    """In-memory ``AuditRepository`` that keeps appended records in a list.

    Tests that want to assert on the audit trail inspect ``records``
    directly; the rest just pass an instance in and ignore it.
    """

    def __init__(self) -> None:
        self.records: list = []
        self.path = Path("/tmp/audit_test.jsonl")

    def append(self, record) -> None:
        self.records.append(record)


@pytest.fixture
def dummy_config_repo() -> DummyConfigRepository:
    return DummyConfigRepository()


@pytest.fixture
def dummy_audit_repo() -> DummyAuditRepository:
    return DummyAuditRepository()
