# JanitorAI Voice Studio

Add text-to-speech controls to [JanitorAI](https://janitorai.com/) with a
Tampermonkey userscript. Audio can be generated through Mimo v2.5 TTS,
OpenRouter's hosted `hexgrad/kokoro-82m` model, or a private Kokoro backend
running on Google Cloud Run.

The project has two pieces:

- `userscripts/janitor-kokoro-tts.user.js` injects a TTS panel into JanitorAI.
  It can read the latest bot message, selected text, or text pasted into its
  box, then send it to the selected provider.
- `main/app.py` optionally exposes a password-protected FastAPI service that runs
  [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) and returns generated
  speech as WAV audio. You can skip this entire backend setup when using
  Mimo or OpenRouter BYOK mode.

## What This Is For

JanitorAI does not provide this voice workflow by default. This project adds a
small browser-side control panel that turns chat text into speech through Mimo,
OpenRouter, or your own private Kokoro backend.

Use it when you want to:

- listen to JanitorAI bot replies instead of reading every message,
- generate voice from selected parts of a chat,
- paste custom text and hear it in a supported provider voice,
- keep control of the TTS API key and backend deployment when self-hosting,
- skip Cloud Run entirely when you prefer BYOK providers such as Mimo or
  OpenRouter-hosted Kokoro.

Tampermonkey is the browser extension that runs the frontend script on
JanitorAI pages. In BYOK mode, the userscript calls the selected provider
directly. In Cloud Run mode, Cloud Run hosts the backend that performs Kokoro
text-to-speech generation.

## How It Works

1. JanitorAI renders a chat message in the browser.
2. The Tampermonkey userscript finds the latest bot message, selected text, or
   text from its manual input box.
3. If BYOK mode is enabled, the userscript sends the prepared text directly to
   the selected provider:
   Mimo v2.5 TTS or OpenRouter's `hexgrad/kokoro-82m` speech endpoint.
4. If Cloud Run mode is enabled, long text is split client-side into small
   natural chunks of about 600 characters, and the userscript sends up to four
   TTS requests at a time to the Cloud Run API.
5. The selected provider generates audio.
6. The userscript decodes the returned audio, combines chunks when Cloud Run
   mode is used, then plays the final audio through a Web Audio controller with
   replay, pause/play, seek, and 10-second skip controls.

Cloud Run chunking keeps individual backend requests small enough to reduce
memory spikes while still using up to four Cloud Run instances when long text is
available. BYOK provider mode skips this chunking and skips the Cloud Run
backend entirely.

The userscript keeps JanitorAI markdown-like text such as `**bold**`,
`*italics*`, timestamps, narration, and dialogue so the TTS backend receives
the same emotional/contextual cues shown in the chat.

## Features

### JanitorAI Userscript

- Floating TTS panel on `janitorai.com`.
- Read latest bot message.
- Read currently selected text.
- Read manually pasted text.
- Manual text box fallback when selection is unreliable.
- Female voice list only.
- Speed control.
- Audio controller with replay, pause/play, seek, back 10 seconds, and forward
  10 seconds.
- Advanced `Use BYOK` toggle for provider mode or private Cloud Run mode.
- Provider switch between OpenRouter and Mimo when BYOK is enabled.
- Masked OpenRouter and Mimo API keys stored locally in the browser.
- Optional script-level OpenRouter API key override.
- Optional script-level Mimo API key override.
- Cloud Run API URL and API key stored under the collapsed Advanced section.
- OpenRouter mode sends full prepared text directly to OpenRouter and does not
  call the Cloud Run backend.
- Mimo mode sends prepared text directly to Mimo v2.5 TTS and can include the
  `STYLE_INSTRUCTION` field for expressive delivery control.
- Cloud Run mode uses client-side chunking around 600 characters, with at most
  four active TTS requests.
- BYOK provider mode applies speed through Web Audio playback rate after the
  audio is received.
- Web Audio playback, avoiding browser media URL safety blocks.
- Filters JanitorAI UI actions such as `Copy`, `Edit`, and `CopyEdit` from
  spoken text.

### Cloud Run Backend

- Runs Kokoro-82M on CPU.
- Exposes a FastAPI HTTP API.
- Requires `X-API-Key` authentication for voice listing and speech generation.
- Returns generated speech as `audio/wav` at 24 kHz.
- Supports American and British English voices.
- Supports configurable speech speed from `0.5` to `2.0`.
- Bundles the Kokoro model into the container image for Cloud Run scale-to-zero.
- Uses one Uvicorn worker and a process-local inference lock for the shared CPU
  model.

This backend is only needed for Cloud Run mode. Mimo and OpenRouter modes use
hosted provider endpoints directly from the browser userscript.

## Project Structure

```text
kokoro-cloud-run/
├── main/
│   ├── __init__.py
│   └── app.py
├── scripts/
│   ├── deploy_cloud_run.py
│   └── download_model.py
├── userscripts/
│   └── janitor-kokoro-tts.user.js
├── demo.html
├── Dockerfile
├── LICENSE
├── README.md
└── requirements.txt
```

`demo.html` is a local JanitorAI chat snapshot used while tuning message
extraction.

## Quick Start

### Option A: Use BYOK Providers

Use this path if you want hosted TTS without deploying Cloud Run.

1. Install the userscript in Tampermonkey.
2. Open JanitorAI and expand the `Advanced` section in the `Kokoro TTS` panel.
3. Enable `Use BYOK`.
4. Choose `OpenRouter` or `Mimo` in the provider switch.
5. Enter the selected provider's API key.
6. For Mimo, optionally edit `STYLE_INSTRUCTION` for delivery style.
7. Click `Read latest`, `Read selected`, or `Read box`.

When BYOK is enabled:

- The Cloud Run backend is not called.
- The Cloud Run `API URL` and `API key` fields are unused.
- OpenRouter calls `https://openrouter.ai/api/v1/audio/speech` directly with
  model `hexgrad/kokoro-82m`.
- Mimo calls `https://api.xiaomimimo.com/v1/chat/completions` directly with
  model `mimo-v2.5-tts`.
- Mimo voices in the userscript include `冰糖`, `茉莉`, `Mia`, and `Chloe`.
- The full prepared text is sent in one request instead of being split into
  Cloud Run chunks.
- The selected provider API key is stored locally in browser storage, like the
  other userscript settings.

The userscript metadata must include:

```text
@connect openrouter.ai
@connect api.xiaomimimo.com
```

### Option B: Use Your Own Cloud Run Backend

Use this path if you want a private Kokoro backend under your own Google Cloud
project.

#### 1. Deploy The Backend

Create a `.env` file or export these values:

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"
export REPOSITORY="kokoro"
export IMAGE_NAME="kokoro-cloud-run"
export SERVICE_NAME="kokoro-tts"
export API_PASSWORD="replace-with-a-long-random-secret"
```

Deploy with the helper script:

```bash
python3 scripts/deploy_cloud_run.py \
  --project-id "$PROJECT_ID" \
  --region "$REGION" \
  --repository "$REPOSITORY" \
  --image-name "$IMAGE_NAME" \
  --service-name "$SERVICE_NAME" \
  --api-password "$API_PASSWORD" \
  --build-mode cloud-build
```

The deploy script:

- enables required Google Cloud APIs,
- creates the Artifact Registry repository if needed,
- builds and pushes the Docker image,
- deploys Cloud Run,
- keeps the newest Artifact Registry image by default.

Current Cloud Run defaults are tuned for the JanitorAI userscript:

```text
CPU: 2
Memory: 5Gi
Concurrency: 1
Max instances: 4
Timeout: 300 seconds
TORCH_NUM_THREADS: 2
MAX_TEXT_CHARS: 6000
```

#### 2. Install Tampermonkey

Tampermonkey lets you run custom JavaScript on specific websites. In this
project, it runs the JanitorAI frontend script only on:

```text
https://janitorai.com/*
https://www.janitorai.com/*
```

Install Tampermonkey for your browser:

- Chrome, Brave, Edge, or other Chromium browsers: install Tampermonkey from
  the Chrome Web Store.
- Firefox: install Tampermonkey from Firefox Add-ons.

After installation, pin the Tampermonkey extension if you want quick access to
the script dashboard.

#### 3. Add The Userscript

1. Click the Tampermonkey extension icon.
2. Open `Dashboard`.
3. Click the `+` button or `Create a new script`.
4. Delete the default template Tampermonkey creates.
5. Copy the entire contents of `userscripts/janitor-kokoro-tts.user.js`.
6. Paste it into the Tampermonkey editor.
7. Save the script with `File` -> `Save`, or press `Ctrl+S`.
8. Make sure the script is enabled in the Tampermonkey dashboard.
9. Open or refresh JanitorAI.

If the script is installed correctly, a floating `Kokoro TTS` panel appears in
the bottom-right corner of JanitorAI.

#### 4. Configure The Userscript

Open the `Advanced` section in the Kokoro TTS panel and confirm:

- For BYOK mode, enable `Use BYOK`, choose `OpenRouter` or `Mimo`, and set the
  selected provider API key.
- For Cloud Run mode, disable `Use BYOK`, set `API URL` to your Cloud Run
  domain, and set `API key` to the backend `API_PASSWORD`.

Update the default `apiUrl` and `apiKey` in the userscript before copying it
into Tampermonkey, or change them from the panel's Advanced section. For
BYOK providers, you can also set `OPENROUTER_API_KEY_OVERRIDE` or
`MIMO_API_KEY_OVERRIDE` in the userscript if you prefer a script-level key
instead of filling the Advanced field.

The userscript metadata must also allow your backend domain through
Tampermonkey's `@connect` rules. Add matching `@connect` entries before saving
the script in Tampermonkey.

For example:

```text
@connect your-cloud-run-domain.run.app
@connect openrouter.ai
@connect api.xiaomimimo.com
```

#### 5. Use It In JanitorAI

- `Read latest` reads the latest rendered bot message.
- `Read selected` reads highlighted text.
- `Read box` reads text pasted into the userscript text box.
- `Stop` aborts active requests and stops playback.
- Use the controller to replay, pause/play, seek, or skip after audio is
  generated.

Typical usage:

1. Open a JanitorAI chat.
2. Wait for the bot response to finish rendering.
3. Click `Read latest`.
4. Adjust `Voice` or `Speed` if needed.
5. Use `Replay`, `Pause`, the seek bar, or the skip buttons after generation.

If `Read latest` picks the wrong message, paste the text into the text box and
click `Read box`.

## Cloud Run Backend API

This API is used only when `Use BYOK` is disabled in the userscript. Mimo and
OpenRouter modes do not call these endpoints.

Public endpoints:

- `GET /` - service metadata
- `GET /health` - lightweight health check
- `GET /docs` - FastAPI Swagger UI

Authenticated endpoints:

- `GET /v1/voices` - list supported voices
- `POST /v1/audio/speech` - generate WAV speech

All authenticated endpoints require:

```http
X-API-Key: <API_PASSWORD>
```

Example speech request:

```bash
curl -X POST "$SERVICE_URL/v1/audio/speech" \
  -H "X-API-Key: $API_PASSWORD" \
  -H "Content-Type: application/json" \
  -o speech.wav \
  -d '{
    "text": "Hello from Kokoro running on Cloud Run.",
    "voice": "af_heart",
    "speed": 1.0
  }'
