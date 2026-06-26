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
import { Rascals } from './pages/Rascals';
import { Layout } from './components/Layout';
import { PageLoader } from './components/LoadingSpinner';
import { WorkspaceContext, type WorkspaceType } from './hooks/useWorkspace';

// Lazy-load pages
const Dashboard    = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Login        = lazy(() => import('./pages/Login').then((m) => ({ default: m.Login })));
const VoiceDevices = lazy(() => import('./pages/VoiceDevices').then((m) => ({ default: m.VoiceDevices })));
const BrainConfig  = lazy(() => import('./pages/BrainConfig').then((m) => ({ default: m.BrainConfig })));
const Connectors   = lazy(() => import('./pages/Connectors').then((m) => ({ default: m.Connectors })));
const Learning     = lazy(() => import('./pages/Learning').then((m) => ({ default: m.Learning })));
const SelfHealing  = lazy(() => import('./pages/SelfHealing').then((m) => ({ default: m.SelfHealing })));
const BackupStatus = lazy(() => import('./pages/BackupStatus').then((m) => ({ default: m.BackupStatus })));
const Settings     = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const ClaudeAuth   = lazy(() => import('./pages/ClaudeAuth').then((m) => ({ default: m.ClaudeAuth })));
import { HermesSetup } from './pages/HermesSetup';
const Onboarding   = lazy(() => import('./pages/Onboarding').then((m) => ({ default: m.Onboarding })));
const Calendar     = lazy(() => import('./pages/Calendar'));
const Paperclip    = lazy(() => import('./pages/Paperclip'));
const WhatsApp     = lazy(() => import('./pages/WhatsApp'));
const TaskBoard    = lazy(() => import('./pages/TaskBoard'));
const Canvas       = lazy(() => import('./pages/Canvas'));
const CRM          = lazy(() => import('./pages/CRM'));
const OC           = lazy(() => import('./pages/OC'));
const ChiefOfStaff = lazy(() => import('./pages/ChiefOfStaff'));
const Board        = lazy(() => import('./pages/Board'));
const JoinMeeting  = lazy(() => import('./pages/JoinMeeting'));
const COO          = lazy(() => import('./pages/COO'));
const AgentWorkspace = lazy(() => import('./pages/AgentWorkspace').then((m) => ({ default: m.OutsiderWorkspace })));
const RascalWorkspace = lazy(() => import('./pages/AgentWorkspace').then((m) => ({ default: m.RascalWorkspace })));
const EmployeeAgents = lazy(() => import('./pages/EmployeeAgents').then((m) => ({ default: m.EmployeeAgents })));

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
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/kanban" element={<TaskBoard />} />
          <Route path="/tasks" element={<TaskBoard />} />
          <Route path="/board" element={<Board />} />
          <Route path="/canvas" element={<Canvas />} />
          <Route path="/paperclip" element={<Paperclip />} />
          <Route path="/crm" element={<CRM />} />
          <Route path="/whatsapp" element={<WhatsApp />} />
          <Route path="/oc" element={<OC />} />
          <Route path="/coo" element={<COO />} />
          <Route path="/rascals" element={<Rascals />} />
          <Route path="/rascals/:handle" element={<RascalWorkspace />} />
          <Route path="/setup/claude-auth" element={<ClaudeAuth />} />
          <Route path="/setup/hermes" element={<HermesSetup />} />

          {/* Admin-only system routes */}
          <Route element={<RequireAdmin />}>
            <Route path="/agents"            element={<EmployeeAgents />} />
            <Route path="/agents/:handle"    element={<AgentWorkspace />} />
            <Route path="/hermes"            element={<ChiefOfStaff />} />
            <Route path="/chief"             element={<ChiefOfStaff />} />
            <Route path="/voice"        element={<VoiceDevices />} />
            <Route path="/brain"        element={<BrainConfig />} />
            <Route path="/connectors"   element={<Connectors />} />
            <Route path="/learning"     element={<Learning />} />
            <Route path="/self-healing" element={<SelfHealing />} />
            <Route path="/backup"       element={<BackupStatus />} />
            <Route path="/settings"     element={<Settings />} />
          </Route>
        </Route>

        {/* Catch-all → login */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Suspense>
  );
}
