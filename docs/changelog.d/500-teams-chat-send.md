- **The bot can post into a Microsoft Teams meeting chat.** `POST /bots/teams/{native_meeting_id}/chat`
  now queues the line instead of answering `422`: the bot opens the Teams chat panel when it is
  closed, types into the composer, sends, and reports `posted` only once the line shows in the
  message list (read the outcome with `GET …/chat/{request_id}`). Teams chat is not yet read back
  into the transcript. See [Meetings API](/api/meetings).
