#!/usr/bin/env python3
"""Long-lived FastConformer worker for Language Practice."""

import argparse
import hashlib
import json
import os
import re
import sys
from contextlib import contextmanager, nullcontext
import unicodedata
from pathlib import Path


MODEL_ID = "nvidia/stt_en_fastconformer_hybrid_large_pc"
MAX_INPUT_LINE_BYTES = 8192
MAX_ID_CHARS = 256
MAX_AUDIO_PATH_CHARS = 4096
MAX_TRANSCRIPT_CHARS = 30000
NO_SPEECH_CODE = "LANGUAGE_PRACTICE_NO_SPEECH"


def emit(value, output):
    output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    output.flush()


@contextmanager
def _isolated_protocol_stdout():
    protocol_fd = os.dup(1)
    protocol_output = None
    null_fd = None
    try:
        protocol_output = os.fdopen(protocol_fd, "w", encoding="utf-8", newline="\n")
        protocol_fd = -1
        null_fd = os.open(os.devnull, os.O_WRONLY)
        os.dup2(null_fd, 1)
        yield protocol_output
    finally:
        if null_fd is not None:
            os.close(null_fd)
        if protocol_fd >= 0:
            os.close(protocol_fd)
        if protocol_output is not None:
            try:
                protocol_output.flush()
            except Exception:
                pass
            protocol_output.close()


def transcript_text(result):
    value = result[0]
    return value.text if hasattr(value, "text") else str(value)


def verify_model(model_path, expected_sha256):
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("Invalid model digest")
    path = Path(model_path)
    if not path.is_file():
        raise ValueError("Model file unavailable")
    digest = hashlib.sha256()
    with path.open("rb") as model_file:
        for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
            digest.update(chunk)
    actual_sha256 = digest.hexdigest()
    if actual_sha256 != expected_sha256:
        raise ValueError("Model digest mismatch")
    return path, actual_sha256


def load_model(model_path):
    # Keep NeMo out of the import path until model integrity is established.
    import nemo.collections.asr as nemo_asr

    return nemo_asr.models.ASRModel.restore_from(restore_path=str(model_path))


def _has_controls(value):
    return any(unicodedata.category(character) in {"Cc", "Cs"} for character in value)


def parse_request(line):
    value = json.loads(line)
    if not isinstance(value, dict) or set(value) != {"id", "audioPath"}:
        raise ValueError("Invalid request")
    request_id = value["id"]
    audio_path = value["audioPath"]
    if (
        not isinstance(request_id, str)
        or not request_id
        or len(request_id) > MAX_ID_CHARS
        or _has_controls(request_id)
    ):
        raise ValueError("Invalid request")
    if (
        not isinstance(audio_path, str)
        or not audio_path
        or len(audio_path) > MAX_AUDIO_PATH_CHARS
        or _has_controls(audio_path)
    ):
        raise ValueError("Invalid request")
    return request_id, audio_path


def _input_lines(stream):
    while True:
        line = stream.readline(MAX_INPUT_LINE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_INPUT_LINE_BYTES:
            # Discard the remainder so it cannot be mistaken for a new request.
            while line and not line.endswith(b"\n"):
                line = stream.readline(MAX_INPUT_LINE_BYTES + 1)
            yield None
            continue
        yield line


def _parser():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--model-sha256", required=True)
    return parser


def main(argv=None, stdin=None, stdout=None, stderr=None, model_loader=None):
    stdin = stdin if stdin is not None else sys.stdin.buffer
    production_stdout = stdout is None
    stderr = stderr if stderr is not None else sys.stderr
    model_loader = model_loader if model_loader is not None else load_model
    args = _parser().parse_args(argv)

    output_context = _isolated_protocol_stdout() if production_stdout else nullcontext(stdout)
    try:
        with output_context as protocol_output:
            try:
                model_path, model_sha256 = verify_model(args.model_path, args.model_sha256)
                model = model_loader(model_path)
            except Exception:
                stderr.write("FastConformer worker startup failed.\n")
                stderr.flush()
                return 1

            emit({"type": "ready", "modelId": MODEL_ID, "modelSha256": model_sha256}, protocol_output)
            for raw_line in _input_lines(stdin):
                request_id = "unknown"
                try:
                    if raw_line is None:
                        raise ValueError("Request exceeds limit")
                    line = raw_line.decode("utf-8")
                    request_id, audio_path = parse_request(line)
                    transcript = transcript_text(model.transcribe([audio_path])).strip()
                    if not transcript:
                        emit(
                            {
                                "type": "result",
                                "id": request_id,
                                "code": NO_SPEECH_CODE,
                                "error": "No speech was recognized. Please try again and speak clearly.",
                            },
                            protocol_output,
                        )
                    elif len(transcript) > MAX_TRANSCRIPT_CHARS or _has_controls(transcript):
                        emit({"type": "result", "id": request_id, "error": "Invalid transcript."}, protocol_output)
                    else:
                        emit({"type": "result", "id": request_id, "transcript": transcript}, protocol_output)
                except Exception:
                    emit({"type": "result", "id": request_id, "error": "FastConformer transcription failed."}, protocol_output)

        return 0
    except Exception:
        stderr.write("FastConformer worker startup failed.\n")
        stderr.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
