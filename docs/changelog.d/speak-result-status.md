- **A spoken line now says whether it was heard, and how long it played.** `POST
  /bots/{platform}/{native_meeting_id}/speak` answers a `request_id`, and `GET
  /bots/{platform}/{native_meeting_id}/speak/{request_id}` reads what the bot reports: `speaking` once
  the meeting mic is confirmed open, `spoken` with `duration_ms`, or `failed` with the reason (for
  example `mic_muted`, when the mic could not be confirmed open and nothing was played). A bot plays
  its lines one after another, so a caller can pace lines on `spoken`. See [Meetings](/api/meetings).
