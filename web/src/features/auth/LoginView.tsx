import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { authSession, type LoginResult } from '../../auth-session';
import { Button } from '../../components/ui/button';
import { roleHome } from '../../react-route-policy';
import { AudioLines, BookOpenCheck, Sparkles } from 'lucide-react';

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
  return <main className="relative isolate grid min-h-svh place-items-center overflow-hidden bg-[#071a2d] px-4 py-8 sm:px-8 sm:py-12">
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_18%_8%,rgba(25,194,188,0.28),transparent_38%),radial-gradient(ellipse_at_85%_84%,rgba(74,119,238,0.3),transparent_42%),linear-gradient(145deg,#071a2d_5%,#103957_52%,#102a4c_100%)]" />
    <div aria-hidden="true" className="pointer-events-none absolute -left-24 top-1/3 -z-10 size-72 rounded-full border border-white/10 sm:left-[6%] sm:size-96" />
    <div aria-hidden="true" className="pointer-events-none absolute -bottom-36 -right-16 -z-10 size-[28rem] rounded-full border border-teal-100/10" />
    <section className="grid w-full max-w-5xl overflow-hidden rounded-[1.75rem] border border-white/50 bg-white shadow-[0_32px_100px_-36px_rgba(0,0,0,0.72)] md:grid-cols-2" aria-labelledby="login-title">
      <aside className="relative isolate flex min-h-[250px] flex-col justify-between overflow-hidden bg-[linear-gradient(145deg,#0f766e_0%,#155e75_42%,#183b65_100%)] px-7 py-8 text-white sm:px-10 sm:py-10 md:min-h-[620px] md:px-12 md:py-12">
        <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-16 -z-10 size-72 rounded-full border-[36px] border-white/[0.07] sm:size-96" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-28 -left-24 -z-10 size-72 rounded-full bg-teal-300/10 blur-2xl" />
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl border border-white/20 bg-white/10 shadow-inner"><AudioLines className="size-5" aria-hidden="true" /></span>
          <span className="text-lg font-semibold tracking-tight sm:text-xl">LinguaLoop</span>
        </div>
        <div className="relative mt-10 md:mt-0">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium tracking-wide text-teal-50"><Sparkles className="size-3.5" aria-hidden="true" /> YOUR SPACE TO PRACTICE</p>
          <h1 className="max-w-md text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl lg:text-[2.75rem]">Find your voice.<br /><span className="text-teal-200">One conversation</span> at a time.</h1>
          <p className="mt-4 max-w-sm text-sm leading-6 text-white/75 sm:text-base sm:leading-7">Build confidence through focused language practice, thoughtful feedback, and small daily wins.</p>
          <div className="mt-7 flex flex-wrap gap-2.5 text-xs font-medium text-white/90 sm:mt-9 sm:gap-3 sm:text-sm">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-slate-950/10 px-3 py-2"><AudioLines className="size-4 text-teal-200" aria-hidden="true" /> Speak</span>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-slate-950/10 px-3 py-2"><BookOpenCheck className="size-4 text-teal-200" aria-hidden="true" /> Learn</span>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-slate-950/10 px-3 py-2"><Sparkles className="size-4 text-teal-200" aria-hidden="true" /> Grow</span>
          </div>
        </div>
        <p className="mt-9 text-xs text-white/55 md:mt-10">A little practice goes a long way.</p>
      </aside>
      <div className="flex flex-col justify-center px-6 py-9 sm:px-10 sm:py-12 lg:px-14">
        <header className="mb-7 sm:mb-9"><p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">Welcome back</p><h2 id="login-title" className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-[2.1rem]">Sign in</h2><p className="mt-2 text-sm leading-6 text-slate-600 sm:text-base">Continue to your LinguaLoop learning space.</p></header>
        {status === 'unavailable' && <p className="mb-4 rounded-lg border p-3 text-sm" role="status">We could not check your session. You can try signing in again.</p>}
        {status === 'forbidden' && <p className="mb-4 rounded-lg border p-3 text-sm" role="alert">Your account does not have an approved role. Contact your administrator.</p>}
        {logout === 'unconfirmed' && <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">The server did not confirm sign-out. Your local practice page was cleared, but the server session may still be active.</p>}
        <form onSubmit={event => void submit(event)} className="grid gap-5" aria-label="Sign in">
          <label className="grid gap-2 text-sm font-semibold text-slate-800">Email address<input className="h-12 rounded-xl border border-slate-200 bg-slate-50/70 px-4 text-base font-normal text-slate-950 shadow-sm transition placeholder:text-slate-400 hover:border-slate-300 focus-visible:border-teal-600 focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/10" type="email" autoComplete="username" placeholder="you@example.com" required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
          <label className="grid gap-2 text-sm font-semibold text-slate-800">Password<input className="h-12 rounded-xl border border-slate-200 bg-slate-50/70 px-4 text-base font-normal text-slate-950 shadow-sm transition placeholder:text-slate-400 hover:border-slate-300 focus-visible:border-teal-600 focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/10" type="password" autoComplete="current-password" placeholder="Enter your password" required minLength={8} maxLength={128} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
          {error && <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">{error}</p>}
          <Button size="lg" type="submit" disabled={busy} className="mt-1 h-12 rounded-xl bg-teal-700 text-base font-semibold shadow-[0_8px_20px_-8px_rgba(15,118,110,0.75)] transition hover:bg-teal-800">{busy ? 'Signing in…' : 'Sign in to LinguaLoop'}</Button>
        </form>
        <div className="my-6 flex items-center gap-3" aria-hidden="true"><span className="h-px flex-1 bg-slate-200" /><span className="text-[11px] font-medium uppercase tracking-widest text-slate-400">Private learning space</span><span className="h-px flex-1 bg-slate-200" /></div>
        <p className="text-center text-sm leading-6 text-slate-500">Your administrator creates your account.<br />There is no public signup.</p>
        <footer className="mt-8 text-center text-xs text-slate-400">© {new Date().getFullYear()} LinguaLoop · Learn at your pace</footer>
      </div>
    </section>
  </main>;
}
