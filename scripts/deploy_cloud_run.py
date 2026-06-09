#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV_VARS = {
    "TORCH_NUM_THREADS": "1",
    "MAX_TEXT_CHARS": "6000",
}


def load_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}

    if not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("'\"")

    return values


def env_value(
    name: str,
    *,
    dotenv: dict[str, str],
    default: str | None = None,
) -> str | None:
    return os.getenv(name) or dotenv.get(name) or default


def command_exists(command: str) -> bool:
    return shutil.which(command) is not None


def redact_command(args: list[str]) -> list[str]:
    redacted: list[str] = []
    redact_next = False

    for arg in args:
        if redact_next:
            redacted.append(redact_env_vars(arg))
            redact_next = False
            continue

        redacted.append(arg)

        if arg == "--set-env-vars":
            redact_next = True

    return redacted


def redact_env_vars(value: str) -> str:
    parts = []

    for item in value.split(","):
        if item.startswith("API_PASSWORD="):
            parts.append("API_PASSWORD=<redacted>")
        else:
            parts.append(item)

    return ",".join(parts)


def run_command(
    args: list[str],
    *,
    dry_run: bool,
    capture_json: bool = False,
) -> Any:
    printable = " ".join(redact_command(args))
    print(f"+ {printable}")

    if dry_run:
        return [] if capture_json else None

    if capture_json:
        completed = subprocess.run(
            args,
            check=True,
            cwd=PROJECT_ROOT,
            text=True,
            stdout=subprocess.PIPE,
        )
        output = completed.stdout.strip()
        return json.loads(output) if output else []

    subprocess.run(
        args,
        check=True,
        cwd=PROJECT_ROOT,
    )
    return None


def git_short_sha() -> str | None:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            check=True,
            cwd=PROJECT_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None

    return completed.stdout.strip() or None


def default_tag() -> str:
    timestamp = dt.datetime.now(dt.UTC).strftime("%Y%m%d%H%M%S")
    short_sha = git_short_sha()

    if short_sha:
        return f"{timestamp}-{short_sha}"

    return timestamp


def image_base_uri(
    *,
    region: str,
    project_id: str,
    repository: str,
    image_name: str,
) -> str:
    return f"{region}-docker.pkg.dev/{project_id}/{repository}/{image_name}"


def build_env_vars(
    *,
    dotenv: dict[str, str],
    explicit_env_vars: str | None,
    api_password: str | None,
) -> str | None:
    if explicit_env_vars:
        return explicit_env_vars

    env_vars = dict(DEFAULT_ENV_VARS)

    if api_password:
        env_vars["API_PASSWORD"] = api_password
    else:
        password = env_value("API_PASSWORD", dotenv=dotenv)
        if password:
            env_vars["API_PASSWORD"] = password

    if "API_PASSWORD" not in env_vars:
        return None

    return ",".join(
        f"{key}={value}"
        for key, value in sorted(env_vars.items())
    )


def require_tools(
    *commands: str,
    dry_run: bool,
) -> None:
    if dry_run:
        return

    missing = [
        command
        for command in commands
        if not command_exists(command)
    ]

    if missing:
        raise SystemExit(
            "Missing required command(s): "
            + ", ".join(missing)
            + ". Install them or add them to PATH."
        )


def build_and_push_local(
    *,
    image_uri: str,
    latest_uri: str | None,
    dry_run: bool,
) -> None:
    require_tools("docker", dry_run=dry_run)

    build_args = ["docker", "build", "-t", image_uri]

    if latest_uri:
        build_args.extend(["-t", latest_uri])

    build_args.append(".")
    run_command(build_args, dry_run=dry_run)
    run_command(["docker", "push", image_uri], dry_run=dry_run)

    if latest_uri:
        run_command(["docker", "push", latest_uri], dry_run=dry_run)


def build_with_cloud_build(
    *,
    image_uri: str,
    dry_run: bool,
    machine_type: str,
) -> None:
    require_tools("gcloud", dry_run=dry_run)
    run_command(
        [
            "gcloud",
            "builds",
            "submit",
            "--tag",
            image_uri,
            "--machine-type",
            machine_type,
            ".",
        ],
        dry_run=dry_run,
    )


