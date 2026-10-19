import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiRequest, setCsrfToken } from '../lib/api';

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  lastLoginAt: string | null;
}

export interface SidebarStorageSummary {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
  activeIndexedBytes: number;
  isMounted: boolean;
  isWritable: boolean;
}

interface AppStateContextValue {
  loading: boolean;
  needsSetup: boolean;
  authenticated: boolean;
  user: AdminUser | null;
  storage: SidebarStorageSummary | null;
  darkMode: boolean;
  toggleDarkMode: () => void;
  refreshAuth: () => Promise<void>;
  refreshStorageSummary: () => Promise<void>;
  logout: () => Promise<void>;
}

const AppStateContext = createContext<AppStateContextValue | undefined>(undefined);

export const AppStateProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<AdminUser | null>(null);
  const [storage, setStorage] = useState<SidebarStorageSummary | null>(null);
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('scorpiocloud_theme');
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
      localStorage.setItem('scorpiocloud_theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('scorpiocloud_theme', 'light');
    }
  }, [darkMode]);

  const toggleDarkMode = useCallback(() => {
    setDarkMode((prev) => !prev);
  }, []);

  const refreshStorageSummary = useCallback(async () => {
    try {
      const data = await apiRequest('/api/v1/system/dashboard');
      if (data?.disk) {
        setStorage({
          totalBytes: data.disk.totalBytes,
          usedBytes: data.disk.usedBytes,
          availableBytes: data.disk.availableBytes,
          usagePercent: data.disk.usagePercent,
          activeIndexedBytes: data.disk.activeIndexedBytes,
          isMounted: data.disk.isMounted,
          isWritable: data.disk.isWritable,
        });
      }
    } catch {
      // Ignore if unauthenticated
    }
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      const status = await apiRequest('/api/v1/auth/status');
      setNeedsSetup(Boolean(status.needsSetup));
      setAuthenticated(Boolean(status.authenticated));
      setUser(status.user || null);
      setCsrfToken(status.csrfToken || null);
      if (status.authenticated) {
        await refreshStorageSummary();
      }
    } catch {
      setAuthenticated(false);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [refreshStorageSummary]);

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  const logout = useCallback(async () => {
    try {
      await apiRequest('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // Ignore
    }
    setCsrfToken(null);
    setAuthenticated(false);
    setUser(null);
  }, []);

  return (
    <AppStateContext.Provider
      value={{
        loading,
        needsSetup,
        authenticated,
        user,
        storage,
        darkMode,
        toggleDarkMode,
        refreshAuth,
        refreshStorageSummary,
        logout,
      }}
    >
      {children}
    </AppStateContext.Provider>
  );
};

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider');
  return ctx;
}
