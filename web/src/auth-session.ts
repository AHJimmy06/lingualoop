export type RefreshResult = 'authenticated' | 'no-session' | 'unavailable';

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
