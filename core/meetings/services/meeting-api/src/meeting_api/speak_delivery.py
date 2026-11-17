"""The delivery record of one spoken line — what ``GET /bots/{platform}/{native}/speak/{request_id}``
answers.

``POST /bots/{platform}/{native}/speak`` mints a ``request_id``, records it here as ``queued`` BEFORE
it publishes the ``acts.v1`` ``speak`` (the act carries the id), and removes the record again when
nothing received the act. The bot reports the line on its signed ``transcription_segments`` stream
as ``speak_result`` entries; the collector settles the record from them (``settle``):

  * ``speaking`` — the mic was confirmed open and the line started playing;
  * ``spoken`` with ``duration_ms``: playback ended; the milliseconds of audio actually played.
    It may also say where the line's time went (``SPEAK_TIMING_FIELDS``): ``first_audio_ms`` from
    the bot taking the act to the first audio, ``synth_ms`` of that waiting on the TTS service,
    ``queue_ms`` behind earlier lines, ``mic_ms`` on the meeting mic, and ``cached``;
  * ``failed`` with the bot's ``SpeakFailure`` reason (``mic_muted``: the meeting mic could not be
    confirmed open, so nothing was played).

Transitions only move forward: ``queued → speaking``, ``queued | speaking → spoken | failed``. A
terminal record is never overwritten, and a bot cannot invent a line: a result settles only a record
of the meeting its token names. Only the sender reads it back, under the platform and native id it
was sent to (the route checks both).

A record still ``queued`` or ``speaking`` ``SPEAK_UNCONFIRMED_AFTER_SEC`` seconds after the send reads
as ``failed`` with reason ``unconfirmed``: lines play one after another, so a long queue legitimately
waits, but no answer by then means none is coming (a bot without ``speak_result`` never answers
at all).

Stored the way chat sends are (``chat_delivery.py``): in Redis when the store is a Redis client,
else in this process.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from .chat_delivery import REQUEST_ID_FORM, ChatDeliveryLedger

#: How long a line's record is kept, from the send.
SPEAK_SEND_TTL_SEC = 3600

#: A line still ``queued`` or ``speaking`` this long after the send reads as ``failed``/``unconfirmed``.
#: Above a caller's own per-line wait, so the caller sees its own timeout first.
SPEAK_UNCONFIRMED_AFTER_SEC = 120

#: The reasons a bot reports a line as not spoken (``services/bot`` ``SpeakFailure``). A failure
#: naming anything else is recorded as ``failed`` with reason ``unknown``.
SPEAK_FAILURES = frozenset({"voice_disabled", "mic_muted", "tts_failed", "stopped"})

#: What a ``spoken`` report may say about where the line's time went: whole milliseconds, measured
#: by the bot from the moment it took the act. Anything else, or a value of another type, is dropped.
SPEAK_TIMING_FIELDS = ("queue_ms", "mic_ms", "first_audio_ms", "synth_ms")

#: A timing above this (ten minutes) is not a measurement of one line and is dropped.
SPEAK_TIMING_MAX_MS = 600_000


def speak_timing(report: Any) -> dict:
    """The timing fields of a bot's ``spoken`` report that are well formed: the ``SPEAK_TIMING_FIELDS``
    as non-negative whole milliseconds, and ``cached`` as a boolean."""
    if not isinstance(report, dict):
        return {}
    timing: dict = {}
    for field in SPEAK_TIMING_FIELDS:
        value = report.get(field)
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= SPEAK_TIMING_MAX_MS:
            timing[field] = value
    if isinstance(report.get("cached"), bool):
        timing["cached"] = report["cached"]
    return timing


def _iso(epoch: Any) -> Optional[str]:
    """An epoch-seconds stamp as ISO 8601 UTC with milliseconds, or ``None``."""
    if not isinstance(epoch, (int, float)) or isinstance(epoch, bool):
        return None
    return datetime.fromtimestamp(float(epoch), tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def speak_timeline(record: dict) -> dict:
    """When a line was queued, started, first heard and finished, for the status read.

    ``queued_at`` is the send; ``speaking_at`` and ``spoken_at`` are when the bot's reports were
    applied here; ``first_audio_at`` is the send plus the bot's own ``first_audio_ms`` (the act
    reaches the bot within milliseconds of the send, so the bot's clock offset does not enter).
    The bot's timing fields are passed through as it reported them. Only what is known is present."""
    out: dict = {}
    created = record.get("created")
    for name, stamp in (("queued_at", created), ("speaking_at", record.get("started")),
                        ("spoken_at", record.get("settled") if record.get("status") == "spoken" else None)):
        iso = _iso(stamp)
        if iso:
            out[name] = iso
    timing = speak_timing(record.get("timing"))
    out.update(timing)
    if "first_audio_ms" in timing and isinstance(created, (int, float)):
        out["first_audio_at"] = _iso(float(created) + timing["first_audio_ms"] / 1000.0)
    return out


