---
title: Kokoro 82M CPU API
emoji: 🎧
colorFrom: green
colorTo: blue
sdk: gradio
sdk_version: 6.17.3
python_version: 3.12.12
app_file: app.py
suggested_hardware: cpu-basic
models:
  - hexgrad/Kokoro-82M
preload_from_hub:
  - hexgrad/Kokoro-82M
---

# Kokoro-82M Hugging Face Spaces

The checked-in default is the free CPU deployment. Use `README.zerogpu.md` as
the Space `README.md` and `app_zerogpu.py` as the application for ZeroGPU.

The CPU API uses two independent one-thread model workers to use both CPU Basic
cores on multi-segment input. Small requests remain a single segment to avoid a
quality-reducing mid-sentence cut.

The password-protected Gradio UI is served at the Space root. Kokoro model and
voice files are preloaded into the build image and each worker model is created
once during startup, not once per request.

Kokoro is a multilingual speech synthesizer, not a text translation model.
