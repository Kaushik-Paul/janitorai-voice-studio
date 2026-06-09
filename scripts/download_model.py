from huggingface_hub import snapshot_download


def main() -> None:
    downloaded_path = snapshot_download(
        repo_id="hexgrad/Kokoro-82M",
        local_dir="/opt/kokoro",
        allow_patterns=[
            "config.json",
            "kokoro-v1_0.pth",
            "voices/af_*.pt",
            "voices/am_*.pt",
            "voices/bf_*.pt",
            "voices/bm_*.pt",
        ],
    )

    print(f"Kokoro files downloaded to: {downloaded_path}")


if __name__ == "__main__":
    main()