def deploy_cloud_run(
    *,
    service_name: str,
    image_uri: str,
    region: str,
    project_id: str,
    env_vars: str | None,
    allow_unauthenticated: bool,
    port: int,
    cpu: str,
    memory: str,
    concurrency: int,
    timeout: int,
    dry_run: bool,
) -> None:
    require_tools("gcloud", dry_run=dry_run)

    args = [
        "gcloud",
        "run",
        "deploy",
        service_name,
        "--image",
        image_uri,
        "--region",
        region,
        "--project",
        project_id,
        "--platform",
        "managed",
        "--port",
        str(port),
        "--cpu",
        cpu,
        "--memory",
        memory,
        "--concurrency",
        str(concurrency),
        "--timeout",
        str(timeout),
    ]

    if allow_unauthenticated:
        args.append("--allow-unauthenticated")
    else:
        args.append("--no-allow-unauthenticated")

    if env_vars:
        args.extend(["--set-env-vars", env_vars])

    run_command(args, dry_run=dry_run)


def image_sort_key(image: dict[str, Any]) -> str:
    return str(
        image.get("updateTime")
        or image.get("createTime")
        or ""
    )


def image_delete_ref(
    *,
    image_base: str,
    image: dict[str, Any],
) -> str | None:
    version = image.get("version")

    if isinstance(version, str) and version.startswith("sha256:"):
        return f"{image_base}@{version}"

    name = image.get("name")

    if isinstance(name, str) and "@sha256:" in name:
        return name

    return None


def prune_old_images(
    *,
    image_base: str,
    project_id: str,
    keep_images: int,
    dry_run: bool,
) -> None:
    if keep_images < 1:
        raise SystemExit("--keep-images must be at least 1")

    require_tools("gcloud", dry_run=dry_run)

    images = run_command(
        [
            "gcloud",
            "artifacts",
            "docker",
            "images",
            "list",
            image_base,
            "--project",
            project_id,
            "--include-tags",
            "--sort-by",
            "~UPDATE_TIME",
            "--format",
            "json",
        ],
        dry_run=dry_run,
        capture_json=True,
    )

    if not isinstance(images, list):
        raise SystemExit("Unexpected Artifact Registry image list response.")

    sorted_images = sorted(
        images,
        key=image_sort_key,
        reverse=True,
    )
    stale_images = sorted_images[keep_images:]

    if not stale_images:
        print(
            f"No old Artifact Registry images to delete; "
            f"found {len(sorted_images)}, keeping {keep_images}."
        )
        return

    for image in stale_images:
        delete_ref = image_delete_ref(
            image_base=image_base,
            image=image,
        )

        if not delete_ref:
            print(
                "Skipping image with unknown digest format: "
                + json.dumps(image, sort_keys=True)
            )
            continue

        run_command(
            [
                "gcloud",
                "artifacts",
                "docker",
                "images",
                "delete",
                delete_ref,
                "--project",
                project_id,
                "--delete-tags",
                "--quiet",
            ],
            dry_run=dry_run,
        )


def describe_service_url(
    *,
    service_name: str,
    region: str,
    project_id: str,
    dry_run: bool,
) -> None:
    if dry_run:
        return

    try:
        completed = subprocess.run(
            [
                "gcloud",
                "run",
                "services",
                "describe",
                service_name,
                "--region",
                region,
                "--project",
                project_id,
                "--format",
                "value(status.url)",
            ],
            check=True,
            cwd=PROJECT_ROOT,
            text=True,
            stdout=subprocess.PIPE,
        )
    except subprocess.CalledProcessError:
        return

    service_url = completed.stdout.strip()

    if service_url:
        print(f"Cloud Run service URL: {service_url}")


def parse_args() -> argparse.Namespace:
    dotenv = load_dotenv(PROJECT_ROOT / ".env")

    parser = argparse.ArgumentParser(
        description=(
            "Build and push a Docker image, deploy it to Cloud Run, "
            "and delete old Artifact Registry Docker images."
        )
    )
    parser.set_defaults(dotenv=dotenv)

    parser.add_argument(
        "--project-id",
        default=env_value("PROJECT_ID", dotenv=dotenv),
        help="Google Cloud project ID. Defaults to PROJECT_ID.",
    )
    parser.add_argument(
        "--region",
        default=env_value("REGION", dotenv=dotenv, default="us-central1"),
        help="Cloud Run and Artifact Registry region.",
    )
    parser.add_argument(
        "--repository",
        default=env_value("REPOSITORY", dotenv=dotenv, default="kokoro"),
        help="Artifact Registry Docker repository name.",
    )
    parser.add_argument(
        "--image-name",
        default=env_value("IMAGE_NAME", dotenv=dotenv, default="kokoro-cloud-run"),
        help="Artifact Registry Docker image name.",
    )
    parser.add_argument(
        "--service-name",
        default=env_value("SERVICE_NAME", dotenv=dotenv, default="kokoro-tts"),
        help="Cloud Run service name.",
    )
    parser.add_argument(
        "--tag",
        default=env_value("IMAGE_TAG", dotenv=dotenv, default=default_tag()),
        help="Docker image tag to build, push, and deploy.",
    )
    parser.add_argument(
        "--api-password",
        default=None,
        help="API_PASSWORD value for Cloud Run. Defaults to API_PASSWORD or .env.",
    )
    parser.add_argument(
        "--set-env-vars",
        default=env_value("CLOUD_RUN_ENV_VARS", dotenv=dotenv),
        help=(
            "Exact comma-separated env vars for gcloud run deploy. "
            "Overrides API_PASSWORD/TORCH_NUM_THREADS/MAX_TEXT_CHARS defaults."
        ),
    )
    parser.add_argument(
        "--keep-images",
        type=int,
        default=int(env_value("KEEP_IMAGES", dotenv=dotenv, default="1") or "1"),
        help="How many newest Artifact Registry image digests to keep.",
    )
    parser.add_argument(
        "--build-mode",
        choices=("local", "cloud-build"),
        default=env_value("BUILD_MODE", dotenv=dotenv, default="local"),
        help="Use local Docker or Google Cloud Build.",
    )
    parser.add_argument(
        "--cloud-build-machine-type",
        default=env_value(
            "CLOUD_BUILD_MACHINE_TYPE",
            dotenv=dotenv,
            default="e2-highcpu-8",
        ),
        help="Machine type for --build-mode cloud-build.",
    )
    parser.add_argument(
        "--push-latest",
        action="store_true",
        help="Also tag and push the image as latest. The unique tag is still deployed.",
    )
    parser.add_argument(
        "--no-allow-unauthenticated",
        action="store_true",
        help="Deploy Cloud Run without public unauthenticated access.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(env_value("PORT", dotenv=dotenv, default="8080") or "8080"),
    )
    parser.add_argument(
        "--cpu",
        default=env_value("CLOUD_RUN_CPU", dotenv=dotenv, default="2"),
    )
    parser.add_argument(
        "--memory",
        default=env_value("CLOUD_RUN_MEMORY", dotenv=dotenv, default="4Gi"),
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=int(
            env_value("CLOUD_RUN_CONCURRENCY", dotenv=dotenv, default="1") or "1"
        ),
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=int(env_value("CLOUD_RUN_TIMEOUT", dotenv=dotenv, default="300") or "300"),
    )
    parser.add_argument(
        "--skip-prune",
        action="store_true",
        help="Deploy but do not delete old Artifact Registry images.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print commands without running them.",
    )

    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    missing = [
        name
        for name in (
            "project_id",
            "region",
            "repository",
            "image_name",
            "service_name",
            "tag",
        )
        if not getattr(args, name)
    ]

    if missing:
        formatted = ", ".join(f"--{name.replace('_', '-')}" for name in missing)
        raise SystemExit(f"Missing required argument(s): {formatted}")

    if args.keep_images < 1:
        raise SystemExit("--keep-images must be at least 1")


def main() -> None:
    args = parse_args()
    validate_args(args)

    image_base = image_base_uri(
        region=args.region,
        project_id=args.project_id,
        repository=args.repository,
        image_name=args.image_name,
    )
    image_uri = f"{image_base}:{args.tag}"
    latest_uri = f"{image_base}:latest" if args.push_latest else None
    env_vars = build_env_vars(
        dotenv=args.dotenv,
        explicit_env_vars=args.set_env_vars,
        api_password=args.api_password,
    )

    if not env_vars:
        raise SystemExit(
            "API_PASSWORD is required for deployment. Set API_PASSWORD, "
            "add it to .env, pass --api-password, or pass --set-env-vars."
        )

    if args.build_mode == "local":
        build_and_push_local(
            image_uri=image_uri,
            latest_uri=latest_uri,
            dry_run=args.dry_run,
        )
    else:
        build_with_cloud_build(
            image_uri=image_uri,
            dry_run=args.dry_run,
            machine_type=args.cloud_build_machine_type,
        )

    deploy_cloud_run(
        service_name=args.service_name,
        image_uri=image_uri,
        region=args.region,
        project_id=args.project_id,
        env_vars=env_vars,
        allow_unauthenticated=not args.no_allow_unauthenticated,
        port=args.port,
        cpu=args.cpu,
        memory=args.memory,
        concurrency=args.concurrency,
        timeout=args.timeout,
        dry_run=args.dry_run,
    )

    if not args.skip_prune:
        prune_old_images(
            image_base=image_base,
            project_id=args.project_id,
            keep_images=args.keep_images,
            dry_run=args.dry_run,
        )

    describe_service_url(
        service_name=args.service_name,
        region=args.region,
        project_id=args.project_id,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        sys.exit(exc.returncode)
