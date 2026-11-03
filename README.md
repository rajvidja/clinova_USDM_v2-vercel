# ProtocolIQ — Vercel edition

This is the deployable copy of [ProtocolIQ](https://github.com/rajvidja/clinova_USDM_v2), a rule-based clinical protocol builder with USDM mapping and PaddleOCR document digitisation. No generative AI is used anywhere.

It differs from the original in two ways:

- **Demo data.** On Vercel the database is a temporary SQLite file in `/tmp`, seeded with the synthetic EXA-101 example protocol on each cold start. Edits work, but they are lost whenever the function instance is recycled. A banner in the app says so.
- **Remote OCR.** PaddleOCR needs several GB of RAM and long-running jobs, so it can't run inside a Vercel function. The Python service in `ocr_service/` runs on a separate host instead. Browsers upload PDFs and images straight to it through short-lived signed links, which avoids Vercel's 4.5 MB request limit. The Vercel API calls the service with a shared bearer token.

```
Browser ──► Vercel (static React app + /api Node function, demo SQLite in /tmp)
   │                     │  Authorization: Bearer OCR_API_TOKEN
   │ signed PUT/GET      ▼
   └──────────────► OCR service (FastAPI + PaddleOCR, Docker, ~4 GB RAM)
```

Without an OCR service, everything else still works: Protocol Builder, USDM export, PDF and DOCX export, and `.docx`/`.txt`/`.md`/`.html` digitisation. PDF and image uploads then show a "not configured" notice.

## 1. Deploy the app on Vercel

1. In Vercel, choose **Add New → Project** and import this GitHub repository.
2. Leave the framework preset as **Other**. `vercel.json` already sets the install command (`npm ci`) and the build command (`npm run build:vercel`).
3. Set the Node.js version to **22.x** (Settings → General). The API relies on the built-in `node:sqlite` module.
4. Deploy. The site and the example protocol work right away.

`npm run build:vercel` writes Vercel's Build Output API v3 format into `.vercel/output`: the Vite build under `static/`, and one bundled Node function for `/api/*`.

## 2. Host the OCR service (optional)

Any Docker host with about **4 GB of RAM** will work, for example Render, Railway, Fly.io, Google Cloud Run or a VM. The image downloads the PaddleOCR models at build time, so it runs offline afterwards.

```bash
docker build -f ocr_service/Dockerfile -t protocoliq-ocr .
docker run -p 4200:4200 \
  -e OCR_API_TOKEN=$(openssl rand -hex 32) \
  -e OCR_CORS_ORIGINS=https://your-app.vercel.app \
  -v protocoliq-ocr-data:/data \
  protocoliq-ocr
```

The service listens on `$PORT` if the host provides one, otherwise on 4200. Check it with `GET /health`. It refuses to start on a public interface without `OCR_API_TOKEN`.

On a platform, point it at this repo with Dockerfile path `ocr_service/Dockerfile` and build context `.` (the repo root). Mount a persistent disk at `/data` if you want results to survive restarts.

Then add these to the Vercel project and redeploy:

| Vercel variable | Value |
| --- | --- |
| `OCR_SERVICE_URL` | Public HTTPS URL of the OCR service |
| `OCR_API_TOKEN` | Same token as on the service |
| `OCR_PUBLIC_URL` | Optional; the URL browsers should use, if different |

### Environment variables for the OCR service

| Variable | Default | Purpose |
| --- | --- | --- |
| `OCR_API_TOKEN` | required | Shared secret for server-to-server calls; also signs browser links |
| `OCR_CORS_ORIGINS` | `http://localhost:5173` | Comma-separated origins allowed to upload, e.g. `https://your-app.vercel.app` |
| `OCR_RETENTION_HOURS` | `72` | Uploaded files and results are deleted after this many hours (`0` = never) |
| `OCR_MAX_UPLOAD_MB` | `200` | Upload size limit |
| `PROTOCOLIQ_DATA` | `/data` | Where documents and results are stored |

See `.env.example` for a full list.

## Demo limitations

- Data resets on cold starts, and different function instances can hold different copies, so don't use this deployment for real work.
- `.docx`/`.txt`/`.md`/`.html` files go through the Vercel function, so they are limited to about 4 MB. PDFs and images go directly to the OCR service (up to 200 MB).
- OCR documents in the demo database can outlive the files on the OCR service (and the other way round). Re-upload if a document shows as missing.
- Do not upload real or confidential protocols to a public demo.

## Local development

This is the same as the original project:

```bash
npm ci
npm run ocr:setup     # one-time: Python venv + PaddleOCR models (optional)
npm run dev           # API :4000, web :5173, OCR :4200
npm test              # Node tests
npm run test:ocr      # Python tests
```

Locally the OCR service binds to `127.0.0.1` and uses a built-in development token, so no configuration is needed. To try the Vercel build locally, run `npm run build:vercel` and then use `vercel dev` or `vercel deploy --prebuilt`.