```

Example voice list request:

```bash
curl "$SERVICE_URL/v1/voices" \
  -H "X-API-Key: $API_PASSWORD"
```

## Backend Configuration

Runtime environment variables:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `API_PASSWORD` | Yes | None | Shared API key expected in the `X-API-Key` header. |
| `PORT` | No | `8080` | HTTP port used by Cloud Run and Uvicorn. |
| `MAX_TEXT_CHARS` | No | `6000` | Maximum accepted input text length. |
| `MAX_SYNTHESIS_CHARS` | No | `500` | Internal synthesis segment size inside one request. |
| `TORCH_NUM_THREADS` | No | `2` | Number of PyTorch CPU threads. |
| `KOKORO_MODEL_DIR` | No | `/opt/kokoro` | Directory containing Kokoro files inside the image. |

Build-time model download uses Hugging Face through
`scripts/download_model.py`. The final runtime image sets:

```text
HF_HUB_OFFLINE=1
TRANSFORMERS_OFFLINE=1
```

## Local Backend Development

The image build downloads Kokoro model files from Hugging Face, installs the CPU
PyTorch wheel, installs the spaCy English model, and verifies the required model
files before the image is completed.

```bash
docker build -t kokoro-cloud-run:local .
```

Run the container locally:

```bash
docker run --rm \
  -p 8080:8080 \
  -e API_PASSWORD="change-me" \
  kokoro-cloud-run:local
