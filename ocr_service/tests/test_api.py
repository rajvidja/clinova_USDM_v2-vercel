"""HTTP API of the hosted OCR service: token auth, signed browser uploads and document lifecycle (no models loaded)."""

from __future__ import annotations

import time
import unittest
import uuid
from pathlib import Path

from fastapi.testclient import TestClient

from ocr_service import config
from ocr_service.app import app
from ocr_service.signing import sign

PDF = (Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "ocr" / "protocol-digital.pdf").read_bytes()
PNG = (Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "ocr" / "soa-page.png").read_bytes()
AUTH = {"Authorization": f"Bearer {config.API_TOKEN}"}


def upload_url(doc: str, ext: str, ttl: int = 600) -> str:
    exp = int(time.time()) + ttl
    return f"/v1/documents/{doc}/file?ext={ext}&exp={exp}&sig={sign('upload', doc, exp, ext)}"


def read_query(doc: str) -> str:
    exp = int(time.time()) + 600
    return f"exp={exp}&sig={sign('read', doc, exp)}"


class ApiTests(unittest.TestCase):
    client = TestClient(app)

    def test_signed_upload_inspect_download_and_delete(self) -> None:
        doc = str(uuid.uuid4())
        r = self.client.put(upload_url(doc, ".pdf"), content=PDF)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["size"], len(PDF))
        self.assertEqual(self.client.put(upload_url(doc, ".pdf"), content=PDF).status_code, 409, "no overwrite")

        info = self.client.post(f"/v1/documents/{doc}/inspect", headers=AUTH).json()
        self.assertEqual(info["pageCount"], 5)
        self.assertEqual(info["size"], len(PDF))

        self.assertEqual(self.client.get(f"/v1/documents/{doc}/file?{read_query(doc)}").content, PDF)
        img = self.client.get(f"/v1/documents/{doc}/pages/2/image?{read_query(doc)}")
        self.assertEqual(img.headers["content-type"], "image/png")
        self.assertEqual(self.client.get(f"/v1/documents/{doc}/pages/9/image?{read_query(doc)}").status_code, 404)

        self.assertEqual(self.client.delete(f"/v1/documents/{doc}", headers=AUTH).status_code, 204)
        self.assertEqual(self.client.post(f"/v1/documents/{doc}/inspect", headers=AUTH).status_code, 404)

    def test_server_endpoints_require_the_token(self) -> None:
        doc = str(uuid.uuid4())
        self.assertEqual(self.client.post(f"/v1/documents/{doc}/inspect").status_code, 401)
        self.assertEqual(self.client.get(f"/v1/documents/{doc}/result", headers={"Authorization": "Bearer wrong"}).status_code, 401)

    def test_bad_expired_or_mismatched_links_are_refused(self) -> None:
        doc = str(uuid.uuid4())
        self.assertEqual(self.client.put(upload_url(doc, ".pdf", ttl=-5), content=PDF).status_code, 403, "expired")
        self.assertEqual(self.client.put(upload_url(doc, ".pdf").replace("ext=.pdf", "ext=.png"), content=PNG).status_code, 403, "file type is signed")
        self.assertEqual(self.client.get(f"/v1/documents/{doc}/file?exp=9999999999&sig=00").status_code, 403)
        self.assertEqual(self.client.put(upload_url("not-a-document-id", ".pdf"), content=PDF).status_code, 400)

    def test_content_must_match_the_declared_type(self) -> None:
        doc = str(uuid.uuid4())
        r = self.client.put(upload_url(doc, ".pdf"), content=PNG)
        self.assertEqual(r.status_code, 415)
        self.assertFalse((config.DATA_ROOT / "documents" / doc).exists(), "rejected uploads leave nothing behind")

    def test_cors_only_for_configured_origins(self) -> None:
        url = upload_url(str(uuid.uuid4()), ".pdf")
        ok = self.client.options(url, headers={"Origin": config.CORS_ORIGINS[0], "Access-Control-Request-Method": "PUT"})
        self.assertEqual(ok.status_code, 200)
        bad = self.client.options(url, headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "PUT"})
        self.assertNotIn("access-control-allow-origin", bad.headers)


if __name__ == "__main__":
    unittest.main()
