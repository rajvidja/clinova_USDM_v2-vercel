import atexit
import os
import shutil
import tempfile

# One temporary data root for the whole test run; ocr_service.config reads it on first import.
os.environ["PROTOCOLIQ_DATA"] = tempfile.mkdtemp(prefix="piq-ocr-test-")
os.environ.pop("OCR_API_TOKEN", None)
atexit.register(shutil.rmtree, os.environ["PROTOCOLIQ_DATA"], True)
