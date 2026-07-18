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

# Kokoro-82M Hugging Face Spaces

The checked-in default is the free CPU deployment. Use `README.zerogpu.md` as
the Space `README.md` and `app_zerogpu.py` as the application for ZeroGPU.

The CPU API uses two independent one-thread pipeline workers backed by one
shared, read-only model to use both CPU Basic cores on multi-segment input.
Longer segments are scheduled first to balance work between cores. Small
requests remain a single segment to avoid a quality-reducing mid-sentence cut.

The password-protected Gradio UI is served at the Space root. Kokoro model and
voice files are preloaded into the build image. The model and default English
pipeline are initialized once during startup, not once per request.

Kokoro is a multilingual speech synthesizer, not a text translation model.

## Uploading both Spaces

Authenticate once with `hf auth login`, then run this from the repository root:

```bash
python3 huggingface_spaces/kokoro_82m/upload_spaces.py
```

Use `--dry-run` to validate the exact CPU and ZeroGPU manifests without
uploading, or `--target cpu` / `--target zerogpu` to update only one Space.
