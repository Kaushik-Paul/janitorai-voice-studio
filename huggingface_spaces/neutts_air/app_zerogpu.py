from __future__ import annotations

import math
import os
import secrets

import gradio as gr
import spaces

from core import DEFAULT_VOICE, get_engine, public_voice_profiles


# ZeroGPU's CUDA emulation requires the PyTorch model to be placed on CUDA at
# module load time, outside the decorated function.
engine = get_engine("zerogpu")
API_PASSWORD = os.getenv("API_PASSWORD", "").strip()


def estimated_gpu_duration(text: str, voice: str, speed: float) -> int:
    del voice, speed
    return max(20, min(180, math.ceil(len(text.strip()) * 0.22)))


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
    """Queued Gradio API endpoint: /synthesize_zerogpu."""

    return engine.synthesize(text, voice, speed)


@spaces.GPU(duration=estimated_ui_gpu_duration)
def synthesize_for_ui(text: str, voice: str, speed: float, password: str):
    require_ui_password(password)
    return engine.synthesize(text, voice, speed)


def voice_metadata() -> dict[str, object]:
    voices = public_voice_profiles()
    return {
        "default_voice": DEFAULT_VOICE,
        "total": len(voices),
        "voices": voices,
        "style_control": "reference-profile",
    }


with gr.Blocks(title="NeuTTS Air - ZeroGPU") as demo:
    gr.Markdown(
        "# NeuTTS Air — ZeroGPU profile\n"
        "The BF16 PyTorch backbone uses ZeroGPU. Tone comes from the selected "
        "reference profile; free-form style instructions are not supported by "
        "NeuTTS Air."
    )
    text_input = gr.Textbox(
        label="Text",
        lines=6,
        value="This is NeuTTS Air using Hugging Face ZeroGPU.",
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
