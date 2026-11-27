# transcription — the STT worker (faster-whisper, OpenAI-compatible)

The speech-to-text brick. A standalone FastAPI worker wrapping **faster-whisper / CTranslate2**
behind the OpenAI audio API (`POST /v1/audio/transcriptions`). The bot's whisper client
([`core/meetings/modules/whisper`](../../modules/whisper)) streams audio windows here and gets
segments back; meeting-api's `collector` ingests those segments into `transcription_segments`
and fans them out. Any OpenAI-audio-compatible client works — it is not tied to Vexa.

## Why it is its own brick, deployed separately

GPU inference is expensive, stateful, and hardware-specific. Bundling it into the main
`make all` compose stack would force every self-host onto an NVIDIA GPU. So the GPU workload is
**carved out**: this brick ships its own deploy unit ([`deploy/transcription`](../../../../deploy/transcription))
that you stand up separately (GPU or CPU), and the main stack reaches it over the network via
`TRANSCRIPTION_SERVICE_URL` (base URL; the client appends `/v1/audio/transcriptions`).

It imports only third-party libraries and its own module — no cross-brick edges (gate:isolation-py).

## Surface

| Route | Purpose |
|---|---|
| `POST /v1/audio/transcriptions` | OpenAI Whisper-compatible transcription (multipart audio → verbose_json segments) |
| `GET /health` | `200` once the model is loaded and the startup warm-up inference has run (see `WARMUP`), `503` before that; the LB / compose healthcheck seam |
| `GET /` | service info (worker id · model · device) |

## Run

```bash
python -m transcription          # uvicorn worker on :8000 (loads MODEL_SIZE at startup)
uv run pytest -q                 # the autonomous contract suite (no GPU, no model download)
```

Container builds: `Dockerfile` (GPU, `nvidia/cuda` base) and `Dockerfile.cpu` (CPU-only).
Config (env): `MODEL_SIZE`, `DEVICE` (`cuda`/`cpu`), `COMPUTE_TYPE`, `CPU_THREADS` and
`API_TOKEN` are set in the deploy unit's `.env.example`. The worker also reads the knobs below
(defaults from `src/transcription/main.py`). The deploy unit's compose files do not forward them
(only `VAD_MIN_SILENCE_DURATION_MS` on GPU), so to change one there, add it to the worker's
`environment:` list.

| Variable | Default | Effect |
|---|---|---|
| `BEAM_SIZE` / `BEST_OF` | `5` / `5` | faster-whisper decoding breadth |
| `COMPRESSION_RATIO_THRESHOLD` | `1.8` | segments above it are treated as hallucination |
| `LOG_PROB_THRESHOLD` | `-1.0` | segments below it are treated as low-confidence |
| `NO_SPEECH_THRESHOLD` | `0.6` | no-speech probability above which a segment counts as silence |
| `CONDITION_ON_PREVIOUS_TEXT` | `false` | faster-whisper `condition_on_previous_text` |
| `PROMPT_RESET_ON_TEMPERATURE` | `0.3` | faster-whisper `prompt_reset_on_temperature` |
| `REPETITION_PENALTY` / `NO_REPEAT_NGRAM_SIZE` | `1.1` / `3` | repetition suppression |
| `USE_TEMPERATURE_FALLBACK` | `false` | retry at rising temperatures when a result is rejected |
| `VAD_FILTER` | `true` | faster-whisper VAD before decoding |
| `VAD_FILTER_THRESHOLD` | `0.5` | VAD speech threshold |
| `VAD_MIN_SILENCE_DURATION_MS` | `160` (GPU compose sets `80`) | silence that splits speech |
| `VAD_MAX_SPEECH_DURATION_S` | `15.0` | longest segment before a forced split |
| `MAX_ACTIVE_REQUESTS` | `20` on `cuda`, `2` otherwise | concurrent transcriptions (`MAX_CONCURRENT_TRANSCRIPTIONS` is the older name) |
| `MAX_QUEUE_SIZE` | `10` | requests allowed to wait when not failing fast |
| `FAIL_FAST_WHEN_BUSY` | `true` | return `503` at once when busy instead of queueing |
| `BUSY_RETRY_AFTER_S` | `1` | `Retry-After` on a busy `503` |
| `REALTIME_RESERVED_SLOTS` | `1` | concurrency slots `deferred`-tier requests may not use |
| `TRANSCRIPTION_TIMEOUT_S` | `120.0` | bound on one request's work, all fallback attempts included |
| `WARMUP` | `true` | run one short inference before `/health` turns healthy; `false` skips it |
| `WORKER_ID` | `1` | label in logs and `/` / `/health` |
| `VEXA_ENV` | `development` | `production` hides `/docs`, `/redoc` and `/openapi.json` |
