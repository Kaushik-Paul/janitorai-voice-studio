from __future__ import annotations

import hashlib
import os
import re
import threading
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


SAMPLE_RATE = 24_000
DEFAULT_VOICE = "jo_clean_conversational"
DEFAULT_MAX_TEXT_CHARS = 2_000
DEFAULT_MAX_SEGMENT_CHARS = 280

NEUTTS_SOURCE_REVISION = "857bec0255f13ec726db5af76e5b97426183a724"
NEUTTS_SOURCE_ROOT = (
    "https://raw.githubusercontent.com/neuphonic/neutts/"
    f"{NEUTTS_SOURCE_REVISION}/samples"
)


@dataclass(frozen=True)
class VoiceProfile:
    id: str
    label: str
    language: str
    accent: str
    gender: str
    tone: str
    reference_text: str
    codes_url: str
    codes_sha256: str


VOICE_PROFILES: dict[str, VoiceProfile] = {
    "jo_clean_conversational": VoiceProfile(
        id="jo_clean_conversational",
        label="Jo - clean conversational",
        language="English",
        accent="English",
        gender="female",
        tone="Clean, upbeat, conversational voiceover",
        reference_text=(
            "So I just tried Neuphonic and I’m genuinely impressed. "
            "It's super responsive, it sounds clean, supports voice cloning, "
            "and the agent feature is fun to play with too. Highly recommend "
            "it for podcasts, conversations, or even just messing around "
            "with voiceovers."
        ),
        codes_url=f"{NEUTTS_SOURCE_ROOT}/jo.pt",
        codes_sha256=(
            "ced66c5add5b35d920f685370d9bb1bc3faae16e6b9f98e4b9b95c59c628fe6e"
        ),
    ),
    "dave_radio_storytelling": VoiceProfile(
        id="dave_radio_storytelling",
        label="Dave - radio storytelling",
        language="English",
        accent="British",
        gender="male",
        tone="Natural radio storytelling with conversational pauses",
        reference_text=(
            "So I'm live on radio. And I say, well, my dear friend James here "
            "clearly, and the whole room just froze. Turns out I'd completely "
            "misspoken and mentioned our other friend."
        ),
        codes_url=f"{NEUTTS_SOURCE_ROOT}/dave.pt",
        codes_sha256=(
            "6d3465d01ec65cb421ff2c1803c56ff91b9502b9303b3846989f04119523f361"
        ),
    ),
}


def public_voice_profiles() -> dict[str, dict[str, str]]:
    return {
        voice_id: {
            key: str(value)
            for key, value in asdict(profile).items()
            if key not in {"codes_url", "codes_sha256", "reference_text"}
        }
        for voice_id, profile in VOICE_PROFILES.items()
    }


def split_text(text: str, max_chars: int = DEFAULT_MAX_SEGMENT_CHARS) -> list[str]:
    """Split long input without exceeding NeuTTS Air's 2,048-token context."""

    clean_text = re.sub(r"[ \t]+", " ", text.replace("\r\n", "\n")).strip()
    if not clean_text:
        return []

    max_chars = max(80, max_chars)
    paragraphs = [part.strip() for part in re.split(r"\n+", clean_text) if part.strip()]
    segments: list[str] = []

    def add_words(value: str) -> None:
        current = ""
        for word in value.split():
            if len(word) > max_chars:
                if current:
                    segments.append(current)
                    current = ""
                segments.extend(
                    word[index : index + max_chars]
                    for index in range(0, len(word), max_chars)
                )
                continue
            candidate = word if not current else f"{current} {word}"
            if len(candidate) <= max_chars:
                current = candidate
            else:
                if current:
                    segments.append(current)
                current = word
        if current:
            segments.append(current)

    for paragraph in paragraphs:
        sentences = re.findall(
            r"[^.!?]+(?:[.!?]+[\"')\]]*|$)",
            paragraph,
        ) or [paragraph]
        current = ""

        for raw_sentence in sentences:
            sentence = raw_sentence.strip()
            if not sentence:
                continue
            if len(sentence) > max_chars:
                if current:
                    segments.append(current)
                    current = ""
                add_words(sentence)
                continue

            candidate = sentence if not current else f"{current} {sentence}"
            if len(candidate) <= max_chars:
                current = candidate
            else:
                if current:
                    segments.append(current)
                current = sentence

        if current:
            segments.append(current)

    return segments


