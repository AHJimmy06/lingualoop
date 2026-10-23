import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { authSession } from '../../auth-session';
import { Button } from '../../components/ui/button';
import { RoleHeader } from '../auth/RoleHeader';
import { LanguagePracticeClientError } from '../language-practice/language-practice-client';
import { AdminAccountsClient, validateAccountInput, type Approval, type AccountInput } from './admin-client';

export function AdminAccountsView() {
  const client = useMemo(() => new AdminAccountsClient(authSession), []);
  const [accounts, setAccounts] = useState<Approval[] | null>(null);
  const [listError, setListError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AccountInput['role']>('student');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    setAccounts(null); setListError('');
    void client.listAccounts().then(value => { if (active) setAccounts(value); }, failure => {
      if (active) setListError(failure instanceof LanguagePracticeClientError ? failure.message : 'Accounts could not be loaded.');
    });
    return () => { active = false; };
  }, [client, attempt]);
  const input = { email: email.trim().toLowerCase(), role };
  let valid = true;
  try { validateAccountInput(input); } catch { valid = false; }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || pending.current) return;
    pending.current = true; setBusy(true); setMessage(''); setError('');
    try {
      await client.createAccount(input);
      setMessage('Role reserved. Their name will be obtained from Google or Microsoft when they sign in.');
      setEmail(''); setAttempt(value => value + 1);
    } catch (failure) {
      setError(failure instanceof LanguagePracticeClientError ? failure.message : 'The account was not confirmed. Try again.');
    } finally { pending.current = false; setBusy(false); }
  }
  return <main className="authenticated-page">
    <RoleHeader title="Accounts" description="Users register with Google or Microsoft. You can invite teachers and students by email." />
    <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <form onSubmit={event => void submit(event)} className="grid min-w-0 gap-4 rounded-2xl border border-white/80 bg-white/90 p-4 shadow-lg shadow-slate-900/5 backdrop-blur [overflow-wrap:anywhere] sm:p-6" aria-label="Create account">
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">Reserve a role</h2>
        <label className="grid min-w-0 gap-2 text-sm">Email<input className="min-w-0 rounded-md border bg-background p-3" type="email" required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
        <label className="grid min-w-0 gap-2 text-sm">Role<select className="min-w-0 rounded-md border bg-background p-3" value={role} disabled={busy} onChange={event => setRole(event.target.value as AccountInput['role'])}><option value="student">Student</option><option value="teacher">Teacher</option></select></label>
        <Button type="submit" disabled={!valid || busy}>{busy ? 'Creating…' : 'Create account'}</Button>
        {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      </form>
      <section className="min-w-0 rounded-2xl border border-white/80 bg-white/90 p-4 shadow-lg shadow-slate-900/5 backdrop-blur [overflow-wrap:anywhere] sm:p-6" aria-labelledby="accounts-title">
        <h2 id="accounts-title" className="text-xl font-semibold tracking-tight text-slate-900">Accounts list</h2>
        {listError ? <div role="alert"><p>{listError}</p><Button variant="outline" onClick={() => setAttempt(value => value + 1)}>Try again</Button></div> : accounts === null ? <p role="status">Loading accounts…</p> : accounts.length === 0 ? <p>No teacher or student accounts have been created yet.</p> :
          <ul className="mt-4 grid gap-3">{accounts.map(account => <li key={account.id} className="min-w-0 rounded-lg border p-3 [overflow-wrap:anywhere]"><p className="font-medium">{account.name ?? 'Pending first sign-in'}</p><p>{account.email}</p><p className="text-sm text-muted-foreground">{account.role} · Created {new Date(account.createdAt).toLocaleDateString()}</p></li>)}</ul>}
      </section>
    </div>
  </main>;
}
