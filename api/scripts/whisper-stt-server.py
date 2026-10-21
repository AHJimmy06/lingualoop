"""Private OpenAI-compatible transcription shim for faster-whisper.

Only accepts multipart WAVs, keeps model RAM-cached, serializes inference, and
returns no request metadata/transcript in logs. Host defaults to loopback; only
set a bridge-bound host on a private, unpublished Docker network.
"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import BoundedSemaphore
import os

MAX_UPLOAD = 100 * 1024 * 1024


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1', choices=['127.0.0.1', '0.0.0.0'])
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--model', default='base.en', choices=['base.en'])
    parser.add_argument('--compute-type', default='int8', choices=['int8'])
    parser.add_argument('--cpu-threads', type=int, default=4)
    args = parser.parse_args()
    if args.port < 1024 or args.port > 65535 or args.cpu_threads < 1 or args.cpu_threads > 16:
        parser.error('invalid port or thread count')

    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device='cpu', compute_type='int8',
                         cpu_threads=args.cpu_threads, num_workers=1)
    inference = BoundedSemaphore(1)

    class Handler(BaseHTTPRequestHandler):
        server_version = 'LinguaLoop-STT'

        def log_message(self, _fmt, *_args):
            pass  # Never log URLs, IP addresses, transcripts, or audio metadata.

        def respond(self, status, payload):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == '/ready':
                self.respond(200, {'ready': True, 'model': args.model, 'device': 'cpu'})
            else:
                self.respond(404, {'error': 'not found'})

        def do_POST(self):
            if self.path != '/v1/audio/transcriptions':
                return self.respond(404, {'error': 'not found'})
            if not inference.acquire(timeout=75):
                return self.respond(503, {'error': 'transcriber busy'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                content_type = self.headers.get('Content-Type', '')
                boundary = next((p.split('=', 1)[1].strip('"') for p in content_type.split(';')
                                 if p.strip().lower().startswith('boundary=')), '')
                if size < 1 or size > MAX_UPLOAD or not boundary or len(boundary) > 200:
                    return self.respond(400, {'error': 'invalid upload'})
                body = self.rfile.read(size)
                marker = b'--' + boundary.encode('ascii', 'strict')
                file_bytes = None
                for part in body.split(marker):
                    head, sep, data = part.partition(b'\r\n\r\n')
                    if sep and b'name="file"' in head and b'filename=' in head:
                        file_bytes = data.removesuffix(b'\r\n')
                        break
                if not file_bytes or not file_bytes.startswith(b'RIFF'):
                    return self.respond(400, {'error': 'invalid audio'})
                import io
                import tempfile
                with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as audio:
                    audio.write(file_bytes)
                    audio_path = audio.name
                try:
                    segments, _info = model.transcribe(
                        audio_path, language='en', beam_size=1, temperature=0,
                        condition_on_previous_text=False, vad_filter=True,
                    )
                    text = ' '.join(segment.text.strip() for segment in segments).strip()
                finally:
                    os.unlink(audio_path)
                self.respond(200, {'text': text})
            except (ValueError, UnicodeError):
                self.respond(400, {'error': 'invalid upload'})
            except Exception:
                self.respond(503, {'error': 'transcription unavailable'})
            finally:
                inference.release()

    class QuietServer(ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = False

    httpd = QuietServer((args.host, args.port), Handler)
    print(f'STT ready: {args.model} INT8 CPU ({args.cpu_threads} threads)', flush=True)
    httpd.serve_forever(poll_interval=0.5)


if __name__ == '__main__':
    main()