#: The statuses a bot may report, and the ones each may follow.
_ALLOWED_FROM = {
    "speaking": frozenset({"queued"}),
    "spoken": frozenset({"queued", "speaking"}),
    "failed": frozenset({"queued", "speaking"}),
}

PREFIX = "speak:send:"


def speak_send_key(request_id: str) -> str:
    return f"{PREFIX}{request_id}"


class SpeakDeliveryLedger(ChatDeliveryLedger):
    """The spoken-line records: ``record`` → ``settle`` (``speaking``, then ``spoken``/``failed``) →
    ``read``, with ``discard`` for a line that never went out. Storage is the chat ledger's."""

    def __init__(self, store: Any = None, *, ttl: int = SPEAK_SEND_TTL_SEC,
                 clock: Optional[Callable[[], float]] = None) -> None:
        super().__init__(store, ttl=ttl, clock=clock)

    async def _put(self, key: str, record: dict, *, create: bool) -> bool:
        if self._redis is not None:
            if create:
                return bool(await self._redis.set(key, json.dumps(record), ex=self.ttl, nx=True))
            # XX: never brings back a record that expired meanwhile. KEEPTTL: the send's own expiry.
            return bool(await self._redis.set(key, json.dumps(record), xx=True, keepttl=True))
        if create:
            self._local[key] = (self._clock() + self.ttl, record)
        else:
            self._local[key] = (self._local[key][0], record)
        return True

    async def record(self, request_id: str, *, user_id: int, meeting_id: int, platform: str,
                     native_meeting_id: str) -> None:
        """Record a line as ``queued``. Raises when the store is unreachable."""
        record = {"status": "queued", "user_id": int(user_id), "meeting_id": int(meeting_id),
                  "platform": platform, "native_meeting_id": native_meeting_id,
                  "created": self._clock()}
        await self._put(speak_send_key(request_id), record, create=True)

    async def discard(self, request_id: str) -> None:
        key = speak_send_key(request_id)
        if self._redis is not None:
            await self._redis.delete(key)
        else:
            self._local.pop(key, None)

    async def settle(self, request_id: str, *, meeting_id: int, status: str,  # type: ignore[override]
                     duration_ms: Optional[int] = None, reason: Optional[str] = None,
                     timing: Optional[dict] = None) -> bool:
        """Apply one bot report to a record of ``meeting_id``. Returns whether the record changed: an
        unknown, expired or terminal record, one of another meeting, a backward move, or a ``spoken``
        without a duration is left as it is. ``timing`` (a ``spoken`` report's ``SPEAK_TIMING_FIELDS``
        and ``cached``) is kept with the record when well formed."""
        if not isinstance(request_id, str) or not REQUEST_ID_FORM.fullmatch(request_id):
            return False
        allowed = _ALLOWED_FROM.get(status)
        if allowed is None:
            return False
        if status == "spoken" and not (isinstance(duration_ms, int) and not isinstance(duration_ms, bool)
                                       and duration_ms >= 0):
            return False
        key = speak_send_key(request_id)
        record = await self._get(key)
        if record is None or record.get("status") not in allowed:
            return False
        if record.get("meeting_id") != int(meeting_id):
            return False
        record["status"] = status
        if status == "spoken":
            record["duration_ms"] = int(duration_ms)  # type: ignore[arg-type]
            kept = speak_timing(timing)
            if kept:
                record["timing"] = kept
        if status == "failed":
            record["reason"] = reason if reason in SPEAK_FAILURES else "unknown"
        if status in ("spoken", "failed"):
            record["settled"] = self._clock()
        else:
            record["started"] = self._clock()
        return await self._put(key, record, create=False)

    async def read(self, request_id: str) -> Optional[dict]:
        """The record, or ``None`` when the id is unknown or expired. A ``queued`` or ``speaking``
        record older than ``SPEAK_UNCONFIRMED_AFTER_SEC`` reads as ``failed``/``unconfirmed``."""
        if not isinstance(request_id, str) or not REQUEST_ID_FORM.fullmatch(request_id):
            return None
        record = await self._get(speak_send_key(request_id))
        if record is None:
            return None
        if (record.get("status") in ("queued", "speaking")
                and self._clock() - float(record.get("created") or 0) >= SPEAK_UNCONFIRMED_AFTER_SEC):
            record["status"] = "failed"
            record["reason"] = "unconfirmed"
        return record
