from __future__ import annotations

import math
import os
import secrets

import gradio as gr
import spaces

from core import DEFAULT_VOICE, MODEL_ID, VOICES, ZeroGpuEngine, public_voices


# ZeroGPU's CUDA emulation requires model placement at module load time.
engine = ZeroGpuEngine()
API_PASSWORD = os.getenv("API_PASSWORD", "").strip()


def estimated_gpu_duration(text: str, voice: str, speed: float) -> int:
    del voice, speed
    return max(10, min(90, math.ceil(len(text.strip()) * 0.025) + 8))


def estimated_ui_gpu_duration(
    text: str,
    voice: str,
    speed: float,
    password: str,
) -> int:
    del password
    return estimated_gpu_duration(text, voice, speed)


def require_ui_password(supplied_password: str) -> None:
    if not API_PASSWORD:
        raise gr.Error("API_PASSWORD is not configured in this Space's secrets")
    if not supplied_password or not secrets.compare_digest(
        supplied_password,
        API_PASSWORD,
    ):
        raise gr.Error("Invalid frontend password")


def validate_ui_inputs(
    text: str,
    voice: str,
    speed: float,
    supplied_password: str,
):
    del text, voice, speed
    configured = bool(API_PASSWORD)
    valid = bool(
        configured
        and supplied_password
        and secrets.compare_digest(supplied_password, API_PASSWORD)
    )
    message = (
        "Invalid frontend password"
        if configured
        else "API_PASSWORD is not configured in this Space's secrets"
    )
    return [
        gr.validate(True, ""),
        gr.validate(True, ""),
        gr.validate(True, ""),
        gr.validate(valid, "" if valid else message),
    ]


@spaces.GPU(duration=estimated_gpu_duration)
def synthesize_zerogpu(text: str, voice: str, speed: float):
    result = engine.synthesize(text, voice, speed)
    return (result.sample_rate, result.waveform)


@spaces.GPU(duration=estimated_ui_gpu_duration)
def synthesize_for_ui(text: str, voice: str, speed: float, password: str):
    require_ui_password(password)
    result = engine.synthesize(text, voice, speed)
    return (result.sample_rate, result.waveform)


def voice_metadata() -> dict[str, object]:
    voices = public_voices()
    return {
        "model": MODEL_ID,
        "default_voice": DEFAULT_VOICE,
        "total": len(voices),
        "voices": voices,
        "translation": False,
    }


voice_choices = [
    (f"{voice_id} — {voice.language} ({voice.gender})", voice_id)
    for voice_id, voice in VOICES.items()
]

with gr.Blocks(title="Kokoro-82M - ZeroGPU") as demo:
    gr.Markdown(
        "# Kokoro-82M — ZeroGPU\n"
        "Fast queued GPU synthesis. Select a voice matching the input language; "
        "Kokoro does not translate text."
    )
    text_input = gr.Textbox(
        label="Text",
        lines=6,
        value="Kokoro is a small, fast text to speech model.",
    )
    voice_input = gr.Dropdown(choices=voice_choices, value=DEFAULT_VOICE, label="Voice")
    speed_input = gr.Slider(0.5, 2.0, value=1.0, step=0.05, label="Speed")
    password_input = gr.Textbox(
        label="Password",
        type="password",
        placeholder="Enter the Space's API_PASSWORD",
    )
    generate_button = gr.Button("Generate", variant="primary")
    api_generate_button = gr.Button(visible=False)
    audio_output = gr.Audio(label="Generated speech")
    metadata_button = gr.Button("Show API voice metadata")
    metadata_output = gr.JSON(label="Voice metadata")

    generate_button.click(
        synthesize_for_ui,
        inputs=[text_input, voice_input, speed_input, password_input],
        outputs=audio_output,
        api_visibility="private",
        validator=validate_ui_inputs,
    )
    api_generate_button.click(
        synthesize_zerogpu,
        inputs=[text_input, voice_input, speed_input],
        outputs=audio_output,
        api_name="synthesize_zerogpu",
    )
    metadata_button.click(
        voice_metadata,
        outputs=metadata_output,
        api_name="voices",
    )


if __name__ == "__main__":
    demo.queue(default_concurrency_limit=1).launch()
