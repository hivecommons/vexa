"""hotwords reach faster-whisper, and the startup warm-up runs one inference without failing the worker.

A fake model stands in for faster-whisper: the test pins what the handler hands to
model.transcribe, not recognition quality (that is measured live).
"""
from __future__ import annotations

import io
from types import SimpleNamespace

import numpy as np
import soundfile as sf

import transcription.main as svc

SAMPLE_RATE = 16000


class FakeModel:
    def __init__(self, fail: bool = False):
        self.calls: list[dict] = []
        self.fail = fail

    def transcribe(self, audio, **kwargs):
        self.calls.append(kwargs)
        if self.fail:
            raise RuntimeError("boom")
        return iter([]), SimpleNamespace(language="en", language_probability=1.0)


def _wav() -> bytes:
    buf = io.BytesIO()
    sf.write(buf, np.zeros(SAMPLE_RATE // 2, dtype=np.float32), SAMPLE_RATE, format="WAV")
    return buf.getvalue()


def _post(client, data):
    return client.post(
        "/v1/audio/transcriptions",
        files={"file": ("a.wav", _wav(), "audio/wav")},
        data={"model": "whisper-1", "response_format": "json", **data},
    )


def test_hotwords_and_prompt_reach_the_model(client, monkeypatch):
    fake = FakeModel()
    monkeypatch.setattr(svc, "model", fake)
    monkeypatch.setattr(svc, "API_TOKEN", "")
    r = _post(client, {"prompt": "Betty, Betty Bee from the hive.", "hotwords": " Betty "})
    assert r.status_code == 200
    assert fake.calls[0]["initial_prompt"] == "Betty, Betty Bee from the hive."
    assert fake.calls[0]["hotwords"] == "Betty"


def test_no_hotwords_sends_none(client, monkeypatch):
    fake = FakeModel()
    monkeypatch.setattr(svc, "model", fake)
    monkeypatch.setattr(svc, "API_TOKEN", "")
    assert _post(client, {"hotwords": "   "}).status_code == 200
    assert _post(client, {}).status_code == 200
    assert [c["hotwords"] for c in fake.calls] == [None, None]


def test_warm_up_runs_one_unfiltered_inference():
    fake = FakeModel()
    svc._warm_up(fake)
    assert len(fake.calls) == 1
    assert fake.calls[0]["vad_filter"] is False
    assert fake.calls[0]["beam_size"] == 1


def test_a_failed_warm_up_does_not_stop_the_worker():
    svc._warm_up(FakeModel(fail=True))
