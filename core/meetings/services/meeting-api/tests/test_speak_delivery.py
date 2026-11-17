"""Whether a spoken line was heard — ``POST …/speak`` answers a ``request_id`` and
``GET …/speak/{request_id}`` reads what the bot reported.

  * POST records the line as ``queued`` before the act goes out, puts the same id on the acts.v1
    ``speak``, and answers it; a line nothing received leaves no record.
  * The bot's ``speak_result`` entries (transcript.v1 ``SpeakResult``, signed on the
    ``transcription_segments`` stream) move it forward: ``speaking``, then ``spoken`` with
    ``duration_ms`` or ``failed`` with the bot's reason (one outside ``SpeakFailure`` is ``unknown``).
  * A report changes nothing for an unknown id, a line of another meeting, a backward move, a terminal
    line, or a ``spoken`` without a duration.
  * GET answers the sender only, under the platform and native id the line was sent to. A line still
    ``queued``/``speaking`` ``SPEAK_UNCONFIRMED_AFTER_SEC`` after the send reads ``failed``/``unconfirmed``.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import fakeredis.aioredis
import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from meeting_api import create_app
from meeting_api.bot_spawn.fakes import InMemoryMeetingRepo
from meeting_api.collector import consume_segments
from meeting_api.collector.fakes import FakeRedisBus, InMemoryTranscriptStore
from meeting_api.speak_delivery import (
    SPEAK_SEND_TTL_SEC, SPEAK_UNCONFIRMED_AFTER_SEC, SpeakDeliveryLedger, speak_send_key,
)

from _segment_auth import admin_token, signed_xadd, token_for  # noqa: F401

USER = 7
H = {"x-user-id": str(USER)}
PLAT, NATIVE = "google_meet", "abc-defg-hij"


def _contract(rel: str) -> dict:
    for parent in Path(__file__).resolve().parents:
        if (parent / rel).is_file():
            return json.loads((parent / rel).read_text())
    raise FileNotFoundError(rel)


def _validator(rel: str, ref: str) -> Draft202012Validator:
    root = _contract(rel)
    uri = root.get("$id") or "urn:api.v1"
    resource = Resource.from_contents(root, default_specification=DRAFT202012)
    return Draft202012Validator({"$ref": f"{uri}#{ref}"},
                                registry=Registry().with_resource(uri=uri, resource=resource))


ACT = _validator("core/meetings/contracts/acts.v1/acts.schema.json", "/$defs/Act")
RESULT = _validator("core/meetings/contracts/transcript.v1/transcript.schema.json", "/$defs/SpeakResult")
STATUS = _validator("core/gateway/contracts/api.v1/api.schema.json", "/components/schemas/SpeakStatus")


class _ListeningRedis:
    """The command bus as meeting-api holds it, with the meeting's bot subscribed."""

    def __init__(self, client, receivers: int = 1) -> None:
        self._client = client
        self.receivers = receivers
        self.published: list[tuple[str, str]] = []

    def __getattr__(self, name):
        return getattr(self._client, name)

    async def publish(self, channel, message):
        self.published.append((channel, message))
        return self.receivers


def _seed(repo, *, user=USER, native=NATIVE):
    m = asyncio.run(repo.create_meeting(user_id=user, platform=PLAT, native_meeting_id=native,
                                        data={"voice_agent_enabled": True}))
    sid = f"sess-{m['id']}"
    asyncio.run(repo.create_session(meeting_id=m["id"], session_uid=sid))
    asyncio.run(repo.update_meeting_status(session_uid=sid, status="active"))
    return m


@pytest.fixture
def redis():
    return fakeredis.aioredis.FakeRedis(decode_responses=True)


@pytest.fixture
def rig(redis):
    repo, pub = InMemoryMeetingRepo(), _ListeningRedis(redis)
    client = TestClient(create_app(meeting_repo=repo, command_publisher=pub))
    return client, repo, pub


def _url(native=NATIVE, platform=PLAT):
    return f"/bots/{platform}/{native}/speak"


def _say(client, text="one moment", headers=H, native=NATIVE):
    r = client.post(_url(native), headers=headers, json={"text": text})
    assert r.status_code == 200, r.text
    return r.json()


def _status(client, request_id, headers=H, native=NATIVE, platform=PLAT):
    return client.get(f"{_url(native, platform)}/{request_id}", headers=headers)


def _report(meeting_id, request_id, status, **extra) -> dict:
    return {"type": "speak_result", "meeting_id": meeting_id, "id": request_id, "status": status, **extra}


def _bot_reports(redis, data: dict, *, token=None) -> None:
    async def run():
        bus = FakeRedisBus(redis)
        await signed_xadd(bus, data, token=token)
        await consume_segments(InMemoryTranscriptStore(), bus)
    asyncio.run(run())


def test_post_answers_a_request_id_and_puts_it_on_the_act(rig):
    client, repo, pub = rig
    m = _seed(repo)
    body = _say(client)
    assert body["status"] == "queued" and body["meeting_id"] == m["id"] and body["native_meeting_id"] == NATIVE
    act = json.loads(pub.published[-1][1])
    ACT.validate(act)
    assert act == {"action": "speak", "text": "one moment", "id": body["request_id"]}