```

Test the local service:

```bash
curl http://localhost:8080/health
```

Generate local speech:

```bash
curl -X POST http://localhost:8080/v1/audio/speech \
  -H "X-API-Key: change-me" \
  -H "Content-Type: application/json" \
  -o speech.wav \
  -d '{"text":"Kokoro is running locally.","voice":"af_heart","speed":1.0}'
```

Point the userscript Advanced API URL at `http://localhost:8080` only if your
browser and Tampermonkey setup allow that mixed local request from JanitorAI.
For normal use, use the HTTPS Cloud Run URL.

## Manual Cloud Run Deploy

The helper script is the easiest path, but the equivalent manual deploy flow is
shown below.

Authenticate Docker for Artifact Registry:

```bash
gcloud auth configure-docker "$REGION-docker.pkg.dev"
```

Enable required APIs:

```bash
gcloud services enable \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com
```

Create an Artifact Registry Docker repository:

```bash
gcloud artifacts repositories create "$REPOSITORY" \
  --repository-format=docker \
  --location="$REGION" \
  --description="Docker images for Kokoro Cloud Run"
```

Build the image locally for Artifact Registry:

```bash
export IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/$IMAGE_NAME:latest"

docker build -t "$IMAGE_URI" .
docker push "$IMAGE_URI"
```

