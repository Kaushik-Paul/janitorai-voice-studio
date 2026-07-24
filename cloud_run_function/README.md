# Hugging Face Space keep-alive

This HTTP Cloud Run function sends a lightweight request to six Hugging Face
Spaces. It uses each CPU API's `/health` route and Gradio's `/config` route for
the remaining apps, so the daily check does not run model inference or consume
ZeroGPU quota.

The deployed service is private. Cloud Scheduler invokes it with OIDC at
`08:00 Asia/Kolkata` each day. The Hugging Face token used for the private
`Manga-Translator-OCR_Copy` Space is injected from Secret Manager.

## Local tests

```sh
cd cloud_run_function
python3 -m unittest -v
```

## Deployment configuration

- GCP project: `adept-fountain-349605`
- Region: `asia-south1`
- Cloud Run service: `hf-space-keepalive`
- Scheduler job: `hf-space-keepalive-daily`
- Schedule: `0 8 * * *`
- Time zone: `Asia/Kolkata`
- Runtime service account: `hf-space-keepalive-runtime`
- Scheduler service account: `hf-space-keepalive-scheduler`
- Secret: `hf-space-keepalive-token`

The function returns HTTP 200 only when every Space responds successfully.
Transient failures return HTTP 502, allowing Cloud Scheduler to retry.
