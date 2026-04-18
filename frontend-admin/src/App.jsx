import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './hooks/useAuth';
import Sidebar from './components/layout/Sidebar';
import Dashboard from './pages/Dashboard';
import Customers from './pages/Customers';
import CustomerDetail from './pages/CustomerDetail';
import Rules from './pages/Rules';
import { Logs, Integrations } from './pages/LogsAndIntegrations';
import VipGroups from './pages/VipGroups';
import { DataSources, MatchingQueue } from './pages/DataSources';
import { Login } from './pages/Login';
import { getAlerts } from './services/api';
import './styles/globals.css';

function Shell() {
  const { admin, loading } = useAuth();
  const [structureId, setStructureId] = useState('');
  const [alertCount, setAlertCount]   = useState(0);

  useEffect(() => {
    if (!admin) return;
    getAlerts(false).then(a => setAlertCount(a.length)).catch(() => {});
    const iv = setInterval(() => {
      getAlerts(false).then(a => setAlertCount(a.length)).catch(() => {});
    }, 60000);
    return () => clearInterval(iv);
  }, [admin]);

  if (loading) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div className="spinner" />
    </div>
  );

  if (!admin) return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );

  return (
    <div className="app-shell">
      <Sidebar
        structureId={structureId}
        onStructureChange={setStructureId}
        alertCount={alertCount}
      />
      <div className="main-area">
        <div className="page-content">
          <Routes>
            <Route path="/"                  element={<Dashboard structureId={structureId} />} />
            <Route path="/customers"         element={<Customers />} />
            <Route path="/customers/:id"     element={<CustomerDetail />} />
            <Route path="/rules"             element={<Rules />} />
            <Route path="/logs"              element={<Logs />} />
            <Route path="/integrations"      element={<Integrations />} />
            <Route path="/vip-groups"        element={<VipGroups />} />
            <Route path="/sources"           element={<DataSources />} />
            <Route path="/matching-queue"    element={<MatchingQueue />} />
            <Route path="*"                  element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Shell />
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              fontSize: 13,
            },
          }}
        />
      </BrowserRouter>
    </AuthProvider>
  );
}
