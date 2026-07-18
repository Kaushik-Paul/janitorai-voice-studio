from __future__ import annotations

import math

import gradio as gr
import spaces

from core import DEFAULT_VOICE, get_engine, public_voice_profiles


# ZeroGPU's CUDA emulation requires the PyTorch model to be placed on CUDA at
# module load time, outside the decorated function.
engine = get_engine("zerogpu")


def estimated_gpu_duration(text: str, voice: str, speed: float) -> int:
    del voice, speed
    return max(20, min(180, math.ceil(len(text.strip()) * 0.22)))


@spaces.GPU(duration=estimated_gpu_duration)
def synthesize_zerogpu(text: str, voice: str, speed: float):
    """Queued Gradio API endpoint: /synthesize_zerogpu."""

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
    generate_button = gr.Button("Generate", variant="primary")
    audio_output = gr.Audio(label="Generated speech")
    metadata_button = gr.Button("Show API voice metadata")
    metadata_output = gr.JSON(label="Voice metadata")

    generate_button.click(
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
