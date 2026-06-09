FROM python:3.11-slim-bookworm


ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/huggingface \
    TRANSFORMERS_CACHE=/opt/huggingface/transformers


WORKDIR /app


# espeak-ng:
# Required by Kokoro's English text frontend.
#
# libsndfile1:
# Required by the Python soundfile package.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        espeak-ng \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*


COPY requirements.txt /app/requirements.txt


# Install CPU-only PyTorch first.
#
# Installing the normal PyPI build can pull unnecessary
# CUDA-related packages into the image.
RUN python -m pip install --upgrade \
        pip \
        setuptools \
        wheel \
    && python -m pip install \
        --index-url https://download.pytorch.org/whl/cpu \
        torch==2.7.1 \
    && python -m pip install \
        -r /app/requirements.txt


# Download the model weights and all English voices while
# building the Docker image.
#
# The application therefore does not need to download model
# files during every Cloud Run cold start.
RUN python - <<'PY'
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id="hexgrad/Kokoro-82M",
    allow_patterns=[
        "config.json",
        "kokoro-v1_0.pth",
        "voices/af_*.pt",
        "voices/am_*.pt",
        "voices/bf_*.pt",
        "voices/bm_*.pt",
    ],
)
PY


# Disallow runtime Hugging Face downloads. All supported files
# have already been saved in the Docker image.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1


COPY main /app/main


# Do not run the web service as root.
RUN useradd \
        --create-home \
        --uid 10001 \
        appuser \
    && chown -R appuser:appuser \
        /app \
        /opt/huggingface


USER appuser


EXPOSE 8080


# Cloud Run supplies the PORT environment variable.
#
# main.app:app is required because app.py is inside the
# main Python package.
CMD ["sh", "-c", "exec uvicorn main.app:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1"]