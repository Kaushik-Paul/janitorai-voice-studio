# JanitorAI Voice Studio

Add text-to-speech controls to [JanitorAI](https://janitorai.com/) with a
Tampermonkey userscript. The default Kokoro deployment uses two Hugging Face
Spaces:

- a free CPU Space for normal use, protected by `API_PASSWORD`, and
- a ZeroGPU Space for faster generation, authenticated with the caller's
  Hugging Face token so usage and queue priority are assigned correctly.

The userscript can also call Mimo or OpenRouter in BYOK mode. Google Cloud Run
remains available as an optional replacement for the CPU Space.

## How It Works

1. The userscript reads the latest JanitorAI bot message, selected text, or text
   pasted into its box.
2. The backend is selected in the panel's `Advanced` section:
   - `Use BYOK` enabled: call Mimo or OpenRouter directly.
   - `Use BYOK` disabled and `Use Hugging Face ZeroGPU` enabled: call the
     Kokoro ZeroGPU Space through its queued Gradio API.
   - Both disabled: call the Kokoro CPU Space through its REST API.
3. The full prepared text is sent in one browser request. The userscript no
   longer splits long Kokoro text or combines multiple WAV files.
4. The selected backend performs any required sentence splitting. The CPU
   Space balances segments across its two CPU cores and returns one WAV file.
5. The userscript decodes and plays the result with replay, pause/play, seek,
   and 10-second skip controls.

Kokoro is multilingual text-to-speech, not translation. Submit text that is
already in the language associated with the selected voice.

## Features

- Read the latest bot message, selected text, or manually pasted text.
- Female Kokoro voice list and speech-speed control.
- Free CPU and ZeroGPU Kokoro backends.
- Mimo and OpenRouter BYOK providers.
- Web Audio playback with replay, pause, seek, and skip controls.
- Local browser storage for settings and masked credential fields.
- Filtering of JanitorAI actions such as `Copy`, `Edit`, and `CopyEdit` from
  spoken text.
- Kokoro model preload at Space build time and one-time process initialization;
  the model is not downloaded for every API request.

## Project Structure

```text
kokoro-cloud-run/
├── huggingface_spaces/
│   ├── kokoro_82m/
│   │   ├── app.py                    # CPU REST API and Gradio UI
│   │   ├── app_zerogpu.py            # queued ZeroGPU Gradio API and UI
│   │   ├── core.py                   # shared synthesis engines
│   │   ├── README.cpu.md             # CPU Space metadata
│   │   ├── README.zerogpu.md         # ZeroGPU Space metadata
│   │   └── upload_spaces.py          # updates both Kokoro Spaces
│   └── neutts_air/
│       ├── app.py
│       ├── app_zerogpu.py
│       ├── core.py
│       └── upload_spaces.py
├── main/
│   └── app.py                        # optional Cloud Run backend
├── cloud_run_function/
│   ├── main.py                       # daily Hugging Face keep-alive function
│   └── README.md                     # deployment details
├── scripts/
│   ├── deploy_cloud_run.py
│   └── download_model.py
├── userscripts/
│   └── janitor-kokoro-tts.user.js
├── Dockerfile
└── requirements.txt
```

The NeuTTS Air folder is an independent pair of Hugging Face Space bundles. Its
README explains its reference-recording-based tone control.

## Keep Hugging Face Spaces Awake

The private Cloud Run function `hf-space-keepalive` is deployed in
`asia-south1` in project `adept-fountain-349605`. Cloud Scheduler job
`hf-space-keepalive-daily` invokes it every day at **08:00 Asia/Kolkata** to
ping the Kokoro CPU/ZeroGPU, NeuTTS Air CPU/ZeroGPU, and two Manga Translator
Spaces without running model inference. Scheduler uses OIDC, and the token for
the private Manga copy is stored in Secret Manager.

Run an immediate check with:

```bash
gcloud scheduler jobs run hf-space-keepalive-daily \
  --project=adept-fountain-349605 \
  --location=asia-south1
```

See [`cloud_run_function/README.md`](cloud_run_function/README.md) for the
resource names, tests, and implementation details.

## Deploy Kokoro to Hugging Face Spaces

### 1. Install or upgrade the Hugging Face CLI

Use a virtual environment if possible:

```bash
python3 -m venv .venv-hf
source .venv-hf/bin/activate
python -m pip install --upgrade pip huggingface_hub
hf --version
hf auth login
```

Paste a Hugging Face access token with permission to write to your Spaces.

### 2. Create the CPU Space

On <https://huggingface.co/new-space>:

1. Create a public Space, for example `your-name/kokoro-82m-cpu-api`.
2. Select `Gradio` as the SDK.
3. Keep the free `CPU Basic` hardware. The profile uses two vCPUs.
4. In `Settings` -> `Variables and secrets`, add a secret named
   `API_PASSWORD` with a long random value.

The CPU web UI and REST API use the same password. The UI asks for it when
`Generate` is clicked; REST clients send it in `X-API-Key`.

### 3. Create the ZeroGPU Space

Create another public Gradio Space, for example
`your-name/kokoro-82m-zerogpu`, and select `ZeroGPU` hardware.

Add `API_PASSWORD` to this Space's secrets (it can be the same value as the CPU
Space). This password protects only the visible Generate form. ZeroGPU API
calls keep the existing `text`, `voice`, and `speed` parameters and use the
caller's Hugging Face token for quota and queue accounting; they do not send
`API_PASSWORD`.
Create a read token at <https://huggingface.co/settings/tokens> for use in the
userscript; a write token is not needed for inference.

