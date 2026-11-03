"""HMAC-signed, expiring URLs so browsers can upload and view documents without holding the API token.

The ProtocolIQ API (server/ocr.ts) creates the same signatures with the shared OCR_API_TOKEN.
"""

from __future__ import annotations

import hashlib
import hmac
import time

from . import config


def sign(scope: str, document_id: str, exp: int, extra: str = "") -> str:
    payload = f"{scope}:{document_id}:{extra}:{exp}".encode()
    return hmac.new(config.API_TOKEN.encode(), payload, hashlib.sha256).hexdigest()


def verify(scope: str, document_id: str, exp: str | int | None, sig: str | None, extra: str = "") -> bool:
    try:
        expires = int(exp or 0)
    except ValueError:
        return False
    if not sig or expires < time.time():
        return False
    return hmac.compare_digest(sign(scope, document_id, expires, extra), sig)
