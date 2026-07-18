---
title: NeuTTS Air ZeroGPU
emoji: ⚡
colorFrom: purple
colorTo: indigo
sdk: gradio
sdk_version: 5.49.1
python_version: 3.12.12
app_file: app_zerogpu.py
suggested_hardware: zero-a10g
models:
  - neuphonic/neutts-air
  - neuphonic/neucodec-onnx-decoder-int8
---

# NeuTTS Air on ZeroGPU

This profile uses the BF16 PyTorch NeuTTS Air backbone so Hugging Face can
allocate and release ZeroGPU around each queued inference call.

Select **ZeroGPU** in the Space hardware settings after uploading these files.
Authenticated API calls should pass a Hugging Face token so quota is charged to
the calling account. See `README.cpu.md` or the project documentation for the
free CPU REST deployment and the explanation of reference-based tone control.
