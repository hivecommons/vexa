"""The speak HTTP routes — ``POST /bots/{platform}/{native_meeting_id}/speak`` (text-to-speech into
the meeting) and ``DELETE /bots/{platform}/{native_meeting_id}/speak`` (stop speaking) (api.v1).

Sugar over the ``acts.v1`` ``speak`` and ``speak_stop`` acts: the route resolves the caller's meeting
the way the chat send does and publishes ``{"action":"speak","text":…,"voice"?:…}`` (or
``{"action":"speak_stop"}``) on that meeting's ``bot_commands:meeting:{id}`` channel, through the same
``CommandPublisher`` port. The bot's SpeakController unmutes, synthesizes the text through the TTS
service the bot was spawned with, plays it into its microphone and mutes again.

A bot speaks only when it was SENT to speak: ``POST /bots`` with ``voice_agent_enabled: true`` (the
row says so in ``data.voice_agent_enabled``; the bot's invocation carries ``voiceAgentEnabled``). A
bot sent without it would drop the act on the floor, so this route refuses up front instead of
answering a success that produces no audio.

Who may speak: the meeting's OWNER only (a voice in the room speaks for the bot's owner), with the
same unattended-turn and shared-turn refusals the chat send has (``regime.LIVE_BOT_VERBS``).

Refusals of the POST, in the order they are checked:

  * ``401`` — no signed caller identity.
  * ``403`` — a turn with nobody in the loop (routine, inbound mail, meeting signal).
  * ``422`` — the platform is not in the sealed ``Platform`` enum, or the body is not an object
    carrying a non-blank string ``text`` of at most ``MAX_SPEAK_CHARS`` characters. Pre-rendered
    audio (``audio_url`` / ``audio_base64``) is declared by the sealed ``SpeakRequest`` but no bot
    plays it, so a body carrying it is refused rather than half-honoured.
  * ``404`` — the caller has no live meeting row for ``(platform, native_meeting_id)``.
  * ``409`` — the bot is not in the meeting yet (booting, in the lobby, or stopping), it was not
    sent with ``voice_agent_enabled``, or no bot was listening when the act went out.
  * ``429`` — the meeting already took ``SPEAK_POSTS_PER_WINDOW`` lines in the current
    ``SPEAK_WINDOW_SEC``-second window; ``Retry-After`` says when the window turns.
  * ``503`` — the command bus (redis) is unreachable; nothing was sent.

``200`` means a listening, voice-enabled bot RECEIVED the line (``status: "queued"``).

The DELETE publishes ``speak_stop`` to every live row the caller owns for the room and answers
``200 {"status": "stop_sent", "bots": <listeners>}``; ``404`` when there is no live row.
"""
from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from ..bot_spawn.ports import MeetingRepo
from ..regime import live_bot_guard
from .chat_router import ChatRateLimit
from .stop import leave_command_channel
from .stop_router import _SUPPORTED_PLATFORMS, CommandPublisher, _active_rows, _resolve_user_id

#: The longest line this route hands a bot to say aloud. A spoken answer is a few sentences; the
#: bound keeps one call from occupying a meeting's audio for minutes.
MAX_SPEAK_CHARS = 1000

#: A meeting takes at most this many spoken lines in each ``SPEAK_WINDOW_SEC``-second window.
SPEAK_POSTS_PER_WINDOW = 5
SPEAK_WINDOW_SEC = 30

#: The speak count's own Redis prefix, so speaking never draws on the chat count (or the reverse).
SPEAK_RATE_PREFIX = "speak:rate:meeting:"

#: Pre-rendered audio fields of the sealed ``SpeakRequest`` that no bot plays today.
_AUDIO_FIELDS = ("audio_url", "audio_base64")

_IN_MEETING_STATUSES = frozenset({"active"})


def speak_payload(text: str, voice: Optional[str]) -> dict:
    """The ``acts.v1`` ``Speak`` body — exactly its declared fields (``voice`` only when given)."""
    act = {"action": "speak", "text": text}
    if voice:
        act["voice"] = voice
    return act


def speak_stop_payload() -> dict:
    """The ``acts.v1`` ``SpeakStop`` body."""
    return {"action": "speak_stop"}


def _check_platform(platform: str) -> None:
    if platform not in _SUPPORTED_PLATFORMS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"unsupported platform '{platform}' — "
                f"must be one of: {', '.join(sorted(_SUPPORTED_PLATFORMS))}"
            ),
        )


async def _speak_body(request: Request) -> tuple[str, Optional[str]]:
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=422, detail="body must be JSON: {\"text\": \"…\"}")
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="body must be a JSON object")
    if any(body.get(f) for f in _AUDIO_FIELDS):
        raise HTTPException(
            status_code=422,
            detail="pre-rendered audio (audio_url / audio_base64) is not played by the bot; send 'text'",
        )
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=422, detail="'text' must be a non-empty string")
    if len(text) > MAX_SPEAK_CHARS:
        raise HTTPException(status_code=422,
                            detail=f"'text' is longer than {MAX_SPEAK_CHARS} characters")
    voice = body.get("voice")
    if voice is not None and not isinstance(voice, str):
        raise HTTPException(status_code=422, detail="'voice' must be a string")
    # "auto" is the sealed default: the bot's TTS chooses, which is what leaving it out means.
    return text, (voice if voice and voice != "auto" else None)


