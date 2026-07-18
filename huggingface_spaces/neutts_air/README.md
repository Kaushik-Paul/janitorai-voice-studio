---
title: NeuTTS Air CPU API
emoji: 🗣️
colorFrom: indigo
colorTo: blue
sdk: gradio
sdk_version: 5.49.1
python_version: 3.12.12
app_file: app.py
suggested_hardware: cpu-basic
models:
  - neuphonic/neutts-air-q4-gguf
  - neuphonic/neucodec-onnx-decoder-int8
---

# NeuTTS Air on Hugging Face Spaces

This is the free CPU deployment profile for the JanitorAI Voice Studio
project. It runs `neuphonic/neutts-air-q4-gguf` with llama.cpp and the INT8
ONNX NeuCodec decoder.

## API

Set an `API_PASSWORD` secret in the Space settings. The API matches the
existing Kokoro Cloud Run contract:

- `GET /health`
- `GET /v1/voices` with `X-API-Key`
- `POST /v1/audio/speech` with `X-API-Key`

Example:

```bash
curl -X POST "https://YOUR-SPACE.hf.space/v1/audio/speech" \
  -H "X-API-Key: $API_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello from NeuTTS Air.",
    "voice": "jo_clean_conversational",
    "speed": 1.0
  }' \
  --output speech.wav
```

The Gradio UI is available at `/ui`.

## Tone and style

NeuTTS Air is not an instruction-following TTS model. Unlike Mimo v2.5 TTS,
it cannot accept a system prompt such as "speak warmly and intimately" without
risking that text being spoken. Its voice and delivery come from a reference
recording and the exact transcript of that recording.

The `voice` field therefore selects a combined voice/tone reference profile.
This starter includes Neuphonic's official Jo and Dave references. Add your own
licensed reference codes and matching transcript in `core.py` to create more
tones. Only clone a voice when you have permission to use it.

## CPU limitations

CPU Basic provides only 2 vCPU, so this profile will be substantially slower
than real time for longer text. The server splits input into conservative
segments to stay inside NeuTTS Air's 2,048-token context, and handles one
inference at a time. Free Spaces also sleep after inactivity and have a cold
start.

## ZeroGPU deployment

Create a second Gradio Space, copy this same folder into it, and replace this
README with `README.zerogpu.md`. Then select **ZeroGPU** in the Space hardware
settings.

ZeroGPU uses `app_zerogpu.py` and the BF16 PyTorch model, not the Q4 GGUF
model. This is intentional: ZeroGPU's CUDA lifecycle is designed for PyTorch,
whereas Q4 GGUF runs through llama.cpp and is the better CPU profile.

ZeroGPU exposes Hugging Face's queued Gradio endpoints:

- `/synthesize_zerogpu`
- `/voices`

Use the Space's **Use via API** panel or `gradio_client`. Pass your Hugging
Face token so usage is attributed to your PRO quota:

```python
from gradio_client import Client

client = Client("YOUR_USERNAME/YOUR_ZERO_GPU_SPACE", token="hf_...")
audio_path = client.predict(
    text="Hello from ZeroGPU.",
    voice="jo_clean_conversational",
    speed=1.0,
    api_name="/synthesize_zerogpu",
)
print(audio_path)
```

The queued API is required for correct ZeroGPU scheduling and quota handling;
it is not the same single-request WAV REST response used by the CPU Space.
