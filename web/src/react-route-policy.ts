import type { Role } from './features/auth/profile';
export type RefreshResult = 'authenticated' | 'no-session' | 'unavailable' | 'forbidden';
export type RouteDecision = { kind: 'render' } | { kind: 'redirect'; to: string };
export function roleHome(role: Role): string {
  return role === 'admin' ? '/admin' : role === 'teacher' ? '/teacher' : '/language-practice';
}
export function resolveRoute(pathname: string, search: string, refresh: RefreshResult, role: Role | null = null): RouteDecision {
  const params = new URLSearchParams(search);
  if (pathname === '/login' && (refresh !== 'authenticated' || params.get('logout') === 'unconfirmed')) return { kind: 'render' };
  if (refresh !== 'authenticated') return { kind: 'redirect', to: refresh === 'unavailable' ? '/login?status=unavailable' : refresh === 'forbidden' ? '/login?status=forbidden' : '/login' };
  if (!role || !['admin', 'teacher', 'student'].includes(role)) return { kind: 'redirect', to: '/login?status=forbidden' };
  const home = roleHome(role);
  const studentRoute = pathname === '/language-practice' || pathname === '/language-practice/history' ||
    /^\/language-practice\/practices\/[^/]+$/.test(pathname) ||
    /^\/language-practice\/sessions\/[^/]+(?:\/complete)?$/.test(pathname);
  const teacherRoute = pathname === '/teacher' || /^\/teacher\/practices\/[^/]+\/results(?:\/[^/]+)?$/.test(pathname);
  const allowed = role === 'student' ? studentRoute : role === 'teacher' ? teacherRoute : pathname === home;
  return allowed ? { kind: 'render' } : { kind: 'redirect', to: home };
}
