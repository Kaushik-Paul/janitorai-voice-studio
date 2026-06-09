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

# Install the spaCy English model required by Kokoro/Misaki.
RUN python -m pip install \
    https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl

# Verify the spaCy model during the build.
RUN python -c "import spacy; nlp = spacy.load('en_core_web_sm'); print('spaCy model loaded:', nlp.pipe_names)"

RUN mkdir -p /opt/kokoro/voices

COPY scripts/download_model.py /app/scripts/download_model.py

RUN python /app/scripts/download_model.py

# Fail the build if required Kokoro files are absent.
RUN test -f /opt/kokoro/config.json \
    && test -f /opt/kokoro/kokoro-v1_0.pth \
    && test -f /opt/kokoro/voices/af_heart.pt \
    && echo "Kokoro model files verified successfully" \
    && du -sh /opt/kokoro

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