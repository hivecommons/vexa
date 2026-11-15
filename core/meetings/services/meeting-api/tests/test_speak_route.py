"""speak — POST/DELETE /bots/{platform}/{native_meeting_id}/speak over the command bus.

Pins, against the shipped app over in-memory fakes (no redis, no bot):
  * POST publishes an ``acts.v1`` ``speak`` (exactly its declared fields) on the ACTIVE meeting's
    ``bot_commands:meeting:{id}`` channel and answers ``queued``; ``voice`` rides only when it names
    one (``auto`` is the default and is left out);
  * a bot sent without ``voice_agent_enabled`` is refused 409 BEFORE anything is published (the bot
    would drop the act and the caller would hear nothing);
  * 404 no live row · 409 not admitted / no listener · 422 bad body, too long, pre-rendered audio,
    unknown platform · 429 past the per-meeting window, with Retry-After, counted apart from chat;
  * DELETE publishes ``speak_stop`` to the room's live rows; 404 with none;
  * every refusal publishes nothing.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from meeting_api import create_app
from meeting_api.bot_spawn.fakes import InMemoryMeetingRepo
from meeting_api.lifecycle.chat_router import ChatRateLimit
from meeting_api.lifecycle.speak_router import (
    MAX_SPEAK_CHARS,
    SPEAK_POSTS_PER_WINDOW,
    SPEAK_RATE_PREFIX,
    build_speak_router,
)
from meeting_api.lifecycle.stop_router import InMemoryCommandPublisher

USER = 7
H = {"x-user-id": str(USER)}
PLAT, NATIVE = "google_meet", "abc-defg-hij"


def _contract(rel: str) -> dict:
    for parent in Path(__file__).resolve().parents:
        if (parent / rel).is_file():
            return json.loads((parent / rel).read_text())
    raise FileNotFoundError(rel)


def _validator(rel: str, defn: str) -> Draft202012Validator:
    root = _contract(rel)
    resource = Resource.from_contents(root, default_specification=DRAFT202012)
    registry = Registry().with_resource(uri=root["$id"], resource=resource)
    return Draft202012Validator({"$ref": f"{root['$id']}#/$defs/{defn}"}, registry=registry)


ACT = _validator("core/meetings/contracts/acts.v1/acts.schema.json", "Act")


class _ListeningBus(InMemoryCommandPublisher):
    """The command bus with the meeting's bot subscribed: redis answers one receiver."""

    async def publish(self, channel, message):
        await super().publish(channel, message)
        return 1


class _DeafBus(InMemoryCommandPublisher):
    """The command bus with nobody subscribed: redis answers zero receivers."""

    async def publish(self, channel, message):
        await super().publish(channel, message)
        return 0


def _app(publisher=None):
    repo, pub = InMemoryMeetingRepo(), publisher or _ListeningBus()
    return TestClient(create_app(meeting_repo=repo, command_publisher=pub)), repo, pub


def _seed(repo, *, status="active", voice=True, native=NATIVE):
    m = asyncio.run(repo.create_meeting(user_id=USER, platform=PLAT, native_meeting_id=native,
                                        data={"voice_agent_enabled": voice}))
    sid = f"sess-{m['id']}"
    asyncio.run(repo.create_session(meeting_id=m["id"], session_uid=sid))
    if status != "requested":
        asyncio.run(repo.update_meeting_status(session_uid=sid, status=status))
    return m


URL = f"/bots/{PLAT}/{NATIVE}/speak"


# ── POST /speak ──────────────────────────────────────────────────────────────────────────────────

def test_post_speak_publishes_a_speak_act_on_the_meetings_command_channel():
    client, repo, pub = _app()
    m = _seed(repo)

    r = client.post(URL, headers=H, json={"text": "Quorum is taking notes"})

    assert r.status_code == 200, r.text
    assert r.json() == {"status": "queued", "meeting_id": m["id"], "native_meeting_id": NATIVE}
    assert len(pub.published) == 1
    channel, raw = pub.published[0]
    assert channel == f"bot_commands:meeting:{m['id']}"
    act = json.loads(raw)
    assert act == {"action": "speak", "text": "Quorum is taking notes"}
    ACT.validate(act)


def test_post_speak_carries_a_named_voice_and_leaves_auto_out():
    client, repo, pub = _app()
    _seed(repo)
    assert client.post(URL, headers=H, json={"text": "one", "voice": "en_US-amy"}).status_code == 200
    assert client.post(URL, headers=H, json={"text": "two", "voice": "auto"}).status_code == 200
    acts = [json.loads(raw) for _, raw in pub.published]
    assert acts == [{"action": "speak", "text": "one", "voice": "en_US-amy"},
                    {"action": "speak", "text": "two"}]
    for act in acts:
        ACT.validate(act)


