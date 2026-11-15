- **A bot can speak in the meeting.** `POST /bots/{platform}/{native_meeting_id}/speak` with
  `{"text": "…"}` now reaches a bot sent with `"voice_agent_enabled": true` (it used to `404`), and
  `DELETE …/speak` stops it. `POST /bots` carries the flag into the bot and hands it the deployment's
  TTS service (`TTS_SERVICE_URL`, `TTS_API_TOKEN` on meeting-api), and refuses the flag with `422`
  when no TTS service is configured, so a bot never accepts speech it cannot produce. The bot no
  longer mutes its own microphone source at rest (Meet showed "Microphone problem" in place of the
  mic toggle), and the gateway keeps a downstream `429`'s `Retry-After`. See
  [Meetings API](/api/meetings).
