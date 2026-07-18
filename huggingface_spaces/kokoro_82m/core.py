from __future__ import annotations

import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from time import perf_counter
from typing import Any

import numpy as np


MODEL_ID = "hexgrad/Kokoro-82M"
SAMPLE_RATE = 24_000
DEFAULT_VOICE = "af_heart"
DEFAULT_MAX_TEXT_CHARS = 6_000
DEFAULT_SEGMENT_CHARS = 420
CPU_WORKERS = max(1, min(2, int(os.getenv("KOKORO_CPU_WORKERS", "2"))))


@dataclass(frozen=True)
class Voice:
    language_code: str
    language: str
    accent: str
    gender: str


def _voices(
    ids: list[str],
    language_code: str,
    language: str,
    accent: str,
) -> dict[str, Voice]:
    return {
        voice_id: Voice(
            language_code=language_code,
            language=language,
            accent=accent,
            gender="female" if voice_id[1:2] == "f" else "male",
        )
        for voice_id in ids
    }


VOICES: dict[str, Voice] = {
    **_voices(
        [
            "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica",
            "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah",
            "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir",
            "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
        ],
        "a", "English", "American",
    ),
    **_voices(
        [
            "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel",
            "bm_fable", "bm_george", "bm_lewis",
        ],
        "b", "English", "British",
    ),
    **_voices(
        ["jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo"],
        "j", "Japanese", "Japanese",
    ),
    **_voices(
        [
            "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi",
            "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
        ],
        "z", "Mandarin Chinese", "Mandarin",
    ),
    **_voices(["ef_dora", "em_alex", "em_santa"], "e", "Spanish", "Spanish"),
    **_voices(["ff_siwis"], "f", "French", "French"),
    **_voices(["hf_alpha", "hf_beta", "hm_omega", "hm_psi"], "h", "Hindi", "Indian"),
    **_voices(["if_sara", "im_nicola"], "i", "Italian", "Italian"),
    **_voices(["pf_dora", "pm_alex", "pm_santa"], "p", "Portuguese", "Brazilian"),
}


def public_voices() -> dict[str, dict[str, str]]:
    return {
        voice_id: {
            "language_code": voice.language_code,
            "language": voice.language,
            "accent": voice.accent,
            "gender": voice.gender,
        }
        for voice_id, voice in VOICES.items()
    }


def split_text(text: str, max_chars: int = DEFAULT_SEGMENT_CHARS) -> list[str]:
    """Create short, ordered synthesis units while preserving sentence breaks."""

    clean = re.sub(r"[ \t]+", " ", text.replace("\r\n", "\n")).strip()
    if not clean:
        return []

    max_chars = max(160, max_chars)
    sentences = [
        part.strip()
        for part in re.findall(r"[^.!?\n]+(?:[.!?]+[\"')\]]*|$)", clean)
        if part.strip()
    ]
    if not sentences:
        sentences = [clean]

    segments: list[str] = []
    current = ""

    def add_words(value: str) -> None:
        nonlocal current
        for word in value.split():
            candidate = word if not current else f"{current} {word}"
            if len(candidate) <= max_chars:
                current = candidate
                continue
            if current:
                segments.append(current)
            current = word

    for sentence in sentences:
        candidate = sentence if not current else f"{current} {sentence}"
        if len(candidate) <= max_chars:
            current = candidate
        elif len(sentence) > max_chars:
            if current:
                segments.append(current)
                current = ""
            add_words(sentence)
        else:
            if current:
                segments.append(current)
            current = sentence

    if current:
        segments.append(current)
    return segments


class KokoroWorker:
    """A dedicated pipeline that can share a read-only model with other workers."""

    def __init__(self, device: str, model: Any | None = None, torch_module: Any = None) -> None:
        if torch_module is None:
            import torch as torch_module

        self.device = device
        self.torch = torch_module
        if model is None:
            from kokoro import KModel

            model = KModel(repo_id=MODEL_ID).to(device).eval()
        self.model = model
        self.pipelines: dict[str, Any] = {}

    def _pipeline(self, language_code: str):
        from kokoro import KPipeline

        pipeline = self.pipelines.get(language_code)
        if pipeline is None:
            pipeline = KPipeline(
                lang_code=language_code,
                repo_id=MODEL_ID,
                model=self.model,
                device=self.device,
            )
            self.pipelines[language_code] = pipeline
        return pipeline

    def prepare_voice(self, voice_id: str) -> None:
        """Initialize the language frontend and cache its voice tensor."""

        voice = VOICES[voice_id]
        self._pipeline(voice.language_code).load_voice(voice_id)

    def synthesize_segment(self, text: str, voice_id: str, speed: float) -> np.ndarray:
        voice = VOICES[voice_id]
        chunks: list[np.ndarray] = []
        pipeline = self._pipeline(voice.language_code)

        with self.torch.inference_mode():
            for result in pipeline(
                text,
                voice=voice_id,
                speed=speed,
                split_pattern=None,
            ):
                audio = result.audio
                if audio is None:
                    continue
                if self.torch.is_tensor(audio):
                    audio = audio.detach().cpu().numpy()
                value = np.asarray(audio, dtype=np.float32).squeeze()
                if value.size:
                    chunks.append(value)

        if not chunks:
            raise RuntimeError("Kokoro generated no audio")
        return np.concatenate(chunks)


