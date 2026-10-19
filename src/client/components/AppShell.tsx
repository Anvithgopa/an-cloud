import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  HardDrive,
  Clock,
  Star,
  Share2,
  UploadCloud,
  Layers,
  Trash2,
  BarChart3,
  Settings,
  Sun,
  Moon,
  LogOut,
  Menu,
  X,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  AlertTriangle,
  Search,
} from 'lucide-react';
import { useAppState } from '../context/AppContext';
import { formatBytes } from '../lib/format';

interface AppShellProps {
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({ children }) => {
  const { user, storage, darkMode, toggleDarkMode, logout } = useAppState();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');
  const navigate = useNavigate();

  const navItems = [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/drive', label: 'My Drive', icon: HardDrive },
    { to: '/recent', label: 'Recent', icon: Clock },
    { to: '/starred', label: 'Starred', icon: Star },
    { to: '/shared', label: 'Shared by Me', icon: Share2 },
    { to: '/shared-uploads', label: 'Shared with Upload Permission', icon: UploadCloud },
    { to: '/categories', label: 'File Categories', icon: Layers },
    { to: '/trash', label: 'Trash', icon: Trash2 },
    { to: '/analytics', label: 'Storage Analytics', icon: BarChart3 },
    { to: '/settings', label: 'Settings', icon: Settings },
  ];

  const handleGlobalSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = globalSearch.trim();
    if (q) {
      navigate(`/drive?search=${encodeURIComponent(q)}`);
    } else {
      navigate('/drive');
    }
  };

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-xs lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 flex flex-col border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 transition-all duration-200 ${
          collapsed ? 'w-20' : 'w-72'
        } ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        {/* Brand Header */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center text-white shrink-0 shadow-xs">
              <HardDrive className="w-5 h-5" />
            </div>
            {!collapsed && (
              <div className="truncate">
                <div className="font-semibold text-base tracking-tight leading-none">
                  AN Cloud
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  Raspberry Pi 4 • HDD Vault
                </div>
              </div>
            )}
          </div>

          <button
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="hidden lg:flex p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>

          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden p-1.5 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 overflow-y-auto py-3 px-2.5 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMobileOpen(false)}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-400'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-white'
                  }`
                }
              >
                <Icon className="w-4 h-4 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </NavLink>
            );
          })}
        </nav>

        {/* Storage Usage Meter */}
        {storage && (
          <div className="p-3.5 mx-2.5 mb-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-800">
            {!collapsed ? (
              <>
                <div className="flex items-center justify-between text-xs font-medium mb-1.5">
                  <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-200">
                    {storage.isMounted && storage.isWritable ? (
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                    )}
                    HDD Storage
                  </span>
                  <span className="text-slate-500 dark:text-slate-400">{storage.usagePercent}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      storage.usagePercent > 90
                        ? 'bg-red-500'
                        : storage.usagePercent > 75
                        ? 'bg-amber-500'
                        : 'bg-blue-600'
                    }`}
                    style={{ width: `${Math.min(100, Math.max(2, storage.usagePercent))}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                  <span>{formatBytes(storage.usedBytes)} used</span>
                  <span>{formatBytes(storage.totalBytes)} total</span>
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                  Indexed files: {formatBytes(storage.activeIndexedBytes)}
                </div>
              </>
            ) : (
              <div
                className="flex flex-col items-center gap-1 text-[10px] font-medium text-slate-500"
                title={`${formatBytes(storage.usedBytes)} / ${formatBytes(storage.totalBytes)} (${storage.usagePercent}%)`}
              >
                <HardDrive className="w-4 h-4 text-blue-600" />
                <span>{Math.round(storage.usagePercent)}%</span>
              </div>
            )}
          </div>
        )}

        {/* Administrator Profile Footer */}
        <div className="p-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-800 flex items-center justify-center font-semibold text-xs text-slate-700 dark:text-slate-200 shrink-0">
              {user?.displayName?.slice(0, 2).toUpperCase() || 'AD'}
            </div>
            {!collapsed && (
              <div className="truncate">
                <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                  {user?.displayName || 'Administrator'}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                  @{user?.username}
                </div>
              </div>
            )}
          </div>

          {!collapsed && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={toggleDarkMode}
                title={darkMode ? 'Switch to light theme' : 'Switch to dark theme'}
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
              <button
                onClick={logout}
                title="Sign out"
                className="p-1.5 rounded-lg text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="h-16 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-4 lg:px-8 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 flex-1 max-w-xl">
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>

            <form onSubmit={handleGlobalSearch} className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={globalSearch}
                onChange={(e) => setGlobalSearch(e.target.value)}
                placeholder="Search files and folders across your HDD..."
                className="w-full pl-10 pr-4 py-2 text-sm rounded-xl bg-slate-100 dark:bg-slate-800/90 border border-transparent focus:border-blue-500 focus:bg-white dark:focus:bg-slate-900 focus:outline-hidden transition-colors"
              />
            </form>
          </div>

          <div className="flex items-center gap-2.5">
            {storage && (
              <div
                className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
                  storage.isMounted && storage.isWritable
                    ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60'
                    : 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/60'
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    storage.isMounted && storage.isWritable ? 'bg-emerald-500' : 'bg-red-500'
                  }`}
                />
                {storage.isMounted && storage.isWritable ? 'HDD Mounted & Healthy' : 'HDD Mount Error'}
              </div>
            )}

            <button
              onClick={toggleDarkMode}
              className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 lg:hidden"
              aria-label="Toggle theme"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        {/* Page Body */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
};
