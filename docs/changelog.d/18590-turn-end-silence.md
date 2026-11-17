- **Google Meet: a speaker's turn ends about a second after they stop, also when they mute or the
  room is noisy.** The low-latency lane closes an utterance when no audio arrives (captures drop
  silent chunks, so a muted or silent speaker sends nothing), judges quiet against the speaker's own
  noise floor instead of a fixed level, no longer waits for requests in flight before its idle
  timeout applies, uses an in-flight answer that already covers the whole utterance as its final,
  and reconfirms a speaker's drafts after one second of silence instead of on the draft clock.