def _download_verified(url: str, destination: Path, expected_sha256: str) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)

    if destination.is_file():
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        if digest == expected_sha256:
            return destination
        destination.unlink()

    temporary_path = destination.with_suffix(f"{destination.suffix}.part")
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "neutts-air-huggingface-space/1.0"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        temporary_path.write_bytes(response.read())

    digest = hashlib.sha256(temporary_path.read_bytes()).hexdigest()
    if digest != expected_sha256:
        temporary_path.unlink(missing_ok=True)
        raise RuntimeError(
            f"Checksum mismatch while downloading reference codes for {destination.name}"
        )

    temporary_path.replace(destination)
    return destination


class NeuTTSEngine:
    """Shared synthesis engine for the CPU and ZeroGPU Space entry points."""

    def __init__(self, runtime: str) -> None:
        if runtime not in {"cpu", "zerogpu"}:
            raise ValueError("runtime must be 'cpu' or 'zerogpu'")

        import torch
        from neutts import NeuTTS

        self.runtime = runtime
        self.torch = torch
        self.max_text_chars = int(
            os.getenv("NEUTTS_MAX_TEXT_CHARS", str(DEFAULT_MAX_TEXT_CHARS))
        )
        self.max_segment_chars = int(
            os.getenv("NEUTTS_MAX_SEGMENT_CHARS", str(DEFAULT_MAX_SEGMENT_CHARS))
        )
        self._lock = threading.Lock()

        cache_root = Path(
            os.getenv("NEUTTS_VOICE_CACHE", ".cache/neutts-air/voices")
        )
        self.reference_codes: dict[str, list[int]] = {}
        for voice_id, profile in VOICE_PROFILES.items():
            codes_path = _download_verified(
                profile.codes_url,
                cache_root / f"{voice_id}.pt",
                profile.codes_sha256,
            )
            codes = torch.load(
                codes_path,
                map_location="cpu",
                weights_only=True,
            )
            self.reference_codes[voice_id] = [int(value) for value in codes.tolist()]

        if runtime == "cpu":
            backbone_repo = os.getenv(
                "NEUTTS_BACKBONE_REPO",
                "neuphonic/neutts-air-q4-gguf",
            )
            backbone_device = "cpu"
        else:
            # GGUF/llama.cpp cannot use ZeroGPU's PyTorch CUDA emulation reliably.
            # The BF16 Transformers checkpoint is the correct ZeroGPU backend.
            backbone_repo = os.getenv(
                "NEUTTS_BACKBONE_REPO",
                "neuphonic/neutts-air",
            )
            backbone_device = "cuda"

        self.model = NeuTTS(
            backbone_repo=backbone_repo,
            backbone_device=backbone_device,
            codec_repo=os.getenv(
                "NEUTTS_CODEC_REPO",
                "neuphonic/neucodec-onnx-decoder-int8",
            ),
            codec_device="cpu",
        )

    def synthesize(
        self,
        text: str,
        voice: str = DEFAULT_VOICE,
        speed: float = 1.0,
    ) -> tuple[int, Any]:
        import librosa
        import numpy as np

        clean_text = text.strip()
        if not clean_text:
            raise ValueError("text must not be empty")
        if len(clean_text) > self.max_text_chars:
            raise ValueError(
                f"text exceeds NEUTTS_MAX_TEXT_CHARS ({self.max_text_chars})"
            )
        if voice not in VOICE_PROFILES:
            raise ValueError(f"unsupported voice profile: {voice}")
        if not 0.5 <= speed <= 2.0:
            raise ValueError("speed must be between 0.5 and 2.0")

        profile = VOICE_PROFILES[voice]
        segments = split_text(clean_text, self.max_segment_chars)
        audio_segments: list[Any] = []

        with self._lock, self.torch.inference_mode():
            for index, segment in enumerate(segments):
                audio = self.model.infer(
                    segment,
                    self.reference_codes[voice],
                    profile.reference_text,
                )
                audio_segments.append(np.asarray(audio, dtype=np.float32).reshape(-1))
                if index < len(segments) - 1:
                    audio_segments.append(
                        np.zeros(int(SAMPLE_RATE * 0.12), dtype=np.float32)
                    )

        waveform = np.concatenate(audio_segments)
        if speed != 1.0:
            waveform = librosa.effects.time_stretch(waveform, rate=speed)

        waveform = np.clip(waveform, -1.0, 1.0).astype(np.float32, copy=False)
        return SAMPLE_RATE, waveform


_ENGINES: dict[str, NeuTTSEngine] = {}
_ENGINES_LOCK = threading.Lock()


def get_engine(runtime: str) -> NeuTTSEngine:
    with _ENGINES_LOCK:
        if runtime not in _ENGINES:
            _ENGINES[runtime] = NeuTTSEngine(runtime)
        return _ENGINES[runtime]
