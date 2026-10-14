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
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
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
  const input = { name: name.trim(), email: email.trim().toLowerCase(), password, role };
  let valid = true;
  try { validateAccountInput(input); } catch { valid = false; }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || pending.current) return;
    pending.current = true; setBusy(true); setMessage(''); setError('');
    try {
      await client.createAccount(input);
      setMessage('Account created. The user can now sign in with their email and password.');
      setName(''); setPassword(''); setEmail(''); setAttempt(value => value + 1);
    } catch (failure) {
      setError(failure instanceof LanguagePracticeClientError ? failure.message : 'The account was not confirmed. Try again.');
    } finally { setPassword(''); pending.current = false; setBusy(false); }
  }
  return <main className="authenticated-page">
    <RoleHeader title="Accounts" description="Create teacher and student accounts. There is no public signup." />
    <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <form onSubmit={event => void submit(event)} className="grid min-w-0 gap-4 rounded-xl border bg-card p-4 [overflow-wrap:anywhere] sm:p-6" aria-label="Create account">
        <h2 className="text-lg font-semibold">Create an account</h2>
        <label className="grid min-w-0 gap-2 text-sm">Name<input className="min-w-0 rounded-md border bg-background p-3" required maxLength={120} autoComplete="off" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label className="grid min-w-0 gap-2 text-sm">Email<input className="min-w-0 rounded-md border bg-background p-3" type="email" required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
        <label className="grid min-w-0 gap-2 text-sm">Initial password<input className="min-w-0 rounded-md border bg-background p-3" type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /><span className="text-muted-foreground">8–128 characters. Share privately with the account owner.</span></label>
        <label className="grid min-w-0 gap-2 text-sm">Role<select className="min-w-0 rounded-md border bg-background p-3" value={role} disabled={busy} onChange={event => setRole(event.target.value as AccountInput['role'])}><option value="student">Student</option><option value="teacher">Teacher</option></select></label>
        <Button type="submit" disabled={!valid || busy}>{busy ? 'Creating…' : 'Create account'}</Button>
        {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      </form>
      <section className="min-w-0 rounded-xl border bg-card p-4 [overflow-wrap:anywhere] sm:p-6" aria-labelledby="accounts-title">
        <h2 id="accounts-title" className="text-lg font-semibold">Accounts list</h2>
        {listError ? <div role="alert"><p>{listError}</p><Button variant="outline" onClick={() => setAttempt(value => value + 1)}>Try again</Button></div> : accounts === null ? <p role="status">Loading accounts…</p> : accounts.length === 0 ? <p>No teacher or student accounts have been created yet.</p> :
          <ul className="mt-4 grid gap-3">{accounts.map(account => <li key={account.id} className="min-w-0 rounded-lg border p-3 [overflow-wrap:anywhere]"><p className="font-medium">{account.name}</p><p>{account.email}</p><p className="text-sm text-muted-foreground">{account.role} · Created {new Date(account.createdAt).toLocaleDateString()}</p></li>)}</ul>}
      </section>
    </div>
  </main>;
}
