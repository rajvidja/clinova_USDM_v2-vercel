"""ProtocolIQ OCR service (FastAPI), deployable on its own host.

The service stores uploaded documents and their OCR output under DATA_ROOT/documents/<id>/.
- Server-to-server calls from the ProtocolIQ API use `Authorization: Bearer <OCR_API_TOKEN>`.
- Browsers upload originals and load page images through short-lived signed URLs issued by the API.

Run:  .venv-ocr/bin/python -m ocr_service
"""

from __future__ import annotations

import logging
import re
import shutil
import sys
import threading
import time
from pathlib import Path
from typing import Any

from . import config

config.configure_paddle_env()

from fastapi import Depends, FastAPI, Header, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from .documents import DocumentError  # noqa: E402
from .engine import ENGINE, PROFILES, resolve_device, versions  # noqa: E402
from .jobs import JobManager, inspect, read_json, render  # noqa: E402
from .signing import verify  # noqa: E402

logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ocr")

if not config.API_TOKEN:
    raise RuntimeError("OCR_API_TOKEN must be set when the OCR service listens on a non-local address.")
if config.API_TOKEN == config.DEV_TOKEN:
    log.warning("Using the local development token; set OCR_API_TOKEN for any shared deployment.")

app = FastAPI(title="ProtocolIQ OCR service", version="2.0")
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_methods=["GET", "PUT"], allow_headers=["Content-Type"], max_age=3600)
jobs = JobManager()
STARTED = time.time()
WARM = threading.Event()
DOCS = config.DATA_ROOT / "documents"
ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

MAGIC = {
    ".pdf": lambda b: b"%PDF-" in b[:1024],
    ".png": lambda b: b.startswith(b"\x89PNG\r\n\x1a\n"),
    ".jpg": lambda b: b.startswith(b"\xff\xd8\xff"),
    ".jpeg": lambda b: b.startswith(b"\xff\xd8\xff"),
    ".tif": lambda b: b[:4] in (b"II*\x00", b"MM\x00*"),
    ".tiff": lambda b: b[:4] in (b"II*\x00", b"MM\x00*"),
}


def _warm_up() -> None:
    """Import PaddlePaddle and resolve the device in the background (the first import takes tens of seconds)."""
    try:
        log.info("Inference device: %s", resolve_device())
    except Exception as e:
        log.error("Device check failed: %s", e)
    WARM.set()


def _sweep() -> None:
    """Delete documents older than the retention period."""
    while config.RETENTION_HOURS > 0:
        cutoff = time.time() - config.RETENTION_HOURS * 3600
        active = {s["documentId"] for s in jobs.active()}
        for d in DOCS.glob("*") if DOCS.exists() else []:
            if d.is_dir() and d.name not in active and d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True)
                log.info("Removed expired document %s", d.name)
        time.sleep(3600)


threading.Thread(target=_warm_up, name="ocr-warmup", daemon=True).start()
threading.Thread(target=_sweep, name="ocr-retention", daemon=True).start()


def require_token(authorization: str = Header(default="")) -> None:
    if authorization != f"Bearer {config.API_TOKEN}":
        raise HTTPException(401, "Missing or invalid OCR service token")


def doc_dir(document_id: str) -> Path:
    if not ID_RE.match(document_id):
        raise HTTPException(400, "Invalid document id")
    return DOCS / document_id


def original(document_id: str) -> Path:
    found = sorted(doc_dir(document_id).glob("original.*"))
    if not found:
        raise HTTPException(404, "Document not found on the OCR service (it may have expired)")
    return found[0]


def work_dir(document_id: str) -> Path:
    return doc_dir(document_id) / "ocr"


class JobRequest(BaseModel):
    document_name: str
    mime_type: str
    options: dict[str, Any] = {}


def _models_present() -> list[str]:
    root = config.MODELS_DIR / "official_models"
    return sorted(p.name for p in root.iterdir() if p.is_dir()) if root.exists() else []


@app.get("/health")
def health() -> dict[str, Any]:
    device, device_error = None, None
    if WARM.is_set():
        try:
            device = resolve_device()
        except RuntimeError as e:
            device_error = str(e)
    return {
        "ok": device_error is None,
        "warming": not WARM.is_set(),
        "uptimeSeconds": round(time.time() - STARTED),
        "device": device,
        "deviceError": device_error,
        "configuredDevice": config.DEVICE,
        "profile": config.MODEL_PROFILE,
        "textModels": PROFILES.get(config.MODEL_PROFILE),
        "modelsDownloaded": _models_present(),
        "pipelinesLoaded": ENGINE.loaded(),
        "activeJobs": len(jobs.active()),
        "versions": versions(),
    }


