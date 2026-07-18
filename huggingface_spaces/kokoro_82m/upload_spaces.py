#!/usr/bin/env python3
"""Upload the Kokoro CPU and ZeroGPU bundles to their Hugging Face Spaces."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path


SOURCE_DIR = Path(__file__).resolve().parent


@dataclass(frozen=True)
class Profile:
    name: str
    default_repo: str
    files: dict[str, str]


PROFILES = {
    "cpu": Profile(
        name="CPU",
        default_repo="kaushikpaul/kokoro-82m-cpu-api",
        files={
            "README.cpu.md": "README.md",
            "app.py": "app.py",
            "core.py": "core.py",
            "packages.txt": "packages.txt",
            "requirements.txt": "requirements.txt",
        },
    ),
    "zerogpu": Profile(
        name="ZeroGPU",
        default_repo="kaushikpaul/kokoro-82m-zerogpu",
        files={
            "README.zerogpu.md": "README.md",
            "app_zerogpu.py": "app.py",
            "core.py": "core.py",
            "packages.txt": "packages.txt",
            "requirements.zerogpu.txt": "requirements.txt",
        },
    ),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Stage the correct Kokoro files for each hardware profile and upload "
            "them with the authenticated `hf` CLI."
        )
    )
    parser.add_argument(
        "--target",
        choices=("all", "cpu", "zerogpu"),
        default="all",
        help="Space profile to upload (default: all).",
    )
    parser.add_argument(
        "--cpu-repo",
        default=PROFILES["cpu"].default_repo,
        help="Hugging Face repo ID for the CPU Space.",
    )
    parser.add_argument(
        "--zerogpu-repo",
        default=PROFILES["zerogpu"].default_repo,
        help="Hugging Face repo ID for the ZeroGPU Space.",
    )
    parser.add_argument(
        "--commit-message",
        default="Update Kokoro Space",
        help="Commit message used for each upload.",
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="Delete remote files not present in the staged deployment bundle.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and print each staged manifest without uploading.",
    )
    return parser.parse_args()


def stage_profile(profile: Profile, destination: Path) -> None:
    for source_name, destination_name in profile.files.items():
        source = SOURCE_DIR / source_name
        if not source.is_file():
            raise FileNotFoundError(f"Required source file is missing: {source}")
        target = destination / destination_name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def upload_profile(
    profile: Profile,
    repo_id: str,
    commit_message: str,
    prune: bool,
    dry_run: bool,
) -> None:
    with tempfile.TemporaryDirectory(prefix=f"kokoro-{profile.name.lower()}-") as temp:
        staging_dir = Path(temp)
        stage_profile(profile, staging_dir)
        manifest = sorted(path.name for path in staging_dir.iterdir())
        print(f"{profile.name}: {repo_id}")
        print(f"  Files: {', '.join(manifest)}")

        if dry_run:
            print("  Dry run: upload skipped")
            return

        hf_cli = shutil.which("hf")
        if hf_cli is None:
            raise RuntimeError(
                "The `hf` CLI is not installed. Install/upgrade it with "
                "`python -m pip install --upgrade huggingface_hub`."
            )

        command = [
            hf_cli,
            "upload",
            repo_id,
            str(staging_dir),
            ".",
            "--repo-type",
            "space",
            "--commit-message",
            commit_message,
        ]
        if prune:
            command.extend(["--delete", "*"])
        subprocess.run(command, check=True)


def main() -> None:
    args = parse_args()
    targets = ("cpu", "zerogpu") if args.target == "all" else (args.target,)
    repos = {"cpu": args.cpu_repo, "zerogpu": args.zerogpu_repo}
    for target in targets:
        upload_profile(
            PROFILES[target],
            repos[target],
            args.commit_message,
            args.prune,
            args.dry_run,
        )


if __name__ == "__main__":
    main()