def build_speak_router(repo: MeetingRepo, publisher: CommandPublisher,
                       rate_limit: Optional[ChatRateLimit] = None) -> APIRouter:
    """The speak and stop-speaking routes over the injected ``MeetingRepo`` + ``CommandPublisher``
    ports. The per-meeting limit lives in the command bus's Redis unless ``rate_limit`` is given."""
    router = APIRouter()
    limit = rate_limit or ChatRateLimit(publisher, limit=SPEAK_POSTS_PER_WINDOW,
                                        window=SPEAK_WINDOW_SEC, prefix=SPEAK_RATE_PREFIX)

    @router.post("/bots/{platform}/{native_meeting_id}/speak",
                 dependencies=[Depends(live_bot_guard("POST", "/bots/{platform}/{native_meeting_id}/speak"))])
    async def speak(
        platform: str,
        native_meeting_id: str,
        request: Request,
        x_user_id: Optional[str] = Header(default=None),
    ):
        user_id = _resolve_user_id(x_user_id)
        _check_platform(platform)
        text, voice = await _speak_body(request)

        rows = await _active_rows(repo, user_id, platform, native_meeting_id)
        if not rows:
            raise HTTPException(status_code=404, detail="No active meeting for this bot")
        meeting = next(
            (row for row in rows
             if row.get("status") in _IN_MEETING_STATUSES
             and not (row.get("data") or {}).get("stop_requested")),
            None,
        )
        if meeting is None:
            raise HTTPException(
                status_code=409,
                detail=f"the bot is not in the meeting (status '{rows[0].get('status')}') — "
                       "it can speak once it has been admitted",
            )
        if not (meeting.get("data") or {}).get("voice_agent_enabled"):
            raise HTTPException(
                status_code=409,
                detail="this bot was not sent with voice_agent_enabled, so it cannot speak — "
                       "send the bot with POST /bots {\"voice_agent_enabled\": true}",
            )

        try:
            retry_after = await limit.take(meeting["id"])
        except Exception as e:  # noqa: BLE001 — the count lives on the command bus: same failure
            raise HTTPException(
                status_code=503,
                detail="bot command bus (redis) unavailable; nothing was said — retry",
            ) from e
        if retry_after is not None:
            raise HTTPException(
                status_code=429,
                detail=f"this meeting takes at most {limit.limit} spoken lines every "
                       f"{limit.window} seconds; nothing was said — retry after {retry_after} s",
                headers={"Retry-After": str(retry_after)},
            )

        try:
            receivers = await publisher.publish(
                leave_command_channel(meeting["id"]), json.dumps(speak_payload(text, voice))
            )
        except Exception as e:  # noqa: BLE001 — Redis unreachable → narrow, retryable failure
            raise HTTPException(
                status_code=503,
                detail="bot command bus (redis) unavailable; nothing was said — retry",
            ) from e
        if isinstance(receivers, int) and receivers <= 0:
            raise HTTPException(
                status_code=409,
                detail="no bot was listening in the meeting; nothing was said — retry once the "
                       "bot is in the meeting",
            )

        _log_speak("speak_queued", user_id, meeting["id"], {"chars": len(text)})
        return {
            "status": "queued",
            "meeting_id": meeting["id"],
            "native_meeting_id": native_meeting_id,
        }

    @router.delete("/bots/{platform}/{native_meeting_id}/speak",
                   dependencies=[Depends(live_bot_guard("DELETE", "/bots/{platform}/{native_meeting_id}/speak"))])
    async def stop_speaking(
        platform: str,
        native_meeting_id: str,
        x_user_id: Optional[str] = Header(default=None),
    ):
        user_id = _resolve_user_id(x_user_id)
        _check_platform(platform)
        rows = await _active_rows(repo, user_id, platform, native_meeting_id)
        if not rows:
            raise HTTPException(status_code=404, detail="No active meeting for this bot")
        listeners = 0
        try:
            for row in rows:
                got = await publisher.publish(
                    leave_command_channel(row["id"]), json.dumps(speak_stop_payload())
                )
                if isinstance(got, int):
                    listeners += got
        except Exception as e:  # noqa: BLE001
            raise HTTPException(
                status_code=503, detail="bot command bus (redis) unavailable — retry",
            ) from e
        _log_speak("speak_stop_sent", user_id, rows[0]["id"], {"bots": listeners})
        return {"status": "stop_sent", "bots": listeners}

    return router


def _log_speak(event: str, user_id, meeting_id, fields: dict) -> None:
    # Counts only, never the text: what the bot says is the user's words.
    try:
        from ..obs import log_event

        log_event(event, audience="user", span="bots.speak",
                  user_id=user_id, meeting_id=str(meeting_id), fields=fields)
    except Exception:  # noqa: BLE001 — logging never fails a send
        pass
