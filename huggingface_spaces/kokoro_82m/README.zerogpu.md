---
title: Kokoro 82M ZeroGPU
emoji: ⚡
colorFrom: yellow
colorTo: green
sdk: gradio
sdk_version: 6.17.3
python_version: 3.12.12
app_file: app_zerogpu.py
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

Kokoro speaks text in the selected voice's language; it does not translate it.
