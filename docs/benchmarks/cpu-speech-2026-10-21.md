# Local CPU speech benchmark — 2026-10-21

Windows, Intel i5-13450HX, 16 GB RAM; STT limited to 4 inference threads, one model/request at a time.
This is NOT a 4-vCPU Linux server benchmark or an end-to-end app test.

Corpus: four Piper English synthetic clips (3.48–10.49 s), JFK public human clip (11 s), and 5 s digital silence.
Three timed repetitions per clip, after a warm-up. Download/load time excluded from inference timings.
No API/database/.env access, no WSL, no OpenAI calls; temporary NeMo server uses loopback port 18189 and is stopped after the test.

| Engine | Speech median (s) | Speech range (s) | Peak process RSS (MiB) | Human WER | Synthetic WER | Silence nonempty / 3 |
|---|---:|---:|---:|---:|---:|---:|
| base.en | 0.781 | 0.655–0.982 | 316 | 0.0% | 0.0% | 3 |
| small.en | 1.833 | 1.660–2.187 | 692 | 0.0% | 0.0% | 3 |
| nemo | 0.775 | 0.498–2.098 | 1684 | 0.0% | 0.0% | 0 |
| base.en-vad | 0.745 | 0.635–0.969 | 339 | 0.0% | 0.0% | 0 |
| small.en-vad | 2.040 | 1.656–2.710 | 678 | 0.0% | 0.0% | 0 |

Whisper: faster-whisper 1.2.1 / CTranslate2 4.8.3, INT8, beam_size=1, language=en, temperature=0, no previous-text conditioning.
NeMo-Speech.cpp 0.2.0: current nemotron-3.5 Q8_0 model, CPU backend verified in server log, offline HTTP route.
VAD variants use faster-whisper Silero; the baseline variants have no VAD.

## Existing Piper TTS (CPU)

| Language | Median cold synthesis (s) | Output duration range (s) | Peak RSS (MiB) |
|---|---:|---:|---:|
| en | 0.767 | 5.94–6.10 | 127 |
| es | 0.836 | 7.62–7.76 | 139 |

TTS includes cold model/process startup, uses default Piper CPU threading, and is not comparable to STT timings. Voice quality was not subjectively evaluated.

## Interpretation and limits

- 90 STT timed calls, 6 TTS cold calls. Repetitions are timing samples, NOT independent accuracy examples.
- The human clip is short, clean, famous native English speech; no learner-accent, noise, microphone, concurrency or production-load validation.
- WER is lowercase alphanumeric edit distance (punctuation ignored, contractions split). Silence hallucinations are counted separately.
- Zero errors on this small corpus does NOT establish equivalent accuracy or suitability for learner assessment.
- RSS is sampled every 50 ms (STT), 20 ms (TTS); it excludes other processes, OS/cache and is not a Docker memory limit or full deployment budget.
- NeMo timing includes local HTTP and WAV upload; Whisper is in-process. Do not interpret differences as a controlled model-only benchmark.
- User selected base.en INT8 + VAD for local and remote CPU inference. Do not silently fall back to NeMo; retain broader learner-recording validation as a known accuracy limitation.

## Reproduce

Use Python 3.12 in an isolated venv and install scripts/benchmark-stt-cpu.requirements.txt.
On Windows with the existing NeMo/Piper installation, set ROOT to a directory outside the repository:

```text
python scripts/benchmark-stt-cpu.py --root ROOT --prepare
python scripts/benchmark-stt-cpu.py --root ROOT --model base.en
python scripts/benchmark-stt-cpu.py --root ROOT --model small.en
python scripts/benchmark-stt-cpu.py --root ROOT --model nemo
python scripts/benchmark-stt-cpu.py --root ROOT --model base.en --vad
python scripts/benchmark-stt-cpu.py --root ROOT --model small.en --vad
python scripts/benchmark-stt-cpu.py --root ROOT --tts
python scripts/benchmark-stt-cpu.py --root ROOT --report
```

Raw per-call JSON, model cache, audio SHA256 manifest and requirements-lock.txt remain in ROOT; do not commit model/audio binaries.

Source audio: https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav
