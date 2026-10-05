import { buttonVariants } from '../../components/ui/button';
import { cn } from '@/lib/utils';

export function LoginView({ status = '', logout = '' }: { status?: string; logout?: string }) {
  const unavailable = status === 'unavailable';
  const logoutUnconfirmed = logout === 'unconfirmed';

  return (
    <main className="grid min-h-svh place-items-center bg-muted/40 px-4 py-8 sm:px-6">
      <section className="grid w-full max-w-3xl overflow-hidden rounded-2xl border bg-card shadow-sm md:grid-cols-2" aria-labelledby="login-title">
        <div className="hidden min-h-80 flex-col justify-center bg-primary px-8 text-primary-foreground md:flex">
          <h1 className="text-3xl font-semibold tracking-tight">LinguaLoop</h1>
          <p className="mt-2 text-sm text-primary-foreground/80">Language practice</p>
        </div>
        <div className="flex flex-col justify-center px-6 py-10 sm:px-10">
          <header className="mb-7">
            <p className="mb-2 text-sm font-medium text-primary md:hidden">LinguaLoop</p>
            <h2 id="login-title" className="text-2xl font-semibold tracking-tight">Welcome</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">Sign in to continue to your language practice setup.</p>
          </header>
          {unavailable && <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm leading-5 text-amber-950" role="status">We could not check your session. You can try signing in again.</p>}
          {!unavailable && logoutUnconfirmed && <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm leading-5 text-amber-950" role="alert">The server did not confirm sign-out. Your local practice page was cleared, but the server session may still be active.</p>}
          <a href="/api/auth/google" aria-label="Continue with Google" className={cn(buttonVariants({ size: 'lg', variant: 'outline' }), 'w-full rounded-lg')}>
            <GoogleMark />
            Continue with Google
          </a>
          <p className="mt-5 text-sm leading-6 text-muted-foreground">Use your Google account to access your private practice space.</p>
          <footer className="mt-10 text-center text-xs text-muted-foreground">© {new Date().getFullYear()} LinguaLoop</footer>
        </div>
      </section>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.55h3.24c1.9-1.75 2.98-4.33 2.98-7.42Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.98-.9 6.63-2.35l-3.24-2.55c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.63A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.39 13.93A6.02 6.02 0 0 1 6.07 12c0-.67.12-1.32.32-1.93V7.44H3.04A10 10 0 0 0 2 12c0 1.63.39 3.17 1.04 4.56l3.35-2.63Z" />
      <path fill="#EA4335" d="M12 5.94c1.47 0 2.79.5 3.83 1.5l2.87-2.88A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.96 5.44l3.35 2.63C7.18 7.7 9.39 5.94 12 5.94Z" />
    </svg>
  );
}
