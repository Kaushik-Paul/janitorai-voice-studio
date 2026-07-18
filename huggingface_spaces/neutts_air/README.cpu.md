---
title: NeuTTS Air CPU API
emoji: 🗣️
colorFrom: indigo
colorTo: blue
sdk: gradio
sdk_version: 6.17.3
python_version: 3.12.12
app_file: app.py
suggested_hardware: cpu-basic
models:
  - neuphonic/neutts-air-q4-gguf
  - neuphonic/neucodec-onnx-decoder-int8
preload_from_hub:
  - neuphonic/neutts-air-q4-gguf neutts-air-Q4_0.gguf
  - neuphonic/neucodec-onnx-decoder-int8 model.onnx
---

# NeuTTS Air free CPU profile

This profile runs Q4 GGUF on CPU Basic and exposes the Kokoro-compatible REST
routes. Set `API_PASSWORD` as a Space secret before using the API.

The web interface is available at the Space root and requires the same password
before generation.
