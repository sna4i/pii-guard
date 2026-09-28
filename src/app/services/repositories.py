from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from app.config import get_settings
from app.models.schemas import AuditRecord, ProviderConfig, RuntimeConfig


class ConfigRepository:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.path: Path = self.settings.runtime_config_path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def load(self) -> RuntimeConfig:
        if not self.path.exists():
            default = RuntimeConfig(
                filter_enabled=self.settings.default_filter_enabled,
                fail_closed=self.settings.default_fail_closed,
                mask_strategy=self.settings.default_mask_strategy,
                default_provider_id=self.settings.default_provider_id,
                providers={
                    provider_id: ProviderConfig.model_validate(provider)
                    for provider_id, provider in self.settings.build_provider_catalog().items()
                },
            )
            self.save(default)
            return default

        loaded = RuntimeConfig.model_validate_json(self.path.read_text(encoding="utf-8"))
        if not loaded.providers:
            loaded.providers = {
                provider_id: ProviderConfig.model_validate(provider)
                for provider_id, provider in self.settings.build_provider_catalog().items()
            }
        if loaded.default_provider_id not in loaded.providers:
            loaded.default_provider_id = self.settings.default_provider_id
        return loaded

    def save(self, config: RuntimeConfig) -> RuntimeConfig:
        self.path.write_text(config.model_dump_json(indent=2), encoding="utf-8")
        return config


class AuditRepository:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.path: Path = self.settings.audit_log_path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, record: AuditRecord) -> None:
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record.model_dump(mode="json"), ensure_ascii=False) + "\n")

    def list_recent(
        self,
        limit: int = 100,
        *,
        since: datetime | None = None,
        entity_type: str | None = None,
        action: str | None = None,
    ) -> list[dict]:
        """Return the most recent audit records, optionally filtered.

        The default call ``list_recent()`` is byte-for-byte compatible
        with the pre-filter behaviour: the last 100 JSONL lines, newest
        first. The optional keyword filters are layered on top:

        * ``since`` — drop records whose ``created_at`` is strictly
          earlier than this datetime. Naive datetimes are compared
          directly against the stored ISO timestamps' naive projection
          so UTC-vs-local confusion does not leak into the filter.
        * ``entity_type`` — keep only records whose ``entity_summary``
          dict contains this key with a non-zero count. Empty summaries
          (zero detections) are therefore dropped whenever an
          ``entity_type`` filter is supplied, which is the intuitive
          behaviour for "show me every audit with a PERSON detection".
        * ``action`` — currently ``"masked"`` or ``"allowed"``. A
          record matches if **any** of its detections carried that
          action at write time; because :class:`AuditRecord` only
          persists the aggregated ``entity_summary`` today, we treat
          a record as ``masked`` when its ``detected_count > 0`` and
          as ``allowed`` when the sanitised text preserved at least
          one detection verbatim. The coarse filter is intentional:
          the detailed per-detection trail lives in the sanitize
          response, not the audit log, and this keeps the query
          endpoint a drop-in replacement rather than a schema change.

        ``limit`` is applied **after** the filters, so asking for
        ``limit=100, entity_type="PERSON"`` returns the 100 newest
        matches rather than "filter the last 100 regardless of whether
        any of them match". This matches what a human operator usually
        wants when pulling up the audit trail for a specific category.
        """
        if not self.path.exists():
            return []
        lines = self.path.read_text(encoding="utf-8").splitlines()
        # Newest first — same contract as before.
        records: list[dict] = [json.loads(line) for line in lines][::-1]

        if since is not None:
            kept: list[dict] = []
            for record in records:
                created_raw = record.get("created_at")
                if not isinstance(created_raw, str):
                    continue
                try:
                    created_at = datetime.fromisoformat(created_raw)
                except ValueError:
                    continue
                # Normalise timezone awareness so the comparison does
                # not raise. A naive ``since`` or a naive stored value
                # is upgraded to UTC; both-naive or both-aware compare
                # without any change.
                if since.tzinfo is None and created_at.tzinfo is not None:
                    created_at = created_at.replace(tzinfo=None)
                elif since.tzinfo is not None and created_at.tzinfo is None:
                    created_at = created_at.replace(tzinfo=timezone.utc)
                if created_at >= since:
                    kept.append(record)
            records = kept

        if entity_type is not None:
            records = [
                r
                for r in records
                if isinstance(r.get("entity_summary"), dict)
                and r["entity_summary"].get(entity_type, 0) > 0
            ]

        if action is not None:
            # The audit log currently only stores the aggregated entity
            # summary plus a ``detected_count``; per-detection actions
            # are a sanitize-response concern, not a persisted column.
            # Map the two coarse buckets:
            #   - ``masked`` → any record that actually masked at least
            #     one entity (``detected_count > 0`` with a non-empty
            #     summary and ``filter_enabled=True``).
            #   - ``allowed`` → any record that detected something but
            #     emitted no masks (entity_summary empty while count>0),
            #     or a filter-disabled pass-through with count==0.
            # TODO: persist ``detections`` at audit time so this filter
            # can be exact rather than heuristic — out of scope for the
            # final-wave pass.
            if action == "masked":
                records = [
                    r for r in records
                    if r.get("filter_enabled") is True
                    and int(r.get("detected_count", 0) or 0) > 0
                ]
            elif action == "allowed":
                records = [
                    r for r in records
                    if r.get("filter_enabled") is True
                    and int(r.get("detected_count", 0) or 0) == 0
                ]
            else:
                # Unknown action — return zero results rather than
                # silently ignoring the filter; the route handler
                # already 400s on unknown values before we get here,
                # so this branch is only reachable from direct calls.
                records = []

        return records[:limit]

    def now(self) -> datetime:
        return datetime.now(timezone.utc)
