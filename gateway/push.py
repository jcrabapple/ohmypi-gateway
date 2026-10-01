"""Web Push for "needs you": VAPID keys, device subscriptions, dialog pushes.

The bridge calls push_dialog() when a blocking dialog (extension_ui_request
select/confirm/input/editor) becomes pending and NO WebSocket is subscribed to
that session: a turn is running unattended and needs an answer. One push per
dialog; the bridge owns the dedupe. Dead subscriptions (endpoint gone, 404/410)
are pruned on the next send.

Everything here is best-effort: a missing pywebpush install disables the
feature cleanly (available() -> False), and push_dialog never raises.

Storage lives next to auth-token: push-vapid.json (generated on first use,
chmod 600) and push-subs.json (device subscription list, atomic writes).
"""

from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
from pathlib import Path

log = logging.getLogger("ohmpi-gateway.push")

PROJECT_DIR = Path(__file__).resolve().parent.parent
VAPID_FILE = PROJECT_DIR / "push-vapid.json"
SUBS_FILE = PROJECT_DIR / "push-subs.json"
# The mailto in VAPID claims; push services require a contact URI.
_VAPID_SUB = "mailto:jcrabapple@fastmail.us"
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
_vapid: tuple[str, str] | None = None  # (private_pem, public_b64url)


def available() -> bool:
    return _IMPORT_ERROR is None


def unavailable_reason() -> str:
    return _IMPORT_ERROR or ""


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _get_vapid() -> tuple[str, str]:
    """(private PEM, public base64url key), generated and persisted on first use."""
    global _vapid
    with _lock:
        if _vapid is not None:
            return _vapid
        if VAPID_FILE.is_file():
            data = json.loads(VAPID_FILE.read_text())
            _vapid = (data["privatePem"], data["publicKey"])
            return _vapid
        key = Vapid()
        key.generate_keys()
        pem = key.private_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()).decode()
        pub = _b64url(key.public_key.public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
        VAPID_FILE.write_text(json.dumps({"privatePem": pem, "publicKey": pub}))
        os.chmod(VAPID_FILE, 0o600)
        _vapid = (pem, pub)
        log.info("generated VAPID keys at %s", VAPID_FILE)
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
    tmp = SUBS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(subs, indent=1))
    os.replace(tmp, SUBS_FILE)


def subscribe(endpoint: str, keys: dict) -> int:
    """Add (or refresh) one device subscription. Returns the list size."""
    if not isinstance(endpoint, str) or not endpoint.startswith("https://"):
        raise ValueError("endpoint must be an https push service URL")
    p256dh, auth = keys.get("p256dh"), keys.get("auth")
    if not isinstance(p256dh, str) or not p256dh or not isinstance(auth, str) or not auth:
        raise ValueError("keys.p256dh and keys.auth are required")
    with _lock:
        subs = [s for s in _load_subs() if s.get("endpoint") != endpoint]
        subs.append({"endpoint": endpoint, "p256dh": p256dh, "auth": auth,
                     "added": int(time.time())})
        _save_subs(subs)
        return len(subs)


def unsubscribe(endpoint: str) -> int:
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


async def push_dialog(gw_id: str, session_name: str | None, dialog: dict) -> int:
    """Notify every subscribed device about a pending dialog. Returns the
    number of devices reached. Never raises."""
    subs = _load_subs()
    if not subs:
        return 0
    method = dialog.get("method") or "dialog"
    title = (dialog.get("title") or "omp needs you").strip().splitlines()[0][:120]
    body = f"{session_name or gw_id}: a {method} dialog is waiting for an answer"
    payload = json.dumps({
        "gwId": gw_id,
        "title": "omp needs you",
        "body": f"{title} - {body}"[:280],
        "tag": f"omp-dialog-{gw_id}-{dialog.get('id')}",
        "url": f"/#/s/{gw_id}",
    })
    delivered, gone = 0, []
    for sub in subs:
        try:
            if await _send_one_async(sub, payload):
                delivered += 1
            else:
                gone.append(sub["endpoint"])
        except Exception as e:
            log.warning("[%s] push to %s... failed: %s", gw_id, sub["endpoint"][:48], e)
    if gone:
        with _lock:
            keep = [s for s in _load_subs() if s.get("endpoint") not in set(gone)]
            _save_subs(keep)
        log.info("[%s] pruned %d dead push subscription(s)", gw_id, len(gone))
    if delivered:
        log.info("[%s] pushed dialog to %d device(s)", gw_id, delivered)
    return delivered


async def _send_one_async(sub: dict, payload: str) -> bool:
    import asyncio
    return await asyncio.to_thread(_send_one, sub, payload)
