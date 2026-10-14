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
import { AdminAccountsView } from './features/admin/AdminAccountsView';
import { TeacherPracticesView } from './features/teacher/TeacherPracticesView';
import { TeacherResultsView } from './features/teacher/TeacherResultsView';
import { CustomPracticeView } from './features/language-practice/PracticeCatalogue';
import type { Role } from './features/auth/profile';

function RouteGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const routeKey = `${location.pathname}${location.search}`;
  const [checkedRoute, setCheckedRoute] = useState<{ key: string; result: RefreshResult; role: Role | null } | null>(null);

  useEffect(() => {
    let active = true;
    void authSession.refresh().then((result) => {
      if (active) setCheckedRoute({ key: routeKey, result, role: authSession.profile?.role ?? null });
    });
    return () => { active = false; };
  }, [routeKey]);

  const refresh = checkedRoute?.key === routeKey ? checkedRoute.result : null;
  if (refresh === null) {
    return <main className="mx-auto flex min-h-svh w-full max-w-xl items-center px-5 py-8" role="status">Checking your session…</main>;
  }

  const decision = resolveRoute(location.pathname, location.search, refresh, checkedRoute?.role ?? null);
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
        <Route path="/admin" element={<RouteGate><AdminAccountsView /></RouteGate>} />
        <Route path="/teacher" element={<RouteGate><TeacherPracticesView /></RouteGate>} />
        <Route path="/teacher/practices/:practiceId/results" element={<RouteGate><TeacherResultsView /></RouteGate>} />
        <Route path="/teacher/practices/:practiceId/results/:sessionId" element={<RouteGate><TeacherResultsView /></RouteGate>} />
        <Route path="/language-practice/practices/:practiceId" element={<RouteGate><CustomPracticeView /></RouteGate>} />
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