def test_post_speak_to_a_bot_sent_without_voice_is_409_and_publishes_nothing():
    """The red half of the voice gate: the same request that queues above is refused when the row
    says the bot was not sent to speak."""
    client, repo, pub = _app()
    _seed(repo, voice=False)
    r = client.post(URL, headers=H, json={"text": "hello"})
    assert r.status_code == 409, r.text
    assert "voice_agent_enabled" in r.json()["detail"]
    assert pub.published == []


def test_post_speak_without_an_active_meeting_is_404():
    client, _repo, pub = _app()
    r = client.post(URL, headers=H, json={"text": "hello"})
    assert r.status_code == 404
    assert pub.published == []


def test_post_speak_on_another_users_meeting_is_404():
    client, repo, pub = _app()
    _seed(repo)
    r = client.post(URL, headers={"x-user-id": "8"}, json={"text": "hello"})
    assert r.status_code == 404
    assert pub.published == []


@pytest.mark.parametrize("stage", ["requested", "joining", "awaiting_admission"])
def test_post_speak_before_the_bot_is_admitted_is_409(stage):
    client, repo, pub = _app()
    _seed(repo, status=stage)
    r = client.post(URL, headers=H, json={"text": "hello"})
    assert r.status_code == 409, r.text
    assert pub.published == []


def test_post_speak_with_no_listening_bot_is_409():
    client, repo, pub = _app(_DeafBus())
    _seed(repo)
    r = client.post(URL, headers=H, json={"text": "hello"})
    assert r.status_code == 409, r.text
    assert "no bot was listening" in r.json()["detail"]


@pytest.mark.parametrize("body", [{}, {"text": ""}, {"text": "   "}, {"text": 3}, {"text": "hi", "voice": 1}])
def test_post_speak_with_a_bad_body_is_422(body):
    client, repo, pub = _app()
    _seed(repo)
    r = client.post(URL, headers=H, json=body)
    assert r.status_code == 422, r.text
    assert pub.published == []


@pytest.mark.parametrize("field", ["audio_url", "audio_base64"])
def test_post_speak_with_pre_rendered_audio_is_422(field):
    client, repo, pub = _app()
    _seed(repo)
    r = client.post(URL, headers=H, json={"text": "hi", field: "x"})
    assert r.status_code == 422, r.text
    assert pub.published == []


def test_post_speak_longer_than_the_cap_is_422():
    client, repo, pub = _app()
    _seed(repo)
    r = client.post(URL, headers=H, json={"text": "a" * (MAX_SPEAK_CHARS + 1)})
    assert r.status_code == 422, r.text
    assert pub.published == []


def test_post_speak_on_an_unknown_platform_is_422():
    client, _repo, pub = _app()
    r = client.post(f"/bots/skype/{NATIVE}/speak", headers=H, json={"text": "hi"})
    assert r.status_code == 422
    assert pub.published == []


def test_post_speak_without_identity_is_401():
    client, repo, pub = _app()
    _seed(repo)
    r = client.post(URL, json={"text": "hi"})
    assert r.status_code == 401
    assert pub.published == []


def test_post_speak_past_the_window_is_429_with_retry_after():
    client, repo, pub = _app()
    _seed(repo)
    for i in range(SPEAK_POSTS_PER_WINDOW):
        assert client.post(URL, headers=H, json={"text": f"line {i}"}).status_code == 200
    r = client.post(URL, headers=H, json={"text": "one too many"})
    assert r.status_code == 429, r.text
    assert int(r.headers["Retry-After"]) >= 1
    assert len(pub.published) == SPEAK_POSTS_PER_WINDOW


def test_speak_and_chat_counts_are_kept_apart():
    """The speak limiter writes its own keys, so a busy chat never silences the bot (or the reverse)."""
    chat, speak = ChatRateLimit(), ChatRateLimit(prefix=SPEAK_RATE_PREFIX)
    assert chat.prefix != speak.prefix
    assert speak.prefix == SPEAK_RATE_PREFIX


# ── DELETE /speak ────────────────────────────────────────────────────────────────────────────────

def test_delete_speak_publishes_speak_stop_to_the_rooms_bot():
    client, repo, pub = _app()
    m = _seed(repo)
    r = client.delete(URL, headers=H)
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "stop_sent", "bots": 1}
    channel, raw = pub.published[0]
    assert channel == f"bot_commands:meeting:{m['id']}"
    act = json.loads(raw)
    assert act == {"action": "speak_stop"}
    ACT.validate(act)


def test_delete_speak_without_an_active_meeting_is_404():
    client, _repo, pub = _app()
    r = client.delete(URL, headers=H)
    assert r.status_code == 404
    assert pub.published == []


def test_router_builds_standalone_over_its_ports():
    """The router mounts on its own app over the two ports (the composition root's seam)."""
    from fastapi import FastAPI

    repo, pub = InMemoryMeetingRepo(), _ListeningBus()
    app = FastAPI()
    app.include_router(build_speak_router(repo, pub))
    _seed(repo)
    r = TestClient(app).post(URL, headers=H, json={"text": "standalone"})
    assert r.status_code == 200, r.text
