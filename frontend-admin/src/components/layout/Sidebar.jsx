import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import {
  LayoutDashboard, Users, BookOpen, Zap, Plug, LogOut,
  Shield, Database, GitMerge, Star
} from 'lucide-react';

const NAV = [
  { section: 'Overview' },
  { to: '/',          icon: LayoutDashboard, label: 'Dashboard'   },
  { section: 'Customers' },
  { to: '/customers', icon: Users,           label: 'All Customers' },
  { to: '/customers?banned=true', icon: Shield, label: 'Banned' },
  { section: 'VIP Groups' },
  { to: '/vip-groups',   icon: Star,         label: 'VIP Groups CRM' },
  { section: 'Operations' },
  { to: '/rules',     icon: Zap,             label: 'Rule Engine'  },
  { to: '/logs',      icon: BookOpen,        label: 'Logs'         },
  { section: 'Data' },
  { to: '/sources',       icon: Database,    label: 'Data Sources' },
  { to: '/matching-queue',icon: GitMerge,    label: 'Matching Queue' },
  { section: 'System' },
  { to: '/integrations', icon: Plug,         label: 'Integrations' },
];

export default function Sidebar({ structureId, onStructureChange, alertCount = 0 }) {
  const { admin, logout } = useAuth();

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <div className="logo-mark">
          <div className="logo-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
          </div>
          <div>
            <div className="logo-text">Phenex VIP</div>
          </div>
          <span className="logo-badge">Admin</span>
        </div>
      </div>

      {/* Structure selector */}
      <div className="structure-selector">
        <input
          className="structure-input"
          placeholder="Filter by structure ID…"
          value={structureId}
          onChange={e => onStructureChange(e.target.value)}
        />
      </div>

      {/* Nav */}
      <nav className="sidebar-nav">
        {NAV.map((item, i) => {
          if (item.section) return (
            <div key={i} className="nav-section-label">{item.section}</div>
          );
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <Icon size={15} />
              {item.label}
              {item.label === 'Logs' && alertCount > 0 && (
                <span className="nav-badge">{alertCount}</span>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Admin footer */}
      <div className="sidebar-footer">
        <div className="admin-info" onClick={logout} title="Logout">
          <div className="admin-avatar">
            {admin?.name?.slice(0,2).toUpperCase() || 'AD'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="admin-name truncate">{admin?.name}</div>
            <div className="admin-role">{admin?.role}</div>
          </div>
          <LogOut size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        </div>
      </div>
    </aside>
  );
}
