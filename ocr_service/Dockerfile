# ProtocolIQ OCR service (PaddleOCR PP-StructureV3, CPU). Build from the repository root:
#   docker build -f ocr_service/Dockerfile -t protocoliq-ocr .
# Needs ~4 GB RAM at runtime. Models are downloaded at build time, so the container runs offline.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    OCR_HOST=0.0.0.0 \
    PROTOCOLIQ_DATA=/data \
    OCR_MODELS_DIR=/opt/models/paddlex

RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY ocr_service/requirements.txt ocr_service/requirements.txt
RUN pip install -r ocr_service/requirements.txt

COPY ocr_service ocr_service
RUN python -m ocr_service.download_models

RUN useradd --create-home ocr && mkdir -p /data && chown -R ocr /data /opt/models
USER ocr

EXPOSE 4200
CMD ["python", "-m", "ocr_service"]