@app.put("/v1/documents/{document_id}/file")
async def upload(document_id: str, request: Request, ext: str, exp: str, sig: str) -> dict[str, Any]:
    """Browser upload of the original file through a signed URL (the API never handles the bytes)."""
    ext = ext.lower()
    if ext not in MAGIC or not verify("upload", document_id, exp, sig, ext):
        raise HTTPException(403, "The upload link is invalid or has expired. Start the upload again.")
    d = doc_dir(document_id)
    if any(d.glob("original.*")):
        raise HTTPException(409, "This document has already been uploaded")
    d.mkdir(parents=True, exist_ok=True)
    target, tmp = d / f"original{ext}", d / f".upload{ext}"
    limit, size, head = config.MAX_UPLOAD_MB * 1024 * 1024, 0, b""
    try:
        with tmp.open("wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"The file is larger than {config.MAX_UPLOAD_MB} MB")
                if len(head) < 1024:
                    head += chunk[: 1024 - len(head)]
                f.write(chunk)
        if size == 0:
            raise HTTPException(400, "Empty upload")
        if not MAGIC[ext](head):
            raise HTTPException(415, f"The file content does not look like a valid {ext[1:].upper()} file.")
        tmp.replace(target)
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)
        raise
    return {"size": size}


@app.post("/v1/documents/{document_id}/inspect", dependencies=[Depends(require_token)])
def inspect_document(document_id: str) -> dict[str, Any]:
    try:
        return inspect(str(original(document_id)), str(work_dir(document_id))) | {"size": original(document_id).stat().st_size}
    except DocumentError as e:
        raise HTTPException(422, str(e)) from e


@app.post("/v1/documents/{document_id}/jobs", status_code=202, dependencies=[Depends(require_token)])
def submit(document_id: str, req: JobRequest) -> dict[str, Any]:
    opts = req.options or {}
    if opts.get("mode") not in (None, "structure", "text"):
        raise HTTPException(400, "mode must be 'structure' or 'text'")
    if opts.get("device"):
        try:
            resolve_device(opts["device"])
        except RuntimeError as e:
            raise HTTPException(400, str(e)) from e
    try:
        return jobs.submit(document_id, req.document_name, req.mime_type, str(original(document_id)), str(work_dir(document_id)), opts)
    except DocumentError as e:
        raise HTTPException(422, str(e)) from e


@app.get("/v1/documents/{document_id}/status", dependencies=[Depends(require_token)])
def job_status(document_id: str) -> dict[str, Any]:
    status = jobs.get(document_id) or read_json(work_dir(document_id) / "status.json")
    if not status:
        raise HTTPException(404, "This document has not been processed")
    if status.get("status") in ("queued", "processing") and jobs.get(document_id) is None:
        status = {**status, "status": "failed", "message": "Processing was interrupted (the OCR service restarted). Reprocess to continue."}
    return status


@app.post("/v1/documents/{document_id}/cancel", dependencies=[Depends(require_token)])
def cancel(document_id: str) -> dict[str, Any]:
    status = jobs.cancel(document_id)
    if status is None:
        raise HTTPException(404, "No job for this document in the running service")
    return status


@app.get("/v1/documents/{document_id}/result", dependencies=[Depends(require_token)])
def result(document_id: str) -> FileResponse:
    path = work_dir(document_id) / "result.json"
    if not path.exists():
        raise HTTPException(404, "No OCR results yet")
    return FileResponse(path, media_type="application/json")


@app.get("/v1/documents/{document_id}/file")
def download(document_id: str, exp: str, sig: str) -> FileResponse:
    if not verify("read", document_id, exp, sig):
        raise HTTPException(403, "The link is invalid or has expired")
    path = original(document_id)
    return FileResponse(path, content_disposition_type="inline", filename=path.name)


@app.get("/v1/documents/{document_id}/pages/{page}/image")
def page_image(document_id: str, page: int, exp: str, sig: str) -> FileResponse:
    if not verify("read", document_id, exp, sig):
        raise HTTPException(403, "The link is invalid or has expired")
    wd = work_dir(document_id)
    processed = next((p.get("image") for p in (read_json(wd / "result.json") or {}).get("pages", []) if p.get("page") == page), None)
    path = (wd / processed).resolve() if processed else None
    if not path or not path.is_relative_to(wd.resolve()) or not path.exists():
        try:
            path = render(str(original(document_id)), str(wd), page)
        except DocumentError as e:
            raise HTTPException(404, str(e)) from e
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@app.delete("/v1/documents/{document_id}", status_code=204, dependencies=[Depends(require_token)])
def delete(document_id: str) -> None:
    jobs.cancel(document_id)
    shutil.rmtree(doc_dir(document_id), ignore_errors=True)
