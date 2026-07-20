/**
 * App — root router with auth gating and role-based access.
 *
 * Flow:
 *   1. Default entry point → /login (always)
 *   2. Login page shows "Set up BOS" link when onboarding not yet complete
 *   3. /onboarding accessible directly, no auth required; redirects to /login on completion
 *   4. Logged in as admin → full dashboard + admin routes
 *   5. Logged in as user → scoped dashboard (no system config)
 */

import React, { Suspense, lazy, useState, useCallback } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import Builder from './pages/Builder';
import { Rascals } from './pages/Rascals';
import { Layout } from './components/Layout';
import { PageLoader } from './components/LoadingSpinner';
import { WorkspaceContext, type WorkspaceType } from './hooks/useWorkspace';

// Lazy-load pages
const Dashboard    = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Office       = lazy(() => import('./pages/Office'));
const Login        = lazy(() => import('./pages/Login').then((m) => ({ default: m.Login })));
const Settings     = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const ClaudeAuth   = lazy(() => import('./pages/ClaudeAuth').then((m) => ({ default: m.ClaudeAuth })));
import { HermesSetup } from './pages/HermesSetup';
const Onboarding   = lazy(() => import('./pages/Onboarding').then((m) => ({ default: m.Onboarding })));
const Calendar     = lazy(() => import('./pages/Calendar'));
const Paperclip    = lazy(() => import('./pages/Paperclip'));
const LinkedIn     = lazy(() => import('./pages/LinkedIn'));
const WhatsApp     = lazy(() => import('./pages/WhatsApp'));
const TaskBoard    = lazy(() => import('./pages/TaskBoard'));
const Canvas       = lazy(() => import('./pages/Canvas'));
const CRM          = lazy(() => import('./pages/CRM'));
const OC           = lazy(() => import('./pages/OC'));
const Board        = lazy(() => import('./pages/Board'));
const JoinMeeting  = lazy(() => import('./pages/JoinMeeting'));
const COO          = lazy(() => import('./pages/COO'));
const AgentWorkspace = lazy(() => import('./pages/AgentWorkspace').then((m) => ({ default: m.OutsiderWorkspace })));
const RascalWorkspace = lazy(() => import('./pages/AgentWorkspace').then((m) => ({ default: m.RascalWorkspace })));
const EmployeeAgents = lazy(() => import('./pages/EmployeeAgents').then((m) => ({ default: m.EmployeeAgents })));
const Health       = lazy(() => import('./pages/Health'));
const HealthHolo   = lazy(() => import('./pages/HealthHolo'));
const HealthJournal = lazy(() => import('./pages/HealthJournal'));
const HealthMedicalRecords = lazy(() => import('./pages/HealthMedicalRecords'));

function getUser(): { role: string } | null {
  try {
    const raw = localStorage.getItem('boss_user');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isLoggedIn(): boolean {
  return !!localStorage.getItem('boss_token');
}

function isOnboarded(): boolean {
  return localStorage.getItem('boss_onboarding_complete') === 'true';
}

/**
 * Requires a valid login token.
 * Redirects to /login if not authenticated.
 * Onboarding check is intentionally removed — the login page
 * surfaces the onboarding link when needed.
 */
function RequireAuth() {
  const location = useLocation();
  const [workspace, setWorkspace] = useState<WorkspaceType>(null);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);

  const openWorkspace = useCallback((id: string) => {
    setWorkspace(id as WorkspaceType);
  }, []);

  const openBrowser = useCallback((url: string) => {
    setBrowserUrl(url);
    setWorkspace('browser');
  }, []);

  const closeWorkspace = useCallback(() => {
    setWorkspace(null);
    setBrowserUrl(null);
  }, []);

  if (!isLoggedIn()) return <Navigate to="/login" replace state={{ from: location }} />;
  return (
    <WorkspaceContext.Provider value={{ workspace, browserUrl, openWorkspace, openBrowser, closeWorkspace }}>
      <Layout>
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </Layout>
    </WorkspaceContext.Provider>
  );
}

/**
 * Admin-only routes. Users see a redirect to dashboard.
 */
function RequireAdmin() {
  const user = getUser();
  if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Public routes */}
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/login" element={<Login />} />
        <Route path="/join/:code" element={<JoinMeeting />} />

        {/* Authenticated routes */}
        <Route element={<RequireAuth />}>
          {/* Top-level tabs — all roles */}
          <Route path="/" element={<Dashboard />} />
          <Route path="/office" element={<Office />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/kanban" element={<TaskBoard />} />
          <Route path="/tasks" element={<TaskBoard />} />
          <Route path="/board" element={<Board />} />
          <Route path="/canvas" element={<Canvas />} />
          <Route path="/paperclip" element={<Paperclip />} />
          <Route path="/crm" element={<CRM />} />
          <Route path="/linkedin" element={<LinkedIn />} />
          <Route path="/social" element={<Navigate to="/linkedin" replace />} />
          <Route path="/whatsapp" element={<WhatsApp />} />
          <Route path="/oc" element={<OC />} />
          {import.meta.env.VITE_BUILDER === '1' && <Route path="/builder" element={<Builder />} />}
          <Route path="/coo" element={<COO />} />
          <Route path="/rascals" element={<Rascals />} />
          <Route path="/rascals/:handle" element={<RascalWorkspace />} />
          <Route path="/setup/claude-auth" element={<ClaudeAuth />} />
          <Route path="/setup/hermes" element={<HermesSetup />} />

          {/* Admin-only system routes */}
          <Route element={<RequireAdmin />}>
            <Route path="/agents"            element={<EmployeeAgents />} />
            <Route path="/agents/:handle"    element={<AgentWorkspace />} />
            <Route path="/health"            element={<Health />} />
            <Route path="/health/holo"       element={<HealthHolo />} />
            <Route path="/health/journal"    element={<HealthJournal />} />
            <Route path="/health/records"    element={<HealthMedicalRecords />} />
            <Route path="/settings"     element={<Settings />} />
            <Route path="/settings/:section" element={<Navigate to="/settings" replace />} />
            <Route path="/admin"        element={<Navigate to="/settings" replace />} />
            <Route path="/hermes"       element={<Navigate to="/settings" replace />} />
            <Route path="/chief"        element={<Navigate to="/settings" replace />} />
            <Route path="/voice"        element={<Navigate to="/settings" replace />} />
            <Route path="/brain"        element={<Navigate to="/settings" replace />} />
            <Route path="/connectors"   element={<Navigate to="/settings" replace />} />
            <Route path="/learning"     element={<Navigate to="/settings" replace />} />
            <Route path="/self-healing" element={<Navigate to="/settings" replace />} />
            <Route path="/backup"       element={<Navigate to="/settings" replace />} />
          </Route>
        </Route>

        {/* Catch-all → login */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Suspense>
  );
}
