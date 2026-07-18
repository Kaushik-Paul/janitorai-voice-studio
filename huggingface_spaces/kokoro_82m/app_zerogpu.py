from __future__ import annotations

import math

import gradio as gr
import spaces

from core import DEFAULT_VOICE, MODEL_ID, VOICES, ZeroGpuEngine, public_voices


# ZeroGPU's CUDA emulation requires model placement at module load time.
engine = ZeroGpuEngine()


def estimated_gpu_duration(text: str, voice: str, speed: float) -> int:
    del voice, speed
    return max(10, min(90, math.ceil(len(text.strip()) * 0.025) + 8))


@spaces.GPU(duration=estimated_gpu_duration)
def synthesize_zerogpu(text: str, voice: str, speed: float):
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

