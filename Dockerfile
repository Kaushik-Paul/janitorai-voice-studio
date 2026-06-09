FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    KOKORO_MODEL_DIR=/opt/kokoro

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        espeak-ng \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt

RUN python -m pip install --upgrade \
        pip \
        setuptools \
        wheel \
    && python -m pip install \
        --index-url https://download.pytorch.org/whl/cpu \
        torch==2.7.1 \
    && python -m pip install \
        -r /app/requirements.txt

RUN python -m pip install \
    https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl

RUN python - <<'PY'
import spacy

nlp = spacy.load("en_core_web_sm")
print("spaCy English model loaded successfully")
print(nlp.pipe_names)
PY


RUN mkdir -p /opt/kokoro/voices

RUN python - <<'PY'
from huggingface_hub import snapshot_download

path = snapshot_download(
    repo_id="hexgrad/Kokoro-82M",
    local_dir="/opt/kokoro",
    allow_patterns=[
        "config.json",
        "kokoro-v1_0.pth",
        "voices/af_*.pt",
        "voices/am_*.pt",
        "voices/bf_*.pt",
        "voices/bm_*.pt",
    ],
)

print(f"Kokoro files downloaded to: {path}")
PY

RUN test -f /opt/kokoro/config.json \
    && test -f /opt/kokoro/kokoro-v1_0.pth \
    && test -f /opt/kokoro/voices/af_heart.pt \
    && echo "Kokoro model files verified successfully" \
    && du -sh /opt/kokoro \
    && find /opt/kokoro -maxdepth 2 -type f | sort

COPY main /app/main

RUN useradd \
        --create-home \
        --uid 10001 \
        appuser \
    && chown -R appuser:appuser \
        /app \
        /opt/kokoro

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

USER appuser

EXPOSE 8080

CMD ["sh", "-c", "exec uvicorn main.app:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1"]