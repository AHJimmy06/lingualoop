import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


WORKER_PATH = Path(__file__).resolve().parents[2] / "scripts" / "fastconformer-worker.py"
SPEC = importlib.util.spec_from_file_location("fastconformer_worker", WORKER_PATH)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class FakeModel:
    def __init__(self, text):
        self.text = text
        self.audio_paths = []

    def transcribe(self, audio_paths):
        self.audio_paths.extend(audio_paths)
        return [self.text]


class FastConformerWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.model_path = Path(self.temp_dir.name) / "model.fixture"
        self.model_path.write_bytes(b"fixture model bytes; not a model")
        self.model_sha256 = hashlib.sha256(self.model_path.read_bytes()).hexdigest()

    def run_worker(self, requests, model_text=" recognized words ", extra_args=()):
        model = FakeModel(model_text)
        output = io.StringIO()
        error = io.StringIO()
        stdin = io.BytesIO(requests)
        status = worker.main(
            ["--model-path", str(self.model_path), "--model-sha256", self.model_sha256, *extra_args],
            stdin=stdin,
            stdout=output,
            stderr=error,
            model_loader=lambda path: model,
        )
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        return status, messages, error.getvalue(), model

    def test_import_does_not_load_nemo(self):
        self.assertNotIn("nemo", sys.modules)

    def test_production_subprocess_suppresses_fd1_noise_during_load_and_transcribe(self):
        harness = r'''import importlib.util, io, os, sys
spec = importlib.util.spec_from_file_location("worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
class Model:
    def transcribe(self, paths):
        print("synthetic transcribe print noise")
        os.write(1, b"synthetic transcribe native noise\n")
        return ["synthetic transcript"]
def load_model(path):
    print("synthetic restore print noise")
    os.write(1, b"synthetic restore native noise\n")
    return Model()
requests = io.BytesIO(b'{"id":"fixture-request","audioPath":"fixture.wav"}\n')
raise SystemExit(worker.main(
    ["--model-path", sys.argv[2], "--model-sha256", sys.argv[3]],
    stdin=requests,
    stderr=sys.stderr,
    model_loader=load_model,
))
'''
        completed = subprocess.run(
            [sys.executable, "-c", harness, str(WORKER_PATH), str(self.model_path), self.model_sha256],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.splitlines(), [
            json.dumps({
                "type": "ready",
                "modelId": worker.MODEL_ID,
                "modelSha256": self.model_sha256,
            }, separators=(",", ":")),
            json.dumps({
                "type": "result",
                "id": "fixture-request",
                "transcript": "synthetic transcript",
            }, separators=(",", ":")),
        ])

    def test_ready_and_success_preserve_protocol_and_matching_id(self):
        request = b'{"id":"request-1","audioPath":"/private/audio.wav"}\n'
        status, messages, error, model = self.run_worker(request)

        self.assertEqual(status, 0)
        self.assertEqual(messages[0], {
            "type": "ready",
            "modelId": worker.MODEL_ID,
            "modelSha256": self.model_sha256,
        })
        self.assertEqual(messages[1], {"type": "result", "id": "request-1", "transcript": "recognized words"})
        self.assertEqual(model.audio_paths, ["/private/audio.wav"])
        self.assertEqual(error, "")

    def test_no_speech_uses_legacy_code(self):
        status, messages, _, _ = self.run_worker(b'{"id":"quiet","audioPath":"clip.wav"}\n', model_text="  ")

        self.assertEqual(status, 0)
        self.assertEqual(messages[1]["id"], "quiet")
        self.assertEqual(messages[1]["code"], "LANGUAGE_PRACTICE_NO_SPEECH")

    def test_malformed_and_out_of_bounds_requests_are_rejected_without_echoing_input(self):
        too_long = b" " * (worker.MAX_INPUT_LINE_BYTES + 1) + b"\n"
        requests = b"\n".join([
            b'{"id":"bad\\nID","audioPath":"secret.wav"}',
            b'{"id":"x","audioPath":"secret\\n.wav"}',
            b'{"id":"x","audioPath":"secret\\u0085.wav"}',
            b'{"id":"x","audioPath":"a"' + b"a" * (worker.MAX_AUDIO_PATH_CHARS + 1) + b'"}',
            b'{"id":"x","audioPath":"ok","extra":true}',
        ]) + b"\n" + too_long
        status, messages, error, model = self.run_worker(requests)

        self.assertEqual(status, 0)
        results = messages[1:]
        self.assertEqual(len(results), 6)
        self.assertTrue(all(message["type"] == "result" and "error" in message for message in results))
        rendered = json.dumps(messages) + error
        self.assertNotIn("secret", rendered)
        self.assertNotIn("audioPath", rendered)
        self.assertEqual(model.audio_paths, [])

    def test_lone_surrogate_request_id_is_rejected_and_worker_continues(self):
        requests = b'{"id":"\\ud800","audioPath":"ok"}\n{"id":"after","audioPath":"ok"}\n'
        status, messages, _, model = self.run_worker(requests)

        self.assertEqual(status, 0)
        self.assertEqual(messages[1], {
            "type": "result",
            "id": "unknown",
            "error": "FastConformer transcription failed.",
        })
        self.assertEqual(messages[2]["id"], "after")
        self.assertEqual(model.audio_paths, ["ok"])

    def test_lone_surrogate_transcript_is_rejected_and_worker_continues(self):
        class SequentialModel:
            def __init__(self):
                self.calls = 0

            def transcribe(self, audio_paths):
                self.calls += 1
                return ["bad\ud800" if self.calls == 1 else "valid transcript"]

        model = SequentialModel()
        output = io.StringIO()
        status = worker.main(
            ["--model-path", str(self.model_path), "--model-sha256", self.model_sha256],
            stdin=io.BytesIO(
                b'{"id":"first","audioPath":"one.wav"}\n'
                b'{"id":"second","audioPath":"two.wav"}\n'
            ),
            stdout=output,
            stderr=io.StringIO(),
            model_loader=lambda path: model,
        )
        messages = [json.loads(line) for line in output.getvalue().splitlines()]

        self.assertEqual(status, 0)
        self.assertEqual(messages[1], {"type": "result", "id": "first", "error": "Invalid transcript."})
        self.assertEqual(messages[2], {"type": "result", "id": "second", "transcript": "valid transcript"})
        self.assertEqual(model.calls, 2)

    def test_model_digest_is_checked_before_model_loader_and_diagnostics_hide_path(self):
        output = io.StringIO()
        error = io.StringIO()
        calls = []
        status = worker.main(
            ["--model-path", str(self.model_path), "--model-sha256", "0" * 64],
            stdin=io.BytesIO(),
            stdout=output,
            stderr=error,
            model_loader=lambda path: calls.append(path),
        )

        self.assertEqual(status, 1)
        self.assertEqual(calls, [])
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn(str(self.model_path), error.getvalue())
        self.assertNotIn("fixture", error.getvalue())

    def test_invalid_digest_format_fails_before_model_loader(self):
        calls = []
        output = io.StringIO()
        error = io.StringIO()
        status = worker.main(
            ["--model-path", str(self.model_path), "--model-sha256", "A" * 64],
            stdin=io.BytesIO(),
            stdout=output,
            stderr=error,
            model_loader=lambda path: calls.append(path),
        )

        self.assertEqual(status, 1)
        self.assertEqual(calls, [])
        self.assertEqual(output.getvalue(), "")

    def test_transcript_limit_and_control_characters_are_not_returned(self):
        status, messages, _, _ = self.run_worker(
            b'{"id":"id","audioPath":"clip.wav"}\n',
            model_text="x" * (worker.MAX_TRANSCRIPT_CHARS + 1),
        )
        self.assertEqual(status, 0)
        self.assertEqual(messages[1], {"type": "result", "id": "id", "error": "Invalid transcript."})


if __name__ == "__main__":
    unittest.main()