### 4. Upload both profiles

The upload helper maps the CPU and ZeroGPU variants to the filenames expected
by each Space:

```bash
python3 huggingface_spaces/kokoro_82m/upload_spaces.py \
  --cpu-repo your-name/kokoro-82m-cpu-api \
  --zerogpu-repo your-name/kokoro-82m-zerogpu
```

Useful options:

```bash
# Show the exact staged files without uploading
python3 huggingface_spaces/kokoro_82m/upload_spaces.py --dry-run

# Update only one profile
python3 huggingface_spaces/kokoro_82m/upload_spaces.py --target cpu
python3 huggingface_spaces/kokoro_82m/upload_spaces.py --target zerogpu
```

The default repository IDs in the helper are this project's deployed Spaces.
Pass `--cpu-repo` and `--zerogpu-repo` for your own account. By default the
helper preserves unrelated remote files. `--prune` deletes remote files that
are not in the staged bundle, so use it only when that is intentional.

Both Space READMEs use `preload_from_hub: hexgrad/Kokoro-82M`. Hugging Face
therefore puts model files in the built Space image. The applications then
initialize the model once per process and reuse it for requests. A separate
Storage Bucket is not required for model weights.

### 5. Optional custom domains

This userscript currently uses:

```text
CPU:     https://apicpu.kokoro.pp.ua
ZeroGPU: https://apizero.kokoro.pp.ua
```

After attaching different custom domains to your Spaces, edit these constants
in `userscripts/janitor-kokoro-tts.user.js`:

```javascript
const CPU_SPACE_URL = 'https://your-cpu-domain.example';
const GPU_SPACE_URL = 'https://your-gpu-domain.example';
```

Also replace the corresponding Tampermonkey metadata entries:

```text
@connect your-cpu-domain.example
@connect your-gpu-domain.example
```

Do not put `https://` or a path in an `@connect` entry.

## Install and Configure the Userscript

1. Install Tampermonkey in a Chromium browser or Firefox.
2. Create a new userscript and replace the template with the complete contents
   of `userscripts/janitor-kokoro-tts.user.js`.
3. Save it, ensure it is enabled, and refresh a JanitorAI chat.
4. Expand `Advanced` in the `JanitorAI Voice Studio` panel.

Choose one mode:

- CPU Space: disable `Use BYOK` and `Use Hugging Face ZeroGPU`, then enter the
  CPU Space's `API_PASSWORD` in `CPU Space API key`.
- ZeroGPU Space: disable `Use BYOK`, enable `Use Hugging Face ZeroGPU`, then
  enter a Hugging Face read token in `Hugging Face token`.
- OpenRouter or Mimo: enable `Use BYOK`, select the provider, and enter its API
  key.

Only the credential used by the selected mode is shown. Credentials and the
other panel settings are stored in the userscript's browser `localStorage`.
Treat the browser profile and exported userscript data as sensitive.

The userscript metadata already permits these hosts:

```text
@connect apicpu.kokoro.pp.ua
@connect apizero.kokoro.pp.ua
@connect openrouter.ai
@connect api.xiaomimimo.com
```

## Hugging Face APIs

### CPU REST API

Public endpoints:

- `GET /api` - service metadata
- `GET /health` - lightweight health check
- `GET /docs` - FastAPI Swagger UI

Authenticated endpoints:

- `GET /v1/voices`
- `POST /v1/audio/speech`

Example:

```bash
export CPU_SPACE_URL="https://apicpu.kokoro.pp.ua"
export API_PASSWORD="your-cpu-space-password"

curl -X POST "$CPU_SPACE_URL/v1/audio/speech" \
  -H "X-API-Key: $API_PASSWORD" \
  -H "Content-Type: application/json" \
  -o speech.wav \
  -d '{
    "text": "Hello from the Kokoro CPU Space.",
    "voice": "af_heart",
    "speed": 1.0
  }'
```

Input is limited to 6,000 characters. The backend splits longer input internally
at sentence boundaries, schedules segments across two single-threaded workers,
restores their original order, and returns one 24 kHz PCM WAV file.

### ZeroGPU Gradio API

The named endpoint is `/synthesize_zerogpu`. With Python and `gradio_client`:

```python
from gradio_client import Client

client = Client(
    "your-name/kokoro-82m-zerogpu",
    token="hf_your_read_token",
)
result = client.predict(
    text="Hello from Kokoro ZeroGPU.",
    voice="af_heart",
    speed=1.0,
    api_name="/synthesize_zerogpu",
)
print(result)
```

