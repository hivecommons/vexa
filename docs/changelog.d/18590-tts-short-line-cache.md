- **Voice bots: short lines play at once.** A voice bot keeps the audio of every spoken line up to
  120 characters per voice, and synthesizes the lines in `BOT_TTS_PREWARM` (`|`-separated, e.g. an
  agent's stock acknowledgements) ahead of time, so an acknowledgement no longer waits seconds for a
  CPU TTS. See [Configuration](/configuration).
