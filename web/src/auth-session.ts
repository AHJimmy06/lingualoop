import { MAX_SYNTHESIS_WAV_BYTES, validateSynthesisText, validateWavBlob, type SynthesisLanguage, type SynthesisResult } from './practice-synthesis';

export type RefreshResult = 'authenticated' | 'no-session' | 'unavailable';

export type TranscriptionResult =
  | { ok: true; transcript: string }
  | { ok: false; error: 'too-large' | 'unsupported' | 'rate-limited' | 'unavailable' | 'failed' };

export class AuthSession {
  private accessToken: string | null = null;
  private refreshInFlight: Promise<RefreshResult> | null = null;

  constructor(private readonly request: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  get authenticated(): boolean {
    return this.accessToken !== null;
  }

  refresh(): Promise<RefreshResult> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = this.performRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  async transcribe(audio: Blob): Promise<TranscriptionResult> {
    let result = await this.sendTranscription(audio);
    if (result === 'unauthorized') {
      if ((await this.refresh()) !== 'authenticated') return { ok: false, error: 'failed' };
      result = await this.sendTranscription(audio);
    }
    return result === 'unauthorized' ? { ok: false, error: 'failed' } : result;
  }

  async synthesize(language: SynthesisLanguage, text: string): Promise<SynthesisResult> {
    const invalid = validateSynthesisText(text);
    if (invalid) return { ok: false, error: invalid };
    let result = await this.sendSynthesis(language, text);
    if (result === 'unauthorized') {
      const refreshed = await this.refresh();
      if (refreshed === 'no-session') return { ok: false, error: 'unauthorized' };
      if (refreshed !== 'authenticated') return { ok: false, error: 'unavailable' };
      result = await this.sendSynthesis(language, text);
    }
    return result === 'unauthorized' ? { ok: false, error: 'unauthorized' } : result;
  }

  async logout(): Promise<boolean> {
    if (!this.accessToken && (await this.refresh()) !== 'authenticated') return false;

    let response = await this.sendLogout();
    if (response === 'unauthorized') {
      if ((await this.refresh()) !== 'authenticated') return false;
      response = await this.sendLogout();
    }

    if (response !== 'revoked') return false;
    this.accessToken = null;
    return true;
  }

  private async performRefresh(): Promise<RefreshResult> {
    try {
      const response = await this.request('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (response.status === 401) {
        this.accessToken = null;
        return 'no-session';
      }
      if (response.status !== 200) return 'unavailable';

      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null || !('accessToken' in body) ||
          typeof body.accessToken !== 'string' || body.accessToken.length === 0) {
        return 'unavailable';
      }
      this.accessToken = body.accessToken;
      return 'authenticated';
    } catch {
      return 'unavailable';
    }
  }

  private async sendTranscription(audio: Blob): Promise<TranscriptionResult | 'unauthorized'> {
    if (!this.accessToken) return 'unauthorized';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await this.request('/api/practice/transcribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': audio.type,
        },
        body: audio,
        signal: controller.signal,
      });
      if (response.status === 401) return 'unauthorized';
      if (response.status === 413) return { ok: false, error: 'too-large' };
      if (response.status === 415) return { ok: false, error: 'unsupported' };
      if (response.status === 429) return { ok: false, error: 'rate-limited' };
      if (response.status === 503) return { ok: false, error: 'unavailable' };
      if (response.status !== 200) return { ok: false, error: 'failed' };

      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && 'transcript' in body &&
          typeof body.transcript === 'string' && body.transcript.trim().length > 0) {
        return { ok: true, transcript: body.transcript };
      }
      return { ok: false, error: 'failed' };
    } catch {
      return { ok: false, error: 'unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sendSynthesis(language: SynthesisLanguage, text: string): Promise<SynthesisResult | 'unauthorized'> {
    if (!this.accessToken) return 'unauthorized';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await this.request('/api/practice/synthesize', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ language, text }),
        signal: controller.signal,
      });
      if (response.status === 401) return 'unauthorized';
      if (response.status === 404) return { ok: false, error: 'not-found' };
      if (response.status === 429) return { ok: false, error: 'rate-limited' };
      if (response.status === 503) return { ok: false, error: 'unavailable' };
      if (response.status !== 200 || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'audio/wav') {
        return { ok: false, error: 'failed' };
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_SYNTHESIS_WAV_BYTES) return { ok: false, error: 'failed' };
      if (!response.body) return { ok: false, error: 'failed' };
      const reader = response.body.getReader();
      const chunks: ArrayBuffer[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_SYNTHESIS_WAV_BYTES) {
          await reader.cancel();
          return { ok: false, error: 'failed' };
        }
        chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
      }
      const wav = new Blob(chunks, { type: 'audio/wav' });
      if (!(await validateWavBlob(wav))) return { ok: false, error: 'failed' };
      return { ok: true, wav };
    } catch {
      return { ok: false, error: 'unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sendLogout(): Promise<'revoked' | 'unauthorized' | 'failed'> {
    if (!this.accessToken) return 'failed';
    try {
      const response = await this.request('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (response.status === 204) return 'revoked';
      if (response.status === 401) return 'unauthorized';
      return 'failed';
    } catch {
      return 'failed';
    }
  }
}
