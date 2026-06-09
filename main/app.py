from __future__ import annotations

import io
import os
import secrets
import threading
from contextlib import asynccontextmanager
from typing import Annotated, Iterator

import numpy as np
import soundfile as sf
import torch
from fastapi import Depends, FastAPI, HTTPException, Request, Security, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.security import APIKeyHeader
from kokoro import KModel, KPipeline
from pydantic import BaseModel, ConfigDict, Field


MODEL_ID = "hexgrad/Kokoro-82M"
MODEL_DIRECTORY = os.getenv(
    "KOKORO_MODEL_DIR",
    "/opt/kokoro",
)

MODEL_CONFIG_PATH = os.path.join(
    MODEL_DIRECTORY,
    "config.json",
)

MODEL_WEIGHTS_PATH = os.path.join(
    MODEL_DIRECTORY,
    "kokoro-v1_0.pth",
)

VOICE_DIRECTORY = os.path.join(
    MODEL_DIRECTORY,
    "voices",
)

SAMPLE_RATE = 24_000

MAX_TEXT_CHARS = int(
    os.getenv("MAX_TEXT_CHARS", "6000")
)

TORCH_NUM_THREADS = max(
    1,
    int(os.getenv("TORCH_NUM_THREADS", "1")),
)

API_PASSWORD = os.getenv("API_PASSWORD")

if not API_PASSWORD:
    raise RuntimeError(
        "API_PASSWORD environment variable is required"
    )


AMERICAN_FEMALE_VOICES = [
    "af_heart",
    "af_alloy",
    "af_aoede",
    "af_bella",
    "af_jessica",
    "af_kore",
    "af_nicole",
    "af_nova",
    "af_river",
    "af_sarah",
    "af_sky",
]

AMERICAN_MALE_VOICES = [
    "am_adam",
    "am_echo",
    "am_eric",
    "am_fenrir",
    "am_liam",
    "am_michael",
    "am_onyx",
    "am_puck",
    "am_santa",
]

BRITISH_FEMALE_VOICES = [
    "bf_alice",
    "bf_emma",
    "bf_isabella",
    "bf_lily",
]

BRITISH_MALE_VOICES = [
    "bm_daniel",
    "bm_fable",
    "bm_george",
    "bm_lewis",
]


VOICES: dict[str, dict[str, str]] = {
    **{
        voice: {
            "language_code": "a",
            "language": "English",
            "accent": "American",
            "gender": "female",
        }
        for voice in AMERICAN_FEMALE_VOICES
    },
    **{
        voice: {
            "language_code": "a",
            "language": "English",
            "accent": "American",
            "gender": "male",
        }
        for voice in AMERICAN_MALE_VOICES
    },
    **{
        voice: {
            "language_code": "b",
            "language": "English",
            "accent": "British",
            "gender": "female",
        }
        for voice in BRITISH_FEMALE_VOICES
    },
    **{
        voice: {
            "language_code": "b",
            "language": "English",
            "accent": "British",
            "gender": "male",
        }
        for voice in BRITISH_MALE_VOICES
    },
}


# Prevent concurrent access to the shared CPU model.
INFERENCE_LOCK = threading.Lock()

# This also adds an API-key input to FastAPI's Swagger documentation.
api_key_header = APIKeyHeader(
    name="X-API-Key",
    auto_error=False,
)


class SpeechRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
    )

    text: str = Field(
        min_length=1,
        max_length=MAX_TEXT_CHARS,
        description="Text to convert to speech.",
    )

    voice: str = Field(
        default="af_heart",
        description=(
            "Kokoro voice ID. "
            "Use GET /v1/voices to list valid voices."
        ),
    )

    speed: float = Field(
        default=1.0,
        ge=0.5,
        le=2.0,
        description="Speech speed. 1.0 is normal speed.",
    )


