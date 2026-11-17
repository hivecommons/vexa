# acts.v1 — the bot command bus

Control-plane → bot, over redis pub/sub on **`bot_commands:meeting:{meeting_id}`**. One JSON message per
command, discriminated by `action`; **unknown actions are ignored** (forward-compatible).

## Commands
- **Core control** (always honored): `leave` · `reconfigure` (language/task/allowedLanguages).
- **Voice agent** (optional, gated by `voiceAgentEnabled` in the invocation): `speak` · `speak_audio` ·
  `speak_stop` · `chat_read` · `screen_show` · `screen_stop` · `avatar_set` · `avatar_reset`.
- **Chat** (ungated, a text act): `chat_send` types `text` into the meeting chat. Its optional `id`
  names the send; the bot then reports the outcome as a transcript.v1 `ChatSendResult` on its signed
  `transcription_segments` stream (`posted`, or not with the `ChatSendFailure` reason), which is how
  `GET /bots/{platform}/{native_meeting_id}/chat/{request_id}` learns whether the line posted.
- **Speak status**: `speak`'s optional `id` names the line; the bot reports it as transcript.v1
  `SpeakResult` entries (`speaking`, then `spoken` with `duration_ms` or `failed` with its
  `SpeakFailure` reason), which is how `GET /bots/{platform}/{native_meeting_id}/speak/{request_id}`
  answers. Lines play strictly one after another.

`Act` is the `oneOf` of all variants (`$defs`). No auth token (transport-layer), no tenancy fields.
Goldens (`Act.<case>.json`) validate against `#/$defs/Act` via `gate:schema`.
