---
title: Kokoro 82M CPU API
emoji: 🎧
colorFrom: green
colorTo: blue
sdk: gradio
sdk_version: 6.20.0
python_version: 3.12.12
app_file: app.py
suggested_hardware: cpu-basic
models:
  - hexgrad/Kokoro-82M
preload_from_hub:
  - hexgrad/Kokoro-82M
---

# Kokoro-82M free CPU API

This Space runs Kokoro-82M on the free 2-vCPU CPU Basic hardware. Long input is
split at sentence boundaries and synthesized by two independent, single-threaded
pipeline workers sharing one read-only model. Uneven segments are balanced by
estimated text length, then restored to the original order and joined into one
WAV file.

Set `API_PASSWORD` as a Space secret. The protected REST routes are:

- `GET /v1/voices`
- `POST /v1/audio/speech`

The web interface is available at the Space root and requires the same password
before generation.

Kokoro is multilingual text-to-speech, not a translator. Submit text in the
language associated with the selected voice.