def require_api_key(
    supplied_key: Annotated[
        str | None,
        Security(api_key_header),
    ],
) -> None:
    """
    Validate the X-API-Key header using a timing-safe comparison.
    """

    if supplied_key is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing API key",
        )

    supplied_bytes = supplied_key.encode("utf-8")
    expected_bytes = API_PASSWORD.encode("utf-8")

    if not secrets.compare_digest(
        supplied_bytes,
        expected_bytes,
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Load Kokoro exclusively from local files bundled into
    the Docker image.
    """

    torch.set_num_threads(TORCH_NUM_THREADS)

    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass

    required_files = [
        MODEL_CONFIG_PATH,
        MODEL_WEIGHTS_PATH,
    ]

    missing_files = [
        path
        for path in required_files
        if not os.path.isfile(path)
    ]

    if missing_files:
        raise RuntimeError(
            "Required Kokoro model files are missing: "
            + ", ".join(missing_files)
        )

    shared_model = (
        KModel(
            repo_id=MODEL_ID,
            config=MODEL_CONFIG_PATH,
            model=MODEL_WEIGHTS_PATH,
        )
        .to("cpu")
        .eval()
    )

    pipelines = {
        "a": KPipeline(
            lang_code="a",
            repo_id=MODEL_ID,
            model=shared_model,
            device="cpu",
        ),
        "b": KPipeline(
            lang_code="b",
            repo_id=MODEL_ID,
            model=shared_model,
            device="cpu",
        ),
    }

    # Load every supported voice from local files.
    #
    # Adding each tensor under its ordinary voice ID prevents
    # KPipeline from calling Hugging Face at request time.
    for voice_name, voice_info in VOICES.items():
        voice_path = os.path.join(
            VOICE_DIRECTORY,
            f"{voice_name}.pt",
        )

        if not os.path.isfile(voice_path):
            raise RuntimeError(
                f"Voice file is missing: {voice_path}"
            )

        voice_tensor = torch.load(
            voice_path,
            map_location="cpu",
            weights_only=True,
        )

        language_code = voice_info["language_code"]

        pipelines[language_code].voices[
            voice_name
        ] = voice_tensor

    app.state.pipelines = pipelines

    yield

    app.state.pipelines.clear()


app = FastAPI(
    title="Kokoro TTS API",
    version="1.0.0",
    description=(
        "Password-protected Kokoro-82M "
        "text-to-speech API."
    ),
    lifespan=lifespan,
)


# Allow the API to be called from any website or application.
#
# Authentication is still enforced through X-API-Key.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "Content-Disposition",
        "X-Audio-Sample-Rate",
        "X-Kokoro-Voice",
    ],
)


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "Kokoro TTS API",
        "status": "running",
        "docs": "/docs",
        "health": "/health",
        "voices": "/v1/voices",
        "speech": "/v1/audio/speech",
    }


@app.get("/health")
def health() -> dict[str, str | int]:
    """
    Lightweight public health endpoint.

    This endpoint does not run speech synthesis.
    """

    return {
        "status": "ok",
        "model": MODEL_ID,
        "sample_rate": SAMPLE_RATE,
    }


@app.get(
    "/v1/voices",
    dependencies=[Depends(require_api_key)],
)
def list_voices() -> dict[str, object]:
    return {
        "default_voice": "af_heart",
        "total": len(VOICES),
        "voices": VOICES,
    }


def stream_buffer(
    buffer: io.BytesIO,
    chunk_size: int = 64 * 1024,
) -> Iterator[bytes]:
    """
    Send the generated WAV response in HTTP chunks.
    """

    try:
        while chunk := buffer.read(chunk_size):
            yield chunk
    finally:
        buffer.close()


@app.post(
    "/v1/audio/speech",
    dependencies=[Depends(require_api_key)],
    response_class=StreamingResponse,
)
def create_speech(
    payload: SpeechRequest,
    request: Request,
) -> StreamingResponse:
    voice_info = VOICES.get(payload.voice)

    if voice_info is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "Unsupported voice. "
                "Call GET /v1/voices for valid voice IDs."
            ),
        )

    language_code = voice_info["language_code"]

    pipeline: KPipeline = (
        request.app.state.pipelines[language_code]
    )

    audio_chunks: list[np.ndarray] = []

    try:
        with INFERENCE_LOCK, torch.inference_mode():
            generator = pipeline(
                payload.text,
                voice=payload.voice,
                speed=payload.speed,
                split_pattern=r"\n+",
            )

            for result in generator:
                audio = result.audio

                if audio is None:
                    continue

                if torch.is_tensor(audio):
                    chunk = (
                        audio
                        .detach()
                        .cpu()
                        .numpy()
                    )
                else:
                    chunk = np.asarray(audio)

                chunk = np.asarray(
                    chunk,
                    dtype=np.float32,
                ).squeeze()

                if chunk.size:
                    audio_chunks.append(chunk)

    except Exception as exc:
        # Return the exception type but not sensitive internal
        # paths, stack traces or environment information.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "Speech synthesis failed "
                f"({type(exc).__name__})"
            ),
        ) from exc

    if not audio_chunks:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Kokoro generated no audio",
        )

    combined_audio = np.concatenate(audio_chunks)

    wav_buffer = io.BytesIO()

    sf.write(
        wav_buffer,
        combined_audio,
        SAMPLE_RATE,
        format="WAV",
        subtype="PCM_16",
    )

    wav_buffer.seek(0)

    return StreamingResponse(
        stream_buffer(wav_buffer),
        media_type="audio/wav",
        headers={
            "Content-Disposition": (
                'inline; filename="speech.wav"'
            ),
            "Cache-Control": "no-store",
            "X-Audio-Sample-Rate": str(SAMPLE_RATE),
            "X-Kokoro-Voice": payload.voice,
        },
    )