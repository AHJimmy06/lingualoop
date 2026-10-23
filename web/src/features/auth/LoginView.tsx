import { useEffect, useState } from 'react';
import { authSession } from '../../auth-session';
import { AudioLines, BookOpenCheck, Sparkles } from 'lucide-react';

export function LoginView({ status = '', logout = '' }: { status?: string; logout?: string }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState({ google: false, microsoft: false });
  useEffect(() => {
    let active = true;
    void fetch('/api/auth/providers', { credentials: 'same-origin', cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(value => {
        if (active && value && typeof value === 'object') setProviders({ google: value.google === true, microsoft: value.microsoft === true });
      }).catch(() => undefined).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  function startOAuth(provider: 'google' | 'microsoft') {
    setBusy(true);
    authSession.clearLocal();
    window.location.assign(`/api/auth/${provider}`);
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
        <header className="mb-7 sm:mb-9"><p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">Welcome</p><h2 id="login-title" className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-[2.1rem]">Sign in</h2><p className="mt-2 text-sm leading-6 text-slate-600 sm:text-base">Continue to your LinguaLoop learning space.</p></header>
        {status === 'unavailable' && <p className="mb-4 rounded-lg border p-3 text-sm" role="status">We could not check your session. You can try signing in again.</p>}
        {status === 'forbidden' && <p className="mb-4 rounded-lg border p-3 text-sm" role="alert">Your account does not have an approved role. Contact your administrator.</p>}
        {status === 'oauth-failed' && <p className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">We could not sign you in with that provider. Try again with Google or Microsoft. If the problem continues, contact your administrator.</p>}
        {logout === 'unconfirmed' && <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">The server did not confirm sign-out. Your local practice page was cleared, but the server session may still be active.</p>}
        {loading && <p className="mb-4 text-sm text-slate-600" role="status">Checking sign-in options…</p>}
        {!loading && !providers.google && !providers.microsoft && <p className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950" role="alert">Google and Microsoft sign-in are not available. Contact your administrator to configure access.</p>}
        {(providers.google || providers.microsoft) && <>
          <div className="my-6 flex items-center gap-3" aria-hidden="true"><span className="h-px flex-1 bg-slate-200" /><span className="text-[11px] font-medium uppercase tracking-widest text-slate-400">Continue with</span><span className="h-px flex-1 bg-slate-200" /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            {providers.google && <button type="button" onClick={() => startOAuth('google')} disabled={busy} className="inline-flex h-12 items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-600/15 disabled:opacity-60" aria-label="Continue with Google"><svg aria-hidden="true" viewBox="0 0 48 48" className="size-5"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.25 5.48-4.72 7.18l7.62 5.91c4.45-4.1 7.14-10.15 7.14-17.56Z"/><path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.28-3.13.78-4.59l-7.98-6.2A23.94 23.94 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.89l-7.62-5.91c-2.12 1.42-4.83 2.26-8.28 2.26-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"/></svg>Google</button>}
            {providers.microsoft && <button type="button" onClick={() => startOAuth('microsoft')} disabled={busy} className="inline-flex h-12 items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-600/15 disabled:opacity-60" aria-label="Continue with Microsoft"><svg aria-hidden="true" viewBox="0 0 24 24" className="size-5"><path fill="#F25022" d="M1 1h10v10H1z"/><path fill="#7FBA00" d="M13 1h10v10H13z"/><path fill="#00A4EF" d="M1 13h10v10H1z"/><path fill="#FFB900" d="M13 13h10v10H13z"/></svg>Microsoft</button>}
          </div>
        </>}
        <div className="my-6 flex items-center gap-3" aria-hidden="true"><span className="h-px flex-1 bg-slate-200" /><span className="text-[11px] font-medium uppercase tracking-widest text-slate-400">Private learning space</span><span className="h-px flex-1 bg-slate-200" /></div>
        <p className="text-center text-sm leading-6 text-slate-500">Use Google or Microsoft to sign in.<br />Your first sign-in creates your account.</p>
        <footer className="mt-8 text-center text-xs text-slate-400">© {new Date().getFullYear()} LinguaLoop · Learn at your pace</footer>
      </div>
    </section>
  </main>;
}
