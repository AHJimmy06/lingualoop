import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { authSession } from '../../auth-session';
import { Button } from '../../components/ui/button';
export function RoleHeader({ title, description }: { title: string; description: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  async function logout() {
    if (busy) return;
    setBusy(true);
    const confirmed = await authSession.logout();
    authSession.clearLocal();
    navigate(confirmed ? '/login' : '/login?logout=unconfirmed', { replace: true });
  }
  return <header className="mb-8 flex flex-wrap items-end justify-between gap-5 border-b border-slate-200/80 pb-6 sm:mb-9 sm:pb-7">
    <div className="min-w-0 break-words">
      <p className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-teal-800"><span className="size-2 rounded-full bg-teal-500 shadow-[0_0_0_4px_rgba(20,184,166,0.12)]" aria-hidden="true" />LinguaLoop <span className="text-slate-400">/</span> {authSession.profile?.role}</p>
      <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{title}</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">{description}</p>
    </div>
    <Button variant="outline" className="h-11 rounded-xl border-slate-200 bg-white/80 px-4 shadow-sm hover:bg-white" disabled={busy} onClick={() => void logout()}><LogOut className="size-4" aria-hidden="true" />{busy ? 'Signing out…' : 'Log out'}</Button>
  </header>;
}