@dataclass(frozen=True)
class SynthesisResult:
    sample_rate: int
    waveform: np.ndarray
    processing_seconds: float
    audio_seconds: float
    segments: int
    workers: int

    @property
    def real_time_factor(self) -> float:
        return self.processing_seconds / max(self.audio_seconds, 0.001)


class ParallelCpuEngine:
    def __init__(self) -> None:
        import torch
        from kokoro import KModel

        # Intra-op threads are process-global. One thread per independent model
        # lets two model calls occupy the two CPU Basic vCPUs without oversubscription.
        torch.set_num_threads(1)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass

        # KModel inference is read-only, so both dedicated pipeline workers can
        # share one set of weights. This halves model initialization and memory
        # pressure while still allowing two independent inference calls.
        self.model = KModel(repo_id=MODEL_ID).to("cpu").eval()
        self.workers = [
            KokoroWorker("cpu", model=self.model, torch_module=torch)
            for _ in range(CPU_WORKERS)
        ]
        self.executors = [
            ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"kokoro-{index}")
            for index in range(CPU_WORKERS)
        ]
        self.request_lock = threading.Lock()

        # Avoid making the first request pay for the default English frontend
        # and voice load. Other languages remain lazy and are cached after use.
        for worker in self.workers:
            worker.prepare_voice(DEFAULT_VOICE)

    def _submit_balanced(
        self,
        segments: list[str],
        voice: str,
        speed: float,
    ) -> list[np.ndarray]:
        """Assign longer segments first to the currently least-loaded worker."""

        worker_loads = [0] * len(self.workers)
        assignments: list[tuple[int, Any]] = []
        indexed_segments = sorted(
            enumerate(segments),
            key=lambda item: len(item[1]),
            reverse=True,
        )
        for segment_index, segment in indexed_segments:
            worker_index = min(
                range(len(self.workers)),
                key=worker_loads.__getitem__,
            )
            worker_loads[worker_index] += len(segment)
            future = self.executors[worker_index].submit(
                self.workers[worker_index].synthesize_segment,
                segment,
                voice,
                speed,
            )
            assignments.append((segment_index, future))

        ordered_audio: list[np.ndarray | None] = [None] * len(segments)
        for segment_index, future in assignments:
            ordered_audio[segment_index] = future.result()
        return [audio for audio in ordered_audio if audio is not None]

    def synthesize(self, text: str, voice: str, speed: float) -> SynthesisResult:
        clean = text.strip()
        if not clean:
            raise ValueError("text must not be empty")
        if len(clean) > DEFAULT_MAX_TEXT_CHARS:
            raise ValueError(
                f"text exceeds the maximum length ({DEFAULT_MAX_TEXT_CHARS} characters)"
            )
        if voice not in VOICES:
            raise ValueError("unsupported voice; call GET /v1/voices for valid IDs")

        segments = split_text(clean)
        started = perf_counter()

        # Serialize top-level requests: the two cores are used together for one
        # request, giving predictable latency instead of competing Torch jobs.
        with self.request_lock:
            ordered_audio = self._submit_balanced(segments, voice, speed)

        waveform = np.concatenate(ordered_audio)
        processing_seconds = perf_counter() - started
        return SynthesisResult(
            sample_rate=SAMPLE_RATE,
            waveform=waveform,
            processing_seconds=processing_seconds,
            audio_seconds=len(waveform) / SAMPLE_RATE,
            segments=len(segments),
            workers=min(len(segments), len(self.workers)),
        )


class ZeroGpuEngine:
    def __init__(self) -> None:
        self.worker = KokoroWorker("cuda")
        self.request_lock = threading.Lock()

    def synthesize(self, text: str, voice: str, speed: float) -> SynthesisResult:
        clean = text.strip()
        if not clean:
            raise ValueError("text must not be empty")
        if len(clean) > DEFAULT_MAX_TEXT_CHARS:
            raise ValueError(
                f"text exceeds the maximum length ({DEFAULT_MAX_TEXT_CHARS} characters)"
            )
        if voice not in VOICES:
            raise ValueError("unsupported voice")

        segments = split_text(clean)
        started = perf_counter()
        with self.request_lock:
            audio = [
                self.worker.synthesize_segment(segment, voice, speed)
                for segment in segments
            ]
        waveform = np.concatenate(audio)
        processing_seconds = perf_counter() - started
        return SynthesisResult(
            sample_rate=SAMPLE_RATE,
            waveform=waveform,
            processing_seconds=processing_seconds,
            audio_seconds=len(waveform) / SAMPLE_RATE,
            segments=len(segments),
            workers=1,
        )


_cpu_engine: ParallelCpuEngine | None = None
_cpu_engine_lock = threading.Lock()


def get_cpu_engine() -> ParallelCpuEngine:
    global _cpu_engine
    with _cpu_engine_lock:
        if _cpu_engine is None:
            _cpu_engine = ParallelCpuEngine()
    return _cpu_engine
