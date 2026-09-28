"""Tests for the browser-extension-facing `/v1/extension/sanitize` route.

These tests deliberately spin up a fresh FastAPI app per test with an
in-memory ``DummyConfigRepository`` / ``DummyAuditRepository`` pair so
nothing touches the real ``data/`` directory. The pattern mirrors the
other FastAPI route tests in the suite (see ``test_masking_service.py``
for the dummy repos) and keeps the suite hermetic across parallel runs.

Scope covered here:

* the endpoint actually masks PII (round-trip test with an email),
* it responds 200 without any ``Authorization`` header (the loopback
  trust model explicitly forgoes the admin token),
* it emits an audit record tagged ``request_type="extension"`` so
  operators can tell extension traffic apart from the legacy
  `/sanitize/text` traffic, and
* the CORS preflight from a ``chrome-extension://<id>`` origin gets
  the right ``Access-Control-Allow-*`` headers back — without that,
  every POST from the extension fails before the route is even
  reached.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.routes import extension as extension_module

from conftest import DummyAuditRepository, DummyConfigRepository


def _install_dummy_service(monkeypatch) -> DummyAuditRepository:
    """Replace the shared MaskingService with one backed by dummy repos.

    The route imports ``_masking_service`` at module load time from a
    real ``ConfigRepository`` / ``AuditRepository``. Swapping it out
    here keeps the tests hermetic — no on-disk state is touched, and
    the returned ``DummyAuditRepository`` is the same instance the
    handler writes into, so ``records`` inspection works as expected.
    """
    from app.services.masking_service import MaskingService

    audit_repo = DummyAuditRepository()
    service = MaskingService(DummyConfigRepository(), audit_repo)
    monkeypatch.setattr(extension_module, "_masking_service", service)
    return audit_repo


def test_extension_endpoint_masks_pii(monkeypatch) -> None:
    """POST with an email PII must come back with the email masked."""
    _install_dummy_service(monkeypatch)
    client = TestClient(create_app())

    response = client.post(
        "/v1/extension/sanitize",
        json={
            "text": "please email me at user@example.com",
            "service": "claude",
            "source_url": "https://claude.ai/chat/abc",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    # The plain email must not survive into the sanitized payload.
    assert "user@example.com" not in body["sanitized_text"]
    # Presidio's EMAIL_ADDRESS detection should have fired and be
    # reported back so the extension can show a "N items masked" badge.
    entity_types = {d["entity_type"] for d in body["detections"]}
    assert "EMAIL_ADDRESS" in entity_types
    # The coarse action summary must be ``masked`` because the output
    # text actually changed.
    assert body["action"] == "masked"
    # audit_id is a uuid string — cheap structural check, full format
    # is exercised by the MaskingService-level tests.
    assert isinstance(body["audit_id"], str) and body["audit_id"]


def test_extension_no_auth_required(monkeypatch) -> None:
    """The extension endpoint must accept requests without Authorization.

    This pins the documented trust model (loopback-only, no admin
    token) so a future refactor cannot quietly start requiring one
    without somebody noticing.
    """
    _install_dummy_service(monkeypatch)
    client = TestClient(create_app())

    # Deliberately no ``headers=`` override — the default TestClient
    # session sends no Authorization header at all.
    response = client.post(
        "/v1/extension/sanitize",
        json={"text": "hello"},
    )

    # 401 would indicate the route started demanding the admin token.
    # Any 2xx is acceptable; 200 is what the current implementation
    # emits on the happy path.
    assert response.status_code == 200, (
        f"extension endpoint must not require auth; got {response.status_code}: "
        f"{response.text}"
    )


def test_extension_records_audit(monkeypatch) -> None:
    """Audit log entry must carry ``request_type='extension'``.

    The audit tag is how operators filter extension traffic out of
    the (otherwise dominant) text/proxy traffic when reviewing
    ``data/audit.jsonl``. We verify it at the repository level since
    the route does not echo the tag back in its response.
    """
    audit_repo = _install_dummy_service(monkeypatch)
    client = TestClient(create_app())

    response = client.post(
        "/v1/extension/sanitize",
        json={
            "text": "contact tanaka@example.co.jp",
            "service": "chatgpt",
            "source_url": "https://chatgpt.com/c/xyz",
        },
    )

    assert response.status_code == 200, response.text
    assert len(audit_repo.records) == 1
    record = audit_repo.records[0]
    assert record.request_type == "extension"
    # ``upstream_target`` should reflect the source URL the extension
    # reported, so audit reviewers can reconstruct "where did this
    # PII originate".
    assert record.upstream_target == "https://chatgpt.com/c/xyz"


def test_cors_preflight_allows_chrome_extension(monkeypatch) -> None:
    """An OPTIONS preflight from a chrome-extension origin must be allowed.

    Without this preflight support, every fetch the extension makes
    to the gateway fails at the browser layer before the POST handler
    ever runs. We check for a 2xx status and the presence of the key
    CORS response headers; the exact values are Starlette-internal
    and intentionally not pinned.
    """
    _install_dummy_service(monkeypatch)
    client = TestClient(create_app())

    response = client.options(
        "/v1/extension/sanitize",
        headers={
            "Origin": "chrome-extension://abc123def456",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    # Starlette returns 200 for a successful preflight.
    assert response.status_code == 200, response.text
    # The reflected origin proves the regex matched; without this,
    # the browser would reject the actual POST.
    assert (
        response.headers.get("access-control-allow-origin")
        == "chrome-extension://abc123def456"
    )
    # POST must be in the allowed methods list.
    allowed_methods = response.headers.get("access-control-allow-methods", "")
    assert "POST" in allowed_methods
