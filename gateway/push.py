"""Web Push for "needs you": VAPID keys, device subscriptions, dialog pushes.

The bridge calls push_dialog() when a blocking dialog (extension_ui_request
select/confirm/input/editor) becomes pending and NO WebSocket is subscribed to
that session: a turn is running unattended and needs an answer. One push per
dialog; the bridge owns the dedupe. Dead subscriptions (endpoint gone, 404/410)
are pruned on the next send.

Everything here is best-effort: a missing pywebpush install disables the
feature cleanly (available() -> False), and push_dialog never raises.

Storage lives next to auth-token: push-vapid.json (generated on first use) and
push-subs.json (device subscription list). Both hold secrets (the VAPID private
key, the devices' encryption keys), so both are written atomically with 0600
from creation. All disk and network work runs in worker threads; callers on
the event loop never block.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("ohmpi-gateway.push")

PROJECT_DIR = Path(__file__).resolve().parent.parent
VAPID_FILE = PROJECT_DIR / "push-vapid.json"
SUBS_FILE = PROJECT_DIR / "push-subs.json"
# Contact URI for the VAPID `sub` claim (RFC 8292). Operators should set
# OMPGW_VAPID_SUB to a mailbox they actually read; the default uses the
# reserved `.invalid` TLD so a self-host does not advertise someone else.
_VAPID_SUB = os.environ.get("OMPGW_VAPID_SUB", "mailto:omp-gateway@example.invalid")
_SEND_TIMEOUT_S = 10

webpush = None  # set by the import below; None means the feature is disabled
WebPushException: type[Exception] = Exception
Vapid = None
serialization = None

try:
    from pywebpush import WebPushException as _WPExc, webpush as _wp  # noqa: F401
    from py_vapid import Vapid as _Vapid

    from cryptography.hazmat.primitives import serialization as _ser

    webpush, WebPushException, Vapid, serialization = _wp, _WPExc, _Vapid, _ser
    _IMPORT_ERROR: str | None = None
except Exception as e:  # pragma: no cover - depends on install
    _IMPORT_ERROR = str(e)

_lock = threading.Lock()
_vapid: tuple[Any, str] | None = None  # (Vapid instance, public base64url)


def available() -> bool:
    return _IMPORT_ERROR is None


def unavailable_reason() -> str:
    return _IMPORT_ERROR or ""


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _write_private(path: Path, text: str) -> None:
    """Atomic write of a secret file, 0600 from creation (no readable window)."""
    tmp = path.with_suffix(".json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.replace(tmp, path)


def _get_vapid() -> tuple[Any, str]:
    """(Vapid instance, public base64url key), generated and persisted on first
    use. pywebpush also accepts a PEM *string*, but its from_string() mangles
    PEM headers - the Vapid OBJECT is the only safe form to hand it."""
    global _vapid
    with _lock:
        if _vapid is not None:
            return _vapid
        if VAPID_FILE.is_file():
            data = json.loads(VAPID_FILE.read_text())
            _vapid = (Vapid.from_pem(data["privatePem"].encode()), data["publicKey"])
            return _vapid
        key = Vapid()
        key.generate_keys()
        pem = key.private_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()).decode()
        pub = _b64url(key.public_key.public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
        _write_private(VAPID_FILE, json.dumps({"privatePem": pem, "publicKey": pub}))
        log.info("generated VAPID keys at %s", VAPID_FILE)
        _vapid = (key, pub)
        return _vapid


def public_key() -> str:
    return _get_vapid()[1]


# ------------------------------------------------------------- subscriptions

def _load_subs() -> list[dict]:
    if not SUBS_FILE.is_file():
        return []
    try:
        data = json.loads(SUBS_FILE.read_text())
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        log.exception("push subscriptions unreadable; starting empty")
        return []


def _save_subs(subs: list[dict]) -> None:
    _write_private(SUBS_FILE, json.dumps(subs, indent=1))


def _validate_keys(keys: Any) -> tuple[str, str]:
    """(p256dh, auth), base64url-decoded and shape-checked, so a malformed
    registration can never become a subscription that fails (and therefore
    never prunes) on every send."""
    if not isinstance(keys, dict):
        raise ValueError("keys must be an object with p256dh and auth")
    p256dh, auth = keys.get("p256dh"), keys.get("auth")
    if not isinstance(p256dh, str) or not p256dh or not isinstance(auth, str) or not auth:
        raise ValueError("keys.p256dh and keys.auth are required strings")

    def decode(value: str) -> bytes:
        try:
            return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        except Exception as e:
            raise ValueError("keys must be base64url strings") from e

    point, secret = decode(p256dh), decode(auth)
    if len(point) != 65 or point[0] != 0x04:
        raise ValueError("keys.p256dh must be a 65-byte uncompressed P-256 point")
    if not 16 <= len(secret) <= 32:
        raise ValueError("keys.auth must be a 16-byte authentication secret")
    return p256dh, auth


def subscribe(endpoint: Any, keys: Any) -> int:
    """Add (or refresh) one device subscription. Returns the list size."""
    if not isinstance(endpoint, str) or not endpoint.startswith("https://"):
        raise ValueError("endpoint must be an https push service URL")
    p256dh, auth = _validate_keys(keys)
    with _lock:
        subs = [s for s in _load_subs() if s.get("endpoint") != endpoint]
        subs.append({"endpoint": endpoint, "p256dh": p256dh, "auth": auth,
                     "added": int(time.time())})
        _save_subs(subs)
        return len(subs)


def unsubscribe(endpoint: Any) -> int:
    if not isinstance(endpoint, str) or not endpoint:
        raise ValueError("endpoint required")
    with _lock:
        subs = [s for s in _load_subs() if s.get("endpoint") != endpoint]
        _save_subs(subs)
        return len(subs)


def subscription_count() -> int:
    return len(_load_subs())


# --------------------------------------------------------------------- sends

def _send_one(sub: dict, payload: str) -> bool:
    """True delivered, False gone (prune). Raises for transient errors."""
    try:
        webpush(
            subscription_info={"endpoint": sub["endpoint"],
                               "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
            data=payload,
            vapid_private_key=_get_vapid()[0],
            vapid_claims={"sub": _VAPID_SUB},
            timeout=_SEND_TIMEOUT_S,
        )
        return True
    except WebPushException as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        if status in (404, 410):
            return False
        raise


async def _fan_out(payload: dict) -> int:
    """Serialize one payload to JSON and deliver it to every subscribed
    device. Returns the number of devices reached. Never raises. Per-device
    sends run in worker threads (one hanging push service must not delay the
    others) and dead subscriptions (endpoint gone, 404/410) are pruned."""
    subs = await asyncio.to_thread(_load_subs)
    if not subs:
        return 0
    body = json.dumps(payload)

    async def one(sub: dict) -> tuple[str, bool | None]:
        # True delivered, False gone (prune), None transient failure.
        try:
            return sub["endpoint"], await asyncio.to_thread(_send_one, sub, body)
        except Exception as e:
            log.warning("[%s] push to %s... failed: %s", payload.get("tag", "?"),
                        sub["endpoint"][:48], e)
            return sub["endpoint"], None

    results = await asyncio.gather(*(one(s) for s in subs))
    delivered = sum(1 for _, ok in results if ok is True)
    gone = [ep for ep, ok in results if ok is False]
    if gone:
        def prune() -> None:
            with _lock:
                keep = [s for s in _load_subs() if s.get("endpoint") not in set(gone)]
                _save_subs(keep)
        await asyncio.to_thread(prune)
        log.info("[%s] pruned %d dead push subscription(s)", payload.get("tag", "?"), len(gone))
    if delivered:
        log.info("[%s] pushed to %d device(s)", payload.get("tag", "?"), delivered)
    return delivered


async def push_dialog(gw_id: str, session_name: str | None, dialog: dict) -> int:
    """Notify every subscribed device about a pending dialog. Returns the
    number of devices reached. Never raises."""
    method = dialog.get("method") or "dialog"
    title = (dialog.get("title") or "omp needs you").strip().splitlines()[0][:120]
    body = f"{session_name or gw_id}: a {method} dialog is waiting for an answer"
    payload = {
        "gwId": gw_id,
        "title": "omp needs you",
        "body": f"{title} - {body}"[:280],
        "tag": f"omp-dialog-{gw_id}-{dialog.get('id')}",
        "url": f"/#/s/{gw_id}",
    }
    return await _fan_out(payload)


async def push_attention(instance_id: str, label: str, request_id: str) -> int:
    """Notify every subscribed device that an external omp collab host is
    waiting for input. Returns the number of devices reached. Never raises."""
    payload = {
        "title": "omp needs you",
        "body": f"{label} is waiting for input"[:280],
        "tag": f"omp-attention-{instance_id}-{request_id}",
        "url": "/",
    }
    return await _fan_out(payload)
