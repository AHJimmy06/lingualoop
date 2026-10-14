import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { authSession, type LoginResult } from '../../auth-session';
import { Button } from '../../components/ui/button';
import { roleHome } from '../../react-route-policy';

const messages: Partial<Record<LoginResult, string>> = {
  'invalid-credentials': 'The email or password is incorrect.',
  'invalid-input': 'Enter a valid email and a password of 8–128 characters.',
  'rate-limited': 'Too many sign-in attempts. Please wait before trying again.',
  forbidden: 'Your account does not have an approved role. Contact your administrator.',
  unavailable: 'Sign-in could not be confirmed. Please try again.',
  'no-session': 'Sign-in was cancelled. Please try again.',
};
export function LoginView({ status = '', logout = '' }: { status?: string; logout?: string }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    const result = await authSession.login({ email: email.trim().toLowerCase(), password });
    setPassword('');
    if (result === 'authenticated' && authSession.profile) navigate(roleHome(authSession.profile.role), { replace: true });
    else setError(messages[result] ?? 'Sign-in could not be confirmed.');
    pending.current = false; setBusy(false);
  }
  return <main className="grid min-h-svh place-items-center bg-muted/40 px-4 py-8 sm:px-6">
    <section className="grid w-full max-w-3xl overflow-hidden rounded-2xl border bg-card shadow-sm md:grid-cols-2" aria-labelledby="login-title">
      <div className="hidden flex-col justify-center bg-primary px-8 text-primary-foreground md:flex">
        <h1 className="text-3xl font-semibold tracking-tight">LinguaLoop</h1>
        <p className="mt-3 text-sm leading-6 text-primary-foreground/80">A little conversation.<br />A little more confidence.</p>
      </div>
      <div className="px-6 py-10 sm:px-10">
        <header className="mb-7"><p className="mb-2 text-sm font-medium text-primary md:hidden">LinguaLoop</p><h2 id="login-title" className="text-2xl font-semibold">Welcome back</h2><p className="mt-2 text-sm text-muted-foreground">Sign in to your learning space.</p></header>
        {status === 'unavailable' && <p className="mb-4 rounded-lg border p-3 text-sm" role="status">We could not check your session. You can try signing in again.</p>}
        {status === 'forbidden' && <p className="mb-4 rounded-lg border p-3 text-sm" role="alert">Your account does not have an approved role. Contact your administrator.</p>}
        {logout === 'unconfirmed' && <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">The server did not confirm sign-out. Your local practice page was cleared, but the server session may still be active.</p>}
        <form onSubmit={event => void submit(event)} className="grid gap-4" aria-label="Sign in">
          <label className="grid gap-2 text-sm font-medium">Email<input className="rounded-lg border bg-background p-3" type="email" autoComplete="username" required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
          <label className="grid gap-2 text-sm font-medium">Password<input className="rounded-lg border bg-background p-3" type="password" autoComplete="current-password" required minLength={8} maxLength={128} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <Button size="lg" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
        </form>
        <p className="mt-5 text-sm leading-6 text-muted-foreground">Your administrator creates your account. There is no public signup.</p>
        <footer className="mt-8 text-center text-xs text-muted-foreground">© {new Date().getFullYear()} LinguaLoop</footer>
      </div>
    </section>
  </main>;
}