The userscript implements the same Gradio 6.20 queue flow over the custom
domain: submit named inputs to
`POST /gradio_api/call/v2/synthesize_zerogpu`, wait at
`GET /gradio_api/call/synthesize_zerogpu/<event_id>`, and download the returned
WAV URL with the same Hugging Face bearer token.

## BYOK Providers

When `Use BYOK` is enabled:

- OpenRouter calls `https://openrouter.ai/api/v1/audio/speech` with model
  `hexgrad/kokoro-82m`.
- Mimo calls `https://api.xiaomimimo.com/v1/chat/completions` with model
  `mimo-v2.5-tts`.
- Kokoro CPU and ZeroGPU Spaces are not called.
- Speed is applied through Web Audio playback rate after provider audio is
  received.

You can set `OPENROUTER_API_KEY_OVERRIDE` or `MIMO_API_KEY_OVERRIDE` in the
userscript instead of filling the corresponding Advanced field.

## Optional Google Cloud Run Backend

Cloud Run can replace the CPU Hugging Face Space because it exposes the same
`GET /v1/voices` and `POST /v1/audio/speech` contract with `X-API-Key`.

### Deploy

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"
export REPOSITORY="kokoro"
export IMAGE_NAME="kokoro-cloud-run"
export SERVICE_NAME="kokoro-tts"
export API_PASSWORD="replace-with-a-long-random-secret"

python3 scripts/deploy_cloud_run.py \
  --project-id "$PROJECT_ID" \
  --region "$REGION" \
  --repository "$REPOSITORY" \
  --image-name "$IMAGE_NAME" \
  --service-name "$SERVICE_NAME" \
  --api-password "$API_PASSWORD" \
  --build-mode cloud-build
```

The defaults are:

```text
CPU: 2
Memory: 5Gi
Concurrency: 1
Max instances: 4
Timeout: 300 seconds
TORCH_NUM_THREADS: 2
MAX_TEXT_CHARS: 6000
```

### Point the userscript at Cloud Run

There is intentionally no editable API URL field in the panel. To use Cloud
Run, make these source changes before installing the userscript:

1. Replace `CPU_SPACE_URL` with the HTTPS Cloud Run service URL.
2. Replace `@connect apicpu.kokoro.pp.ua` with an `@connect` entry containing
   only the Cloud Run hostname.
3. Keep `Use BYOK` and `Use Hugging Face ZeroGPU` disabled.
4. Enter the Cloud Run `API_PASSWORD` in `CPU Space API key`. The label still
   says CPU Space, but the REST contract is identical.

For example:

```javascript
const CPU_SPACE_URL = 'https://kokoro-tts-xxxxxxxxxx-uc.a.run.app';
```

```text
@connect kokoro-tts-xxxxxxxxxx-uc.a.run.app
```

The updated userscript sends the full prepared text as one request. Do not
restore the old browser-side 600-character splitting; `main/app.py` already
performs bounded synthesis segmentation inside the backend.

### Manual Cloud Run build and deploy

```bash
gcloud services enable \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com

gcloud artifacts repositories create "$REPOSITORY" \
  --repository-format=docker \
  --location="$REGION" \
  --description="Docker images for Kokoro Cloud Run"

export IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/$IMAGE_NAME:latest"

gcloud builds submit \
  --tag "$IMAGE_URI" \
  --machine-type=e2-highcpu-8

gcloud run deploy "$SERVICE_NAME" \
  --image="$IMAGE_URI" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=2 \
  --memory=5Gi \
  --concurrency=1 \
  --max-instances=4 \
  --timeout=300 \
  --set-env-vars="API_PASSWORD=$API_PASSWORD,TORCH_NUM_THREADS=2,MAX_TEXT_CHARS=6000"
```

`--allow-unauthenticated` allows the browser to reach FastAPI. The protected
routes still require `X-API-Key`. Remove that flag only if your client also
supplies Google IAM identity tokens.

## Local Cloud Run Backend Development

```bash
docker build -t kokoro-cloud-run:local .

docker run --rm \
  -p 8080:8080 \
  -e API_PASSWORD="change-me" \
  kokoro-cloud-run:local

curl http://localhost:8080/health
```

The image downloads the Kokoro files while building and runs with
`HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`.

## Troubleshooting

- CPU `401`: confirm the value entered in `CPU Space API key` exactly matches
  the CPU Space's `API_PASSWORD` secret.
- CPU `503`: confirm `API_PASSWORD` exists as a Space secret, then restart the
  Space after changing it.
- ZeroGPU authentication or quota error: use a valid Hugging Face read token,
  ensure the ZeroGPU Space is public and running, and confirm the custom domain
  points to that Space.
- Voice list fails on CPU: the list is protected by the same CPU API key. Enter
  the key before trying to generate speech.
- Custom-domain request blocked: confirm both `@connect` entries contain the
  exact hostnames and then reinstall or re-authorize the userscript.
- OpenRouter or Mimo failure: confirm `Use BYOK`, the selected provider, its API
  key, and the matching `@connect` entry.
- Wrong JanitorAI text: use the manual text box as a fallback.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