def test_a_fresh_line_reads_queued(rig):
    client, repo, _ = rig
    _seed(repo)
    rid = _say(client)["request_id"]
    r = _status(client, rid)
    assert r.status_code == 200, r.text
    STATUS.validate(r.json())
    assert r.json()["status"] == "queued"


def test_a_line_nothing_received_leaves_no_record(redis):
    repo, pub = InMemoryMeetingRepo(), _ListeningRedis(redis, receivers=0)
    client = TestClient(create_app(meeting_repo=repo, command_publisher=pub))
    _seed(repo)
    assert client.post(_url(), headers=H, json={"text": "nobody"}).status_code == 409
    rid = json.loads(pub.published[-1][1])["id"]
    assert asyncio.run(redis.get(speak_send_key(rid))) is None


def test_speaking_then_spoken_reads_the_duration(rig, redis, admin_token):
    client, repo, _ = rig
    m = _seed(repo)
    rid = _say(client)["request_id"]
    speaking = _report(m["id"], rid, "speaking")
    RESULT.validate(speaking)
    _bot_reports(redis, speaking, token=token_for(m["id"]))
    assert _status(client, rid).json()["status"] == "speaking"
    spoken = _report(m["id"], rid, "spoken", duration_ms=2340)
    RESULT.validate(spoken)
    _bot_reports(redis, spoken, token=token_for(m["id"]))
    body = _status(client, rid).json()
    STATUS.validate(body)
    assert body["status"] == "spoken" and body["duration_ms"] == 2340 and "reason" not in body


def test_mic_muted_reads_failed_with_the_reason(rig, redis, admin_token):
    client, repo, _ = rig
    m = _seed(repo)
    rid = _say(client)["request_id"]
    _bot_reports(redis, _report(m["id"], rid, "failed", reason="mic_muted"), token=token_for(m["id"]))
    body = _status(client, rid).json()
    STATUS.validate(body)
    assert body["status"] == "failed" and body["reason"] == "mic_muted"


def test_a_terminal_line_is_never_overwritten_or_moved_back(rig, redis, admin_token):
    client, repo, _ = rig
    m = _seed(repo)
    rid = _say(client)["request_id"]
    tok = token_for(m["id"])
    _bot_reports(redis, _report(m["id"], rid, "spoken", duration_ms=900), token=tok)
    _bot_reports(redis, _report(m["id"], rid, "speaking"), token=tok)
    _bot_reports(redis, _report(m["id"], rid, "failed", reason="tts_failed"), token=tok)
    body = _status(client, rid).json()
    assert body["status"] == "spoken" and body["duration_ms"] == 900


def test_a_report_for_another_meeting_changes_nothing(rig, redis, admin_token):
    client, repo, _ = rig
    _seed(repo)
    other = _seed(repo, native="xyz-wxyz-abc")
    rid = _say(client)["request_id"]
    _bot_reports(redis, _report(other["id"], rid, "spoken", duration_ms=5), token=token_for(other["id"]))
    assert _status(client, rid).json()["status"] == "queued"


def test_spoken_without_a_duration_and_unknown_reasons_are_refused_or_normalised():
    async def run():
        ledger = SpeakDeliveryLedger(fakeredis.aioredis.FakeRedis(decode_responses=True))
        await ledger.record("abc", user_id=USER, meeting_id=1, platform=PLAT, native_meeting_id=NATIVE)
        assert not await ledger.settle("abc", meeting_id=1, status="spoken")
        assert not await ledger.settle("abc", meeting_id=1, status="queued")
        assert await ledger.settle("abc", meeting_id=1, status="failed", reason="cosmic_rays")
        return await ledger.read("abc")
    record = asyncio.run(run())
    assert record["status"] == "failed" and record["reason"] == "unknown"


def test_only_the_sender_under_the_same_meeting_reads_it(rig):
    client, repo, _ = rig
    _seed(repo)
    rid = _say(client)["request_id"]
    assert _status(client, rid, headers={"x-user-id": "8"}).status_code == 404
    assert _status(client, rid, native="xyz-wxyz-abc").status_code == 404
    assert _status(client, rid, platform="zoom").status_code == 404
    assert _status(client, "0" * 32).status_code == 404


def test_a_line_with_no_answer_reads_unconfirmed():
    now = [1_000.0]

    async def run():
        ledger = SpeakDeliveryLedger(clock=lambda: now[0])
        await ledger.record("abc", user_id=USER, meeting_id=1, platform=PLAT, native_meeting_id=NATIVE)
        assert await ledger.settle("abc", meeting_id=1, status="speaking")
        now[0] += SPEAK_UNCONFIRMED_AFTER_SEC
        return await ledger.read("abc")
    record = asyncio.run(run())
    assert record["status"] == "failed" and record["reason"] == "unconfirmed"


def test_the_record_lives_for_the_ttl(redis):
    asyncio.run(SpeakDeliveryLedger(redis).record("abc", user_id=USER, meeting_id=1, platform=PLAT,
                                                  native_meeting_id=NATIVE))
    ttl = asyncio.run(redis.ttl(speak_send_key("abc")))
    assert 0 < ttl <= SPEAK_SEND_TTL_SEC
