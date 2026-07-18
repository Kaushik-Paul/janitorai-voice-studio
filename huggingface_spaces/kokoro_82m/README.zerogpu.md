---
title: Kokoro 82M ZeroGPU
emoji: ⚡
colorFrom: yellow
colorTo: green
sdk: gradio
sdk_version: 6.20.0
python_version: 3.12.12
app_file: app.py
suggested_hardware: zero-a10g
models:
  - hexgrad/Kokoro-82M
preload_from_hub:
  - hexgrad/Kokoro-82M
---

# Kokoro-82M on ZeroGPU

This profile loads Kokoro-82M on CUDA and allocates ZeroGPU only while queued
speech synthesis is running. Use the Gradio endpoint `synthesize_zerogpu` with
an authenticated Hugging Face token so the caller receives the appropriate
queue priority and quota accounting.

Set `API_PASSWORD` as a Space secret. The visible web interface requires this
password before generation. It is not an extra parameter on the
`synthesize_zerogpu(text, voice, speed)` API endpoint; API callers continue to
authenticate with their Hugging Face token.

Kokoro speaks text in the selected voice's language; it does not translate it.
