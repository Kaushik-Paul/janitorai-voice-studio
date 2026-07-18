from __future__ import annotations

import io
import os
import secrets
from contextlib import asynccontextmanager
from typing import Annotated

import gradio as gr
import soundfile as sf
from fastapi import Depends, FastAPI, HTTPException, Security, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, ConfigDict, Field

from core import (
    DEFAULT_MAX_TEXT_CHARS,
    DEFAULT_VOICE,
    MODEL_ID,
    SAMPLE_RATE,
    VOICES,
    get_cpu_engine,
    public_voices,
)


API_PASSWORD = os.getenv("API_PASSWORD", "").strip()
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    text: str = Field(min_length=1, max_length=DEFAULT_MAX_TEXT_CHARS)
    voice: str = Field(default=DEFAULT_VOICE)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


def require_api_key(
    supplied_key: Annotated[str | None, Security(api_key_header)],
) -> None:
    if not API_PASSWORD:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="API_PASSWORD is not configured in this Space's secrets",
        )
    if supplied_key is None:
        raise HTTPException(status_code=401, detail="Missing API key")
    if not secrets.compare_digest(supplied_key, API_PASSWORD):
        raise HTTPException(status_code=401, detail="Invalid API key")


@asynccontextmanager
async def lifespan(_: FastAPI):
    get_cpu_engine()
    yield


api = FastAPI(title="Kokoro-82M CPU API", version="1.0.0", lifespan=lifespan)
api.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "X-Audio-Sample-Rate", "X-Kokoro-Voice", "X-Kokoro-Segments",
        "X-Kokoro-Workers", "X-Processing-Seconds", "X-Audio-Duration-Seconds",
        "X-Real-Time-Factor",
    ],
)


@api.get("/")
def root() -> dict[str, str]:
    return {
        "service": "Kokoro-82M CPU API",
        "status": "running",
        "docs": "/docs",
        "health": "/health",
        "voices": "/v1/voices",
        "speech": "/v1/audio/speech",
        "ui": "/ui",
    }


@api.get("/health")
def health() -> dict[str, str | int]:
    return {
        "status": "ok",
        "runtime": "cpu-basic-parallel-2",
        "model": MODEL_ID,
        "sample_rate": SAMPLE_RATE,
    }


@api.get("/v1/voices", dependencies=[Depends(require_api_key)])
def list_voices() -> dict[str, object]:
    voices = public_voices()
    return {
        "default_voice": DEFAULT_VOICE,
        "total": len(voices),
        "voices": voices,
        "translation": False,
    }


@api.post(
    "/v1/audio/speech",
    dependencies=[Depends(require_api_key)],
    response_class=StreamingResponse,
)
def create_speech(payload: SpeechRequest) -> StreamingResponse:
    try:
        result = get_cpu_engine().synthesize(payload.text, payload.voice, payload.speed)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Speech synthesis failed ({type(exc).__name__})",
        ) from exc

    buffer = io.BytesIO()
    sf.write(buffer, result.waveform, result.sample_rate, format="WAV", subtype="PCM_16")
    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="audio/wav",
        headers={
            "Content-Disposition": 'inline; filename="speech.wav"',
            "Cache-Control": "no-store",
            "X-Audio-Sample-Rate": str(result.sample_rate),
            "X-Kokoro-Voice": payload.voice,
            "X-Kokoro-Segments": str(result.segments),
            "X-Kokoro-Workers": str(result.workers),
            "X-Processing-Seconds": f"{result.processing_seconds:.3f}",
            "X-Audio-Duration-Seconds": f"{result.audio_seconds:.3f}",
            "X-Real-Time-Factor": f"{result.real_time_factor:.3f}",
        },
    )


def synthesize_for_ui(text: str, voice: str, speed: float):
    result = get_cpu_engine().synthesize(text, voice, speed)
    return (result.sample_rate, result.waveform)


voice_choices = [
    (f"{voice_id} — {voice.language} ({voice.gender})", voice_id)
    for voice_id, voice in VOICES.items()
]

with gr.Blocks(title="Kokoro-82M - CPU") as demo:
    gr.Markdown(
        "# Kokoro-82M — free 2-vCPU profile\n"
        "Long input is synthesized in parallel on both cores. Select a voice "
        "matching the input language; Kokoro does not translate text."
    )
    text_input = gr.Textbox(
        label="Text",
        lines=6,
        value="Kokoro is a small, fast text to speech model.",
    )
    voice_input = gr.Dropdown(choices=voice_choices, value=DEFAULT_VOICE, label="Voice")
    speed_input = gr.Slider(0.5, 2.0, value=1.0, step=0.05, label="Speed")
    generate_button = gr.Button("Generate", variant="primary")
    audio_output = gr.Audio(label="Generated speech")
    generate_button.click(
        synthesize_for_ui,
        inputs=[text_input, voice_input, speed_input],
        outputs=audio_output,
        api_name="synthesize_cpu",
    )


app = gr.mount_gradio_app(api, demo, path="/ui")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=7860)

