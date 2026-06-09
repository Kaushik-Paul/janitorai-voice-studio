# Kokoro Cloud Run TTS API

Password-protected FastAPI service for running
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) text to speech on
Google Cloud Run.

The Docker image downloads the Kokoro model, weights, and supported English
voice tensors at build time, stores them under `/opt/kokoro`, and then runs the
service with Hugging Face and Transformers offline mode enabled. Requests are
served from the files baked into the image.

## What It Does

- Runs Kokoro-82M on CPU.
- Exposes a FastAPI HTTP API.
- Requires `X-API-Key` authentication for voice listing and speech generation.
- Returns generated speech as `audio/wav` at 24 kHz.
- Supports American and British English voices.
- Supports configurable speech speed from `0.5` to `2.0`.
- Keeps model access serialized with a process-local inference lock.
- Uses one Uvicorn worker, which is the expected setup for the shared CPU model.
- Allows CORS from all origins while still enforcing API-key authentication.
- Fits Cloud Run scale-to-zero deployment because the model is bundled into the
  container image.

## API

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

## Configuration

Runtime environment variables:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `API_PASSWORD` | Yes | None | Shared API key expected in the `X-API-Key` header. |
| `PORT` | No | `8080` | HTTP port used by Cloud Run and Uvicorn. |
| `MAX_TEXT_CHARS` | No | `6000` | Maximum accepted input text length. |
| `TORCH_NUM_THREADS` | No | `2` | Number of PyTorch CPU threads. |
| `KOKORO_MODEL_DIR` | No | `/opt/kokoro` | Directory containing Kokoro files inside the image. |

Build-time model download uses Hugging Face through
`scripts/download_model.py`. The final runtime image sets:

```text
HF_HUB_OFFLINE=1
TRANSFORMERS_OFFLINE=1
```

## Project Structure

```text
kokoro-cloud-run/
├── main/
│   ├── __init__.py
│   └── app.py
├── scripts/
│   └── download_model.py
├── Dockerfile
├── LICENSE
├── README.md
└── requirements.txt
```

## Build Locally

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

## Deploy To Google Cloud

Set the deployment variables:

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"
export REPOSITORY="kokoro"
export IMAGE_NAME="kokoro-cloud-run"
export SERVICE_NAME="kokoro-tts"
export API_PASSWORD="replace-with-a-long-random-secret"
```

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
```

Push the image to Artifact Registry:

```bash
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
  --memory=4Gi \
  --concurrency=1 \
  --max-instances=1 \
  --timeout=300 \
  --set-env-vars="API_PASSWORD=$API_PASSWORD,TORCH_NUM_THREADS=2,MAX_TEXT_CHARS=6000"
```

`--allow-unauthenticated` lets HTTP clients reach the FastAPI service. The API
still requires `X-API-Key` for speech generation and voice listing. If you want
Google IAM in front of the service too, remove `--allow-unauthenticated` and
call Cloud Run with an identity token.

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

## Build In Google Cloud Build

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

- The service is CPU-only. Start with `--cpu=2` and `--memory=4Gi`, then tune
  after measuring cold starts and synthesis latency.
- `--concurrency=1` and `--max-instances=1` are the lowest-cost stable defaults
  because the app uses a shared model and serializes inference.
- Cold starts include loading the bundled Kokoro model from the container
  filesystem.
- `API_PASSWORD` should be a long random value. For production, prefer storing
  it in Secret Manager and mounting it as an environment variable.
- The generated audio is returned directly; no audio files are written to disk.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE)
file for details.
