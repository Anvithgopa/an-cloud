import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppStateProvider, useAppState } from './context/AppContext';
import { AppShell } from './components/AppShell';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { DrivePage } from './pages/DrivePage';
import { SharesPage } from './pages/SharesPage';
import { PublicSharePage } from './pages/PublicSharePage';
import { SettingsPage } from './pages/SettingsPage';

const ProtectedWorkspace: React.FC = () => {
  const { loading, authenticated } = useAppState();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="w-8 h-8 rounded-full border-3 border-blue-600 border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!authenticated) {
    return <AuthPage />;
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/drive" element={<DrivePage viewMode="folder" />} />
        <Route path="/recent" element={<DrivePage viewMode="recent" />} />
        <Route path="/starred" element={<DrivePage viewMode="starred" />} />
        <Route path="/shared" element={<SharesPage uploadOnlyFilter={false} />} />
        <Route path="/shared-uploads" element={<SharesPage uploadOnlyFilter={true} />} />
        <Route path="/categories" element={<DrivePage viewMode="categories" />} />
        <Route path="/trash" element={<DrivePage viewMode="trash" />} />
        <Route path="/analytics" element={<DashboardPage analyticsFocus={true} />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AppShell>
  );
};

export const App: React.FC = () => {
  return (
    <AppStateProvider>
      <BrowserRouter>
        <Routes>
          {/* Public Share Links (no login required) */}
          <Route path="/s/:token" element={<PublicSharePage />} />
          {/* Private Administrator Workspace */}
          <Route path="/*" element={<ProtectedWorkspace />} />
        </Routes>
      </BrowserRouter>
    </AppStateProvider>
  );
};
