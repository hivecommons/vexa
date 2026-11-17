- **Voice bots speak sooner and cleaner.** A spoken line is synthesized and played sentence by
  sentence, so the first sound follows the synthesis of one sentence instead of the whole line;
  sentences are cached per voice and `BOT_TTS_PREWARM` lines are split the same way and prewarmed
  for every voice in `BOT_TTS_PREWARM_VOICES`. The meeting microphone is opened once at join and
  re-checked in milliseconds before each line. The browser's own output no longer plays into the
  sink that feeds the bot's microphone, so the meeting does not hear itself while the bot speaks.
  `GET /bots/{platform}/{native_meeting_id}/speak/{request_id}` now reports `queued_at`,
  `speaking_at`, `first_audio_at`, `spoken_at`, `first_audio_ms`, `synth_ms` and `cached`. A stop
  waits up to `BOT_LEAVE_DRAIN_MS` for a last spoken line or chat send.
- **Google Meet: the confirmed transcript follows the pause by one STT round trip.** The final
  window is sent at the end of the utterance even when a draft is in flight, a single final window
  is not transcribed twice, and the reconfirmation of an utterance with drafts is sent at its end.
  The page capture keeps a quarter second before speech and half a second after it, so a clip no
  longer ends inside the last word. `BOT_STT_HOTWORDS` and `BOT_STT_PROMPT` bias every
  transcription request. See [Configuration](/configuration).
