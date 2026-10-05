export type RefreshResult = 'authenticated' | 'no-session' | 'unavailable';
export type RouteDecision = { kind: 'render' } | { kind: 'redirect'; to: string };

const render: RouteDecision = { kind: 'render' };
const toSetup: RouteDecision = { kind: 'redirect', to: '/language-practice' };

export function resolveRoute(pathname: string, search: string, refresh: RefreshResult): RouteDecision {
  if (pathname === '/' || !isKnownRoute(pathname)) return toSetup;

  if (pathname === '/login') {
    const params = new URLSearchParams(search);
    if (refresh === 'authenticated' && params.get('logout') !== 'unconfirmed') return toSetup;
    return render;
  }

  if (refresh === 'authenticated') return render;
  return {
    kind: 'redirect',
    to: refresh === 'unavailable' ? '/login?status=unavailable' : '/login',
  };
}

function isKnownRoute(pathname: string): boolean {
  return pathname === '/login' || pathname === '/language-practice' ||
    /^\/language-practice\/sessions\/[^/]+(?:\/complete)?$/.test(pathname);
}
