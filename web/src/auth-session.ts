import { MAX_SYNTHESIS_WAV_BYTES, validateSynthesisText, validateWavBlob, type SynthesisLanguage, type SynthesisResult } from './practice-synthesis';

import { isEmail, isPassword, parseProfile, type Profile } from './features/auth/profile';
export type RefreshResult = 'authenticated' | 'no-session' | 'unavailable' | 'forbidden';

export type LoginResult = RefreshResult | 'invalid-credentials' | 'invalid-input' | 'rate-limited';

export type TranscriptionResult =
  | { ok: true; transcript: string }
  | { ok: false; error: 'too-large' | 'unsupported' | 'rate-limited' | 'unavailable' | 'failed' };

export class AuthSession {
  private accessToken: string | null = null;
  private currentProfile: Profile | null = null;

  get profile(): Profile | null { return this.currentProfile; }
  private refreshInFlight: Promise<RefreshResult> | null = null;
  private generation = 0;
  private localRefreshHeld = false;

  constructor(private readonly request: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async login(input: { email: string; password: string }): Promise<LoginResult> {
    if (!input || typeof input !== 'object' || Object.keys(input).length !== 2 ||
        !isEmail(input.email) || !isPassword(input.password)) return 'invalid-input';
    // Explicit login is the only operation that releases the local logout latch.
    this.clearLocal();
    const generation = this.generation;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.request('/api/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input), signal: controller.signal,
      });
      if (generation !== this.generation) return 'no-session';
      if (response.status === 401) return 'invalid-credentials';
      if (response.status === 400) return 'invalid-input';
      if (response.status === 429) return 'rate-limited';
      if (response.status === 403) return 'forbidden';
      if (response.status !== 200) return 'unavailable';
      const body: unknown = await response.json();
      if (generation !== this.generation) return 'no-session';
      if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 ||
          !('authenticated' in body) || body.authenticated !== true) return 'unavailable';
      this.localRefreshHeld = false;
      return await this.refresh();
    } catch {
      return generation !== this.generation ? 'no-session' : 'unavailable';
    } finally { clearTimeout(timeout); }
  }

  get authenticated(): boolean {
    return this.accessToken !== null && this.currentProfile !== null;
  }

  clearLocal(): void {
    this.generation++;
    this.localRefreshHeld = true;
    this.accessToken = null;
    this.currentProfile = null;
    this.refreshInFlight = null;
  }

  async getWithRefresh(url: string): Promise<Response | null> {
    if (this.localRefreshHeld) return null;
    if (!this.accessToken && (await this.refresh()) !== 'authenticated') return null;
    if (this.localRefreshHeld) return null;
    let response: Response;
    try {
      response = await this.request(url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (this.localRefreshHeld) return null;
      if (response.status !== 401) return response;
      if ((await this.refresh()) !== 'authenticated' || this.localRefreshHeld) return null;
      response = await this.request(url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (this.localRefreshHeld) return null;
      if (response.status === 401) {
        this.accessToken = null;
        this.currentProfile = null;
      }
      return response;
    } catch {
      return null;
    }
  }

  async postLanguagePractice(url: string, body: Record<string, unknown> | FormData): Promise<Response | null> {
    if (!this.isLanguagePracticeUrl(url)) return null;
    return this.postWithRefresh(url, body);
  }

  async postAdminAccounts(url: string, body: Record<string, unknown>): Promise<Response | null> {
    if (url !== '/api/admin/accounts') return null;
    return this.postWithRefresh(url, body);
  }

  private async postWithRefresh(url: string, body: Record<string, unknown> | FormData): Promise<Response | null> {
    if (this.localRefreshHeld) return null;
    if (!this.accessToken && (await this.refresh()) !== 'authenticated') return null;
    if (this.localRefreshHeld) return null;

    const generation = this.generation;
    let response = await this.sendLanguagePracticePost(url, body, generation);
    if (!response || response.status !== 401 || this.localRefreshHeld || generation !== this.generation) return response;
    if ((await this.refresh()) !== 'authenticated' || this.localRefreshHeld || generation !== this.generation) return null;
    response = await this.sendLanguagePracticePost(url, body, generation);
    if (this.localRefreshHeld || generation !== this.generation) return null;
    if (response?.status === 401) {
      this.accessToken = null;
      this.currentProfile = null;
    }
    return response;
  }

  refresh(): Promise<RefreshResult> {
    if (this.localRefreshHeld) return Promise.resolve('no-session');
    if (this.refreshInFlight) return this.refreshInFlight;

    const generation = this.generation;
    let pending: Promise<RefreshResult>;
    pending = this.performRefresh(generation).finally(() => {
      if (this.refreshInFlight === pending) this.refreshInFlight = null;
    });
    this.refreshInFlight = pending;
    return pending;
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
    this.clearLocal();
    return true;
  }

  private isLanguagePracticeUrl(value: string): boolean {
    if (typeof value !== 'string' || !value.startsWith('/api/language-practice/')) return false;
    try {
      const origin = globalThis.location?.origin ?? 'http://localhost';
      const url = new URL(value, origin);
      return url.origin === origin && url.pathname.startsWith('/api/language-practice/') && !url.hash;
    } catch {
      return false;
    }
  }

  private isLanguagePracticeTurnUrl(value: string): boolean {
    try {
      const origin = globalThis.location?.origin ?? 'http://localhost';
      const pathname = new URL(value, origin).pathname;
      return /^\/api\/language-practice\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/turns$/i.test(pathname);
    } catch {
      return false;
    }
  }

  private async sendLanguagePracticePost(
    url: string,
    body: Record<string, unknown> | FormData,
    generation: number,
  ): Promise<Response | null> {
    if (!this.accessToken || this.localRefreshHeld || generation !== this.generation) return null;
    const formData = typeof FormData !== 'undefined' && body instanceof FormData;
    let payload: BodyInit;
    try {
      payload = formData ? body as FormData : JSON.stringify(body);
    } catch {
      return null;
    }
    const controller = new AbortController();
    const timeoutMs = formData && this.isLanguagePracticeTurnUrl(url) ? 240_000 : 90_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.request(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          ...(formData ? {} : { 'Content-Type': 'application/json' }),
        },
        body: payload,
        signal: controller.signal,
      });
      return this.localRefreshHeld || generation !== this.generation ? null : response;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async performRefresh(generation: number): Promise<RefreshResult> {
    try {
      const response = await this.request('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (generation !== this.generation || this.localRefreshHeld) return 'no-session';
      this.accessToken = null;
      this.currentProfile = null;
      if (response.status === 401) return 'no-session';
      if (response.status === 403) return 'forbidden';
      if (response.status !== 200) return 'unavailable';

      const body: unknown = await response.json();
      if (generation !== this.generation || this.localRefreshHeld) return 'no-session';
      if (typeof body !== 'object' || body === null || !('accessToken' in body) ||
          typeof body.accessToken !== 'string' || body.accessToken.length === 0) {
        return 'unavailable';
      }
      const me = await this.request('/api/auth/me', {
        method: 'GET', credentials: 'same-origin',
        headers: { Authorization: `Bearer ${body.accessToken}` },
      });
      if (generation !== this.generation || this.localRefreshHeld) return 'no-session';
      if (me.status === 403) return 'forbidden';
      if (me.status === 401) return 'no-session';
      if (me.status !== 200) return 'unavailable';
      const profile = parseProfile(await me.json());
      if (generation !== this.generation || this.localRefreshHeld) return 'no-session';
      if (!profile) return 'forbidden';
      this.currentProfile = profile;
      this.accessToken = body.accessToken;
      return 'authenticated';
    } catch {
      if (generation === this.generation) {
        this.accessToken = null;
        this.currentProfile = null;
      }
      return this.localRefreshHeld ? 'no-session' : 'unavailable';
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

export const authSession = new AuthSession();
