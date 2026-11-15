
# ---- hivecommons overlay (appended to core/meetings/services/transcription/Dockerfile.cpu) ----
# Upstream publishes no CPU transcription image for v0.12, and the upstream service defaults to
# MODEL_SIZE=large-v3-turbo + DEVICE=cuda. Pin the CPU settings from
# deploy/transcription/docker-compose.cpu.yml and bake the model into /app/models (the
# download_root the service uses) so pods start without a Hugging Face download or a PVC.
ARG MODEL_SIZE=small
ENV MODEL_SIZE=${MODEL_SIZE} \
    DEVICE=cpu \
    COMPUTE_TYPE=int8 \
    HF_HUB_DISABLE_TELEMETRY=1
RUN python -c "import os; from faster_whisper.utils import download_model; print(download_model(os.environ['MODEL_SIZE'], cache_dir='/app/models'))"