Deploy the image to Cloud Run:

```bash
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

`--allow-unauthenticated` lets browser clients reach the FastAPI service. The
API still requires `X-API-Key` for speech generation and voice listing. If you
want Google IAM in front of the service too, remove `--allow-unauthenticated`
and call Cloud Run with an identity token.

Get the deployed service URL:

```bash
export SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --format='value(status.url)')"

echo "$SERVICE_URL"
```

Test the deployment:

```bash
curl "$SERVICE_URL/health"

curl -X POST "$SERVICE_URL/v1/audio/speech" \
  -H "X-API-Key: $API_PASSWORD" \
  -H "Content-Type: application/json" \
  -o speech.wav \
  -d '{"text":"Kokoro is running on Cloud Run.","voice":"af_heart","speed":1.0}'
```

## Cloud Build

If you prefer not to build the large image locally, submit the build directly to
Cloud Build and push it to Artifact Registry:

```bash
export IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/$IMAGE_NAME:latest"

gcloud builds submit \
  --tag "$IMAGE_URI" \
  --machine-type=e2-highcpu-8
```

Then deploy the same `IMAGE_URI` with the Cloud Run command above.

## Operational Notes

- BYOK provider mode does not use Cloud Run, `/v1/voices`, or
  `/v1/audio/speech` from this repository.
- Keep Cloud Run `concurrency=1` so each TTS request gets the full instance and
  parallel userscript requests can scale to separate instances.
- Keep `max-instances=4` for economical parallelism. The userscript sends at
  most four requests at once, so raising this limit will not help unless the
  userscript is changed too.
- Individual userscript requests are kept around 600 characters to reduce
  memory pressure.
- The backend also splits each request internally with `MAX_SYNTHESIS_CHARS`.
- Cold starts include loading the bundled Kokoro model from the container
  filesystem.
- `API_PASSWORD` should be a long random value. For production, prefer storing
  it in Secret Manager and mounting it as an environment variable.
- The generated audio is returned directly; no audio files are written to disk.

## Troubleshooting

- If OpenRouter mode fails, confirm `Use BYOK` is enabled, `OpenRouter` is
  selected, `OpenRouter API key` is filled or `OPENROUTER_API_KEY_OVERRIDE` is
  set, and the userscript metadata includes `@connect openrouter.ai`.
- If Mimo mode fails, confirm `Use BYOK` is enabled, `Mimo` is selected,
  `Mimo API key` is filled or `MIMO_API_KEY_OVERRIDE` is set, and the userscript
  metadata includes `@connect api.xiaomimimo.com`.
- If JanitorAI playback fails with a media URL safety error, make sure the
  current userscript is installed. It uses Web Audio playback instead of an
  HTML media element.
- If long messages cause Cloud Run `503` responses, check Cloud Run logs for
  out-of-memory events and confirm the userscript version uses 600-character
  chunks.
- If `Read latest` reads the wrong text, use the text box as a fallback and
  capture a fresh JanitorAI HTML snapshot for selector tuning.
- If Cloud Run voices fail to load, confirm the API URL, API key, and
  Tampermonkey `@connect` domains match your backend domain. BYOK provider mode
  uses the userscript's built-in provider voice lists.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE)
file for details.
