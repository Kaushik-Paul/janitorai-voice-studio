# Kokoro Cloud Run TTS API

Password-protected FastAPI service for running Kokoro-82M on
Google Cloud Run.

## Features

- Kokoro-82M running on CPU
- American and British English voices
- Configurable speech speed
- WAV audio responses
- API-key authentication
- CORS enabled for all origins
- Model files included in the Docker image
- Suitable for Cloud Run scale-to-zero deployment

## Project structure

```text
kokoro-cloud-run/
├── main/
│   ├── __init__.py
│   └── app.py
├── .dockerignore
├── .gitignore
├── Dockerfile
├── README.md
└── requirements.txt