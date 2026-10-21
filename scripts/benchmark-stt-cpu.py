"""Isolated CPU benchmark; never reads .env, app database or OpenAI credentials.

Run with the dedicated benchmark venv. Assets/results live outside the repo.
Synthetic speech is a smoke test, NOT evidence of learner-accent accuracy.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
import wave

import psutil


def words(text):
    return re.findall(r"[a-z0-9]+", text.lower().replace("’", "'"))


def errors(reference, hypothesis):
    a, b = words(reference), words(hypothesis)
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        nxt = [i]
        for j, y in enumerate(b, 1):
            nxt.append(min(nxt[-1] + 1, row[j] + 1, row[j - 1] + (x != y)))
        row = nxt
    return row[-1], len(a)


def duration(path):
    with wave.open(str(path)) as f:
        return f.getnframes() / f.getframerate()


def prepare(root):
    root.mkdir(parents=True, exist_ok=True)
    local = Path(os.environ['LOCALAPPDATA'])
    piper = local / 'Programs/Piper/piper/piper.exe'
    voice = local / 'LinguaLoop/models/piper/en.onnx'
    texts = [
        ('greeting', 'Hello, can you hear me? I would like to talk about travel.'),
        ('travel', 'I would like to visit Peru next summer. Is Lima close to the coast or in the mountains?'),
        ('learner', 'Yesterday I go to the airport and I buy two ticket. My brother want to travel with me.'),
        ('long', 'I am planning a trip with my family next month. We would like to stay near the beach, but we also want to visit a museum. Could you recommend a quiet hotel and tell me how to get there from the airport?'),
    ]
    samples = []
    for name, text in texts:
        path = root / f'{name}.wav'
        if not path.exists():
            subprocess.run([str(piper), '--model', str(voice), '--output_file', str(path)],
                           input=text + '\n', text=True, capture_output=True, check=True, timeout=120)
        samples.append(dict(id=name, file=path.name, reference=text, kind='synthetic-piper'))
    path = root / 'jfk.wav'
    url = 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav'
    if not path.exists():
        urllib.request.urlretrieve(url, path)
    samples.append(dict(id='jfk', file=path.name, kind='human-public', source=url,
                        reference='And so my fellow Americans ask not what your country can do for you ask what you can do for your country'))
    path = root / 'silence.wav'
    with wave.open(str(path), 'wb') as f:
        f.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        f.writeframes(bytes(16000 * 2 * 5))
    samples.append(dict(id='silence', file=path.name, reference='', kind='silence'))
    for s in samples:
        path = root / s['file']
        s['duration_s'] = duration(path)
        s['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    (root / 'manifest.json').write_text(json.dumps(samples, indent=2), encoding='utf-8')


def tts(root):
    local = Path(os.environ['LOCALAPPDATA'])
    rows = []
    for lang, text in [('en', 'Sure, I can hear you. Peru sounds like a wonderful destination. What would you like to visit there?'),
                       ('es', 'Claro, puedo escucharte. En esta frase estás expresando un plan de viaje. Puedes usar esta sugerencia para practicar tu respuesta.')]:
        for repeat in range(3):
            path = root / f'tts-{lang}-{repeat}.wav'
            started = time.perf_counter()
            process = subprocess.Popen([str(local/'Programs/Piper/piper/piper.exe'), '--model',
                str(local/f'LinguaLoop/models/piper/{lang}.onnx'), '--output_file', str(path)],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            peak = [0]
            done = threading.Event()
            def sample():
                p = psutil.Process(process.pid)
                while not done.wait(.02):
                    try:
                        peak[0] = max(peak[0], p.memory_info().rss)
                    except psutil.Error:
                        pass
            monitor = threading.Thread(target=sample, daemon=True)
            monitor.start()
            try:
                process.communicate((text+'\n').encode(), timeout=120)
                if process.returncode:
                    raise RuntimeError(f'Piper {lang} exited {process.returncode}')
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                done.set()
                monitor.join(timeout=2)
            elapsed = time.perf_counter() - started
            row = dict(language=lang, repeat=repeat, seconds=elapsed, duration_s=duration(path),
                       peak_process_rss_mb=peak[0]/1024**2)
            rows.append(row)
            print(json.dumps(row), flush=True)
    (root/'piper.json').write_text(json.dumps(dict(rows=rows,
        note='CPU default Piper threading, cold process per sample, includes loading. Not API warm-worker latency or subjective voice quality.'), indent=2))


def report(root):
    lines = ['# Local CPU speech benchmark — 2026-10-21', '',
        'Windows, Intel i5-13450HX, 16 GB RAM; STT limited to 4 inference threads, one model/request at a time.',
        'This is NOT a 4-vCPU Linux server benchmark or an end-to-end app test.', '',
        'Corpus: four Piper English synthetic clips (3.48–10.49 s), JFK public human clip (11 s), and 5 s digital silence.',
        'Three timed repetitions per clip, after a warm-up. Download/load time excluded from inference timings.',
        'No API/database/.env access, no WSL, no OpenAI calls; temporary NeMo server uses loopback port 18189 and is stopped after the test.', '',
        '| Engine | Speech median (s) | Speech range (s) | Peak process RSS (MiB) | Human WER | Synthetic WER | Silence nonempty / 3 |',
        '|---|---:|---:|---:|---:|---:|---:|']
    for name in ['base.en', 'small.en', 'nemo', 'base.en-vad', 'small.en-vad']:
        r = json.loads((root/f'{name}.json').read_text())
        speech = [x['seconds'] for x in r['rows'] if x['reference_words']]
        def wer(kind):
            rows = [x for x in r['rows'] if x['kind'] == kind]
            return 100*sum(x['word_errors'] for x in rows)/sum(x['reference_words'] for x in rows)
        nonempty = sum(bool(x['text'].strip()) for x in r['rows'] if x['kind']=='silence')
        lines.append(f"| {name} | {statistics.median(speech):.3f} | {min(speech):.3f}–{max(speech):.3f} | {r['peak_process_rss_mb']:.0f} | {wer('human-public'):.1f}% | {wer('synthetic-piper'):.1f}% | {nonempty} |")
    lines += ['', 'Whisper: faster-whisper 1.2.1 / CTranslate2 4.8.3, INT8, beam_size=1, language=en, temperature=0, no previous-text conditioning.',
              'NeMo-Speech.cpp 0.2.0: current nemotron-3.5 Q8_0 model, CPU backend verified in server log, offline HTTP route.',
              'VAD variants use faster-whisper Silero; the baseline variants have no VAD.', '', '## Existing Piper TTS (CPU)', '',
              '| Language | Median cold synthesis (s) | Output duration range (s) | Peak RSS (MiB) |', '|---|---:|---:|---:|']
    t = json.loads((root/'piper.json').read_text())
    for lang in ['en','es']:
        rows = [x for x in t['rows'] if x['language']==lang]
        lines.append(f"| {lang} | {statistics.median(x['seconds'] for x in rows):.3f} | {min(x['duration_s'] for x in rows):.2f}–{max(x['duration_s'] for x in rows):.2f} | {max(x['peak_process_rss_mb'] for x in rows):.0f} |")
    lines += ['', 'TTS includes cold model/process startup, uses default Piper CPU threading, and is not comparable to STT timings. Voice quality was not subjectively evaluated.', '',
        '## Interpretation and limits', '',
        '- 90 STT timed calls, 6 TTS cold calls. Repetitions are timing samples, NOT independent accuracy examples.',
        '- The human clip is short, clean, famous native English speech; no learner-accent, noise, microphone, concurrency or production-load validation.',
        '- WER is lowercase alphanumeric edit distance (punctuation ignored, contractions split). Silence hallucinations are counted separately.',
        '- Zero errors on this small corpus does NOT establish equivalent accuracy or suitability for learner assessment.',
        '- RSS is sampled every 50 ms (STT), 20 ms (TTS); it excludes other processes, OS/cache and is not a Docker memory limit or full deployment budget.',
        '- NeMo timing includes local HTTP and WAV upload; Whisper is in-process. Do not interpret differences as a controlled model-only benchmark.',
        '- Existing models and .env remain unchanged. Keep NeMo as the baseline; base.en INT8 + VAD is a candidate for a broader learner-recording test, not an automatic replacement.', '',
        '## Reproduce', '', 'Use Python 3.12 in an isolated venv and install scripts/benchmark-stt-cpu.requirements.txt.',
        'On Windows with the existing NeMo/Piper installation, set ROOT to a directory outside the repository:', '', '```text',
        'python scripts/benchmark-stt-cpu.py --root ROOT --prepare',
        'python scripts/benchmark-stt-cpu.py --root ROOT --model base.en',
        'python scripts/benchmark-stt-cpu.py --root ROOT --model small.en',
        'python scripts/benchmark-stt-cpu.py --root ROOT --model nemo',
        'python scripts/benchmark-stt-cpu.py --root ROOT --model base.en --vad',
        'python scripts/benchmark-stt-cpu.py --root ROOT --model small.en --vad',
        'python scripts/benchmark-stt-cpu.py --root ROOT --tts',
        'python scripts/benchmark-stt-cpu.py --root ROOT --report', '```', '',
        'Raw per-call JSON, model cache, audio SHA256 manifest and requirements-lock.txt remain in ROOT; do not commit model/audio binaries.', '',
        'Source audio: https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav']
    (root/'report.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')


def run(args):
    root = args.root
    samples = json.loads((root / 'manifest.json').read_text())
    peak = [0]
    done = threading.Event()
    target = [psutil.Process()]
    def monitor():
        while not done.wait(.05):
            try:
                peak[0] = max(peak[0], target[0].memory_info().rss)
            except psutil.Error:
                pass
    thread = threading.Thread(target=monitor, daemon=True)
    thread.start()
    process = None
    log = None
    try:
        started = time.perf_counter()
        if args.model == 'nemo':
            # Never accidentally benchmark an unrelated service on our test port.
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 18189))
            exe = Path(os.environ['LOCALAPPDATA']) / 'Programs/NeMoSpeech/bin/nemo-speech.exe'
            log = (root / 'nemo-server.log').open('w', encoding='utf-8')
            process = subprocess.Popen([str(exe), 'serve', '--host', '127.0.0.1', '--port', '18189',
                '--asr-model', 'nemotron-3.5', '--device', 'cpu', '--asr.backend.threads', '4', '--no-ui'],
                stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            target[0] = psutil.Process(process.pid)
            for _ in range(240):
                if process.poll() is not None:
                    raise RuntimeError('NeMo exited; inspect nemo-server.log')
                try:
                    with urllib.request.urlopen('http://127.0.0.1:18189/ready', timeout=2) as r:
                        if json.load(r).get('ready'):
                            break
                except (OSError, ValueError):
                    pass
                time.sleep(1)
            else:
                raise TimeoutError('NeMo readiness timeout')
            def transcribe(path):
                boundary = 'LinguaLoopCpuBenchmarkBoundary'
                body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
                        + path.read_bytes() + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n--{boundary}--\r\n'.encode())
                request = urllib.request.Request('http://127.0.0.1:18189/v1/audio/transcriptions', data=body,
                    headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
                with urllib.request.urlopen(request, timeout=180) as response:
                    return json.load(response)['text']
        else:
            from faster_whisper import WhisperModel
            model = WhisperModel(args.model, device='cpu', compute_type='int8', cpu_threads=4,
                                 num_workers=1, download_root=str(root / 'models'))
            def transcribe(path):
                segments, _ = model.transcribe(str(path), language='en', beam_size=1,
                    temperature=0, condition_on_previous_text=False, vad_filter=args.vad)
                return ' '.join(s.text.strip() for s in segments)
        startup = time.perf_counter() - started
        transcribe(root / samples[0]['file'])  # warm-up excluded from timed inference
        rows = []
        for s in samples:
            for repeat in range(args.repeats):
                started = time.perf_counter()
                text = transcribe(root / s['file'])
                elapsed = time.perf_counter() - started
                e, n = errors(s['reference'], text)
                row = dict(sample=s['id'], kind=s['kind'], repeat=repeat, text=text,
                           seconds=elapsed, duration_s=s['duration_s'], rtf=elapsed/s['duration_s'],
                           word_errors=e, reference_words=n)
                rows.append(row)
                print(json.dumps(row), flush=True)
        from importlib.metadata import version
        result = dict(model=args.model, device='cpu', threads=4, repeats=args.repeats, vad=args.vad,
            python=sys.version, packages={p: version(p) for p in ['faster-whisper', 'ctranslate2', 'psutil', 'av']},
            startup_including_download_s=startup, peak_process_rss_mb=peak[0]/1024**2,
            median_seconds=statistics.median(r['seconds'] for r in rows), rows=rows,
            note='Windows local 4 threads, not server equivalence. WER normalization splits contractions. Synthetic WER is smoke-test only; no learner accent validation.')
        suffix = '-vad' if args.vad else ''
        (root / f'{args.model}{suffix}.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    finally:
        done.set()
        thread.join(timeout=2)
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if log:
            log.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--model', choices=['base.en', 'small.en', 'nemo'])
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--tts', action='store_true', help='Measure existing EN/ES Piper, cold processes')
    parser.add_argument('--report', action='store_true', help='Summarize all five runs and Piper')
    parser.add_argument('--vad', action='store_true', help='Enable faster-whisper Silero VAD')
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error('--repeats must be positive')
    if args.vad and args.model == 'nemo':
        parser.error('--vad is a faster-whisper-only option')
    if args.prepare:
        prepare(args.root)
    elif args.tts:
        tts(args.root)
    elif args.report:
        report(args.root)
    elif args.model:
        run(args)
    else:
        parser.error('--prepare or --model is required')
