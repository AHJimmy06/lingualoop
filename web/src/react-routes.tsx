import { useEffect, useState, type ReactNode } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { authSession } from './auth-session';
import { LoginView } from './features/auth/LoginView';
import { LanguagePracticeSetupView } from './features/language-practice/LanguagePracticeSetupView';
import { PracticeReportView } from './features/language-practice/PracticeReportView';
import { LivePracticeView } from './features/language-practice/LivePracticeView';
import { resolveRoute, type RefreshResult } from './react-route-policy';

function RouteGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const routeKey = `${location.pathname}${location.search}`;
  const [checkedRoute, setCheckedRoute] = useState<{ key: string; result: RefreshResult } | null>(null);

  useEffect(() => {
    let active = true;
    void authSession.refresh().then((result) => {
      if (active) setCheckedRoute({ key: routeKey, result });
    });
    return () => { active = false; };
  }, [routeKey]);

  const refresh = checkedRoute?.key === routeKey ? checkedRoute.result : null;
  if (refresh === null) {
    return <main className="mx-auto flex min-h-svh w-full max-w-xl items-center px-5 py-8" role="status">Checking your session…</main>;
  }

  const decision = resolveRoute(location.pathname, location.search, refresh);
  if (decision.kind === 'redirect') return <Navigate to={decision.to} replace />;
  return children;
}

function LoginRoute() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  return <RouteGate><LoginView status={params.get('status') ?? ''} logout={params.get('logout') ?? ''} /></RouteGate>;
}

export function ReactRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/language-practice" replace />} />
        <Route path="/login" element={<LoginRoute />} />
        <Route path="/language-practice" element={
          <RouteGate><LanguagePracticeSetupView /></RouteGate>
        } />
        <Route path="/language-practice/sessions/:sessionId" element={
          <RouteGate><LivePracticeView /></RouteGate>
        } />
        <Route path="/language-practice/sessions/:sessionId/complete" element={
          <RouteGate><PracticeReportView /></RouteGate>
        } />
        <Route path="*" element={<Navigate to="/language-practice" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
