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
  return <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
    <div className="min-w-0 break-words"><p className="text-sm text-primary">LinguaLoop · {authSession.profile?.role}</p>
      <h1 className="mt-2 text-3xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p></div>
    <Button variant="outline" disabled={busy} onClick={() => void logout()}><LogOut className="size-4" aria-hidden="true" />{busy ? 'Signing out…' : 'Log out'}</Button>
  </header>;
}
