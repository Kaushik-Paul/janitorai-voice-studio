"""Cloud Run function that keeps selected Hugging Face Spaces active."""

from __future__ import annotations

import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone

import functions_framework


REQUEST_TIMEOUT_SECONDS = 90
USER_AGENT = "hf-space-keepalive/1.0"


@dataclass(frozen=True)
class Space:
    name: str
    url: str
    requires_auth: bool = False


SPACES = (
    Space(
        "kokoro-82m-cpu-api",
        "https://kaushikpaul-kokoro-82m-cpu-api.hf.space/health",
    ),
    Space(
        "kokoro-82m-zerogpu",
        "https://kaushikpaul-kokoro-82m-zerogpu.hf.space/config",
    ),
    Space(
        "neutts-air-cpu-api",
        "https://kaushikpaul-neutts-air-cpu-api.hf.space/health",
    ),
    Space(
        "neutts-air-zerogpu",
        "https://kaushikpaul-neutts-air-zerogpu.hf.space/config",
    ),
    Space(
        "Manga-Translator-OCR",
        "https://kaushikpaul-manga-translator-ocr.hf.space/config",
    ),
    Space(
        "Manga-Translator-OCR_Copy",
        "https://kaushikpaul-manga-translator-ocr-copy.hf.space/config",
        requires_auth=True,
    ),
)


def ping_space(space: Space, hf_token: str | None) -> dict[str, object]:
    """Send one lightweight request and return a log-safe result."""
    started = time.monotonic()
    headers = {
        "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache",
        "User-Agent": USER_AGENT,
    }

    if space.requires_auth:
        if not hf_token:
            return {
                "name": space.name,
                "ok": False,
                "error": "HF_TOKEN is not configured",
                "elapsed_ms": 0,
            }
        headers["Authorization"] = f"Bearer {hf_token}"

    request = urllib.request.Request(space.url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(
            request,
            timeout=REQUEST_TIMEOUT_SECONDS,
        ) as response:
            # Reading a small prefix confirms that the response body has started
            # without transferring an entire Gradio configuration document.
            response.read(1024)
            status = response.status
        return {
            "name": space.name,
            "ok": 200 <= status < 400,
            "status": status,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        }
    except urllib.error.HTTPError as error:
        return {
            "name": space.name,
            "ok": False,
            "status": error.code,
            "error": error.reason,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        }
    except (TimeoutError, urllib.error.URLError) as error:
        reason = getattr(error, "reason", error)
        return {
            "name": space.name,
            "ok": False,
            "error": str(reason),
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        }


@functions_framework.http
def keep_spaces_awake(_request):
    """Ping all configured Spaces concurrently."""
    hf_token = os.environ.get("HF_TOKEN")
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=len(SPACES),
    ) as executor:
        futures = [
            executor.submit(ping_space, space, hf_token) for space in SPACES
        ]
        results = [future.result() for future in futures]

    all_ok = all(result["ok"] for result in results)
    payload = {
        "ok": all_ok,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "spaces_checked": len(results),
        "results": results,
    }
    print(json.dumps(payload, separators=(",", ":"), sort_keys=True))

    status_code = 200 if all_ok else 502
    return (
        json.dumps(payload, separators=(",", ":"), sort_keys=True),
        status_code,
        {"Content-Type": "application/json"},
    )
