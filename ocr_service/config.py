"""Runtime configuration for the ProtocolIQ OCR service (environment variables)."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

HOST = os.environ.get("OCR_HOST", "127.0.0.1")
PORT = int(os.environ.get("OCR_PORT", os.environ.get("PORT", "4200")))

# The service stores uploaded documents and OCR output itself; only files inside this directory are read or written.
DATA_ROOT = Path(os.environ.get("PROTOCOLIQ_DATA", ROOT / "data")).resolve()

# Shared secret with the ProtocolIQ API: bearer token for server calls and HMAC key for signed browser URLs.
# A fixed development token is used only when the service listens on localhost.
DEV_TOKEN = "protocoliq-local-dev-token"
API_TOKEN = os.environ.get("OCR_API_TOKEN") or (DEV_TOKEN if HOST in ("127.0.0.1", "localhost") else "")
# Browser origins allowed to upload directly (comma separated), e.g. https://my-app.vercel.app
CORS_ORIGINS = [o.strip().rstrip("/") for o in os.environ.get("OCR_CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()]
MAX_UPLOAD_MB = int(os.environ.get("OCR_MAX_UPLOAD_MB", "200"))
# Uploaded documents and their OCR output are deleted after this many hours (0 keeps them).
RETENTION_HOURS = float(os.environ.get("OCR_RETENTION_HOURS", "72"))

# PaddleOCR / PaddleX model cache. Models are downloaded once and reused offline afterwards.
MODELS_DIR = Path(os.environ.get("OCR_MODELS_DIR", ROOT / "models" / "paddlex")).resolve()

# "auto" picks the first CUDA GPU when Paddle was built with CUDA, otherwise CPU. Also: "cpu", "gpu", "gpu:1".
DEVICE = os.environ.get("OCR_DEVICE", "auto")

# "balanced": mobile PP-OCRv5 text models + full layout/table models; "accurate": server PP-OCRv5 text models.
MODEL_PROFILE = os.environ.get("OCR_MODEL_PROFILE", "balanced")
LANG = os.environ.get("OCR_LANG", "en")

RENDER_DPI = int(os.environ.get("OCR_DPI", "200"))
PREVIEW_DPI = int(os.environ.get("OCR_PREVIEW_DPI", "110"))
CPU_THREADS = int(os.environ.get("OCR_CPU_THREADS", str(max(1, (os.cpu_count() or 4)))))

# A PDF page with fewer extractable characters than this is treated as scanned and sent to OCR.
MIN_NATIVE_CHARS = int(os.environ.get("OCR_MIN_NATIVE_CHARS", "25"))
# Embedded images covering at least this fraction of a digital page make it "mixed".
MIXED_IMAGE_COVERAGE = float(os.environ.get("OCR_MIXED_IMAGE_COVERAGE", "0.2"))
# Embedded raster images at least this large (fraction of page) are OCR'd on digital pages.
EMBEDDED_IMAGE_MIN_AREA = float(os.environ.get("OCR_EMBEDDED_IMAGE_MIN_AREA", "0.04"))

MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "2000"))


def configure_paddle_env() -> None:
    """Must run before paddleocr/paddlex are imported."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(MODELS_DIR))
    # Skip the network reachability probe of model hosts on start-up; it is only needed for downloads.
    if os.environ.get("OCR_OFFLINE", "auto") != "0" and any((MODELS_DIR / "official_models").glob("*")):
        os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", os.environ.get("OCR_MODEL_SOURCE", "huggingface"))
    os.environ.setdefault("FLAGS_allocator_strategy", "auto_growth")
