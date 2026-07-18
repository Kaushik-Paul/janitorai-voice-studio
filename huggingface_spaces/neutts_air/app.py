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
    SAMPLE_RATE,
    get_engine,
    public_voice_profiles,
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
    # Load once at startup so requests do not each reload llama.cpp and the codec.
    get_engine("cpu")
    yield


api = FastAPI(
    title="NeuTTS Air CPU API",
    version="1.0.0",
    lifespan=lifespan,
)
api.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Audio-Sample-Rate", "X-NeuTTS-Voice"],
)


@api.get("/")
def root() -> dict[str, str]:
    return {
        "service": "NeuTTS Air CPU API",
        "status": "running",
        "health": "/health",
        "voices": "/v1/voices",
        "speech": "/v1/audio/speech",
        "ui": "/ui",
    }


@api.get("/health")
def health() -> dict[str, str | int]:
    return {
        "status": "ok",
        "runtime": "cpu",
        "model": "neuphonic/neutts-air-q4-gguf",
        "sample_rate": SAMPLE_RATE,
    }


@api.get("/v1/voices", dependencies=[Depends(require_api_key)])
def list_voices() -> dict[str, object]:
    voices = public_voice_profiles()
    return {
        "default_voice": DEFAULT_VOICE,
        "total": len(voices),
        "voices": voices,
        "style_control": "reference-profile",
    }


@api.post(
    "/v1/audio/speech",
    dependencies=[Depends(require_api_key)],
    response_class=StreamingResponse,
)
def create_speech(payload: SpeechRequest) -> StreamingResponse:
    try:
        sample_rate, waveform = get_engine("cpu").synthesize(
            payload.text,
            payload.voice,
            payload.speed,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Speech synthesis failed ({type(exc).__name__})",
        ) from exc

    buffer = io.BytesIO()
    sf.write(buffer, waveform, sample_rate, format="WAV", subtype="PCM_16")
    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="audio/wav",
        headers={
            "Content-Disposition": 'inline; filename="speech.wav"',
            "X-Audio-Sample-Rate": str(sample_rate),
            "X-NeuTTS-Voice": payload.voice,
        },
    )


def synthesize_for_ui(text: str, voice: str, speed: float):
    return get_engine("cpu").synthesize(text, voice, speed)


with gr.Blocks(title="NeuTTS Air - CPU") as demo:
    gr.Markdown(
        "# NeuTTS Air — free CPU profile\n"
        "Q4 GGUF inference on CPU. Tone comes from the selected reference profile."
    )
    text_input = gr.Textbox(
        label="Text",
        lines=6,
        value="This is NeuTTS Air running on a free CPU Space.",
    )
    voice_input = gr.Dropdown(
        choices=[
            (profile["label"], voice_id)
            for voice_id, profile in public_voice_profiles().items()
        ],
        value=DEFAULT_VOICE,
        label="Voice / tone reference",
    )
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

    # Gradio SDK Spaces reserve port 7860. The platform may expose an unrelated
    # PORT variable (currently 7861), which must not override the listen port.
    uvicorn.run(app, host="0.0.0.0", port=7860)
