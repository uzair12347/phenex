import React, { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts';
import {
  Users, TrendingUp, DollarSign, AlertTriangle,
  UserX, UserCheck, Activity, RefreshCw
} from 'lucide-react';
import { getDashboardOverview, getDashboardCharts, getDashboardDaily, getAlerts, resolveAlert } from '../services/api';
import { fmt } from '../utils/helpers';
import dayjs from 'dayjs';
import toast from 'react-hot-toast';

const TOOLTIP_STYLE = {
  backgroundColor: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--text-primary)',
};

export default function Dashboard({ structureId }) {
  const [overview, setOverview] = useState(null);
  const [charts, setCharts]     = useState(null);
  const [daily, setDaily]       = useState(null);
  const [alerts, setAlerts]     = useState([]);
  const [selDate, setSelDate]   = useState(dayjs().format('YYYY-MM-DD'));
  const [loading, setLoading]   = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, ch, dly, al] = await Promise.all([
        getDashboardOverview(structureId || undefined),
        getDashboardCharts(30, structureId || undefined),
        getDashboardDaily(selDate, structureId || undefined),
        getAlerts(false),
      ]);
      setOverview(ov); setCharts(ch); setDaily(dly); setAlerts(al);
    } catch (e) {
      toast.error('Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [structureId, selDate]);

  useEffect(() => { load(); }, [load]);

  const handleResolveAlert = async (id) => {
    await resolveAlert(id);
    setAlerts(prev => prev.filter(a => a.id !== id));
    toast.success('Alert resolved');
  };

  if (loading) return (
    <div className="flex items-center justify-between" style={{ height: 200, justifyContent: 'center' }}>
      <div className="spinner" />
    </div>
  );

  const c = overview?.customers || {};
  const t = overview?.trading   || {};
  const f = overview?.funding   || {};
  const r = overview?.atRisk    || {};

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">
            {structureId ? `Structure: ${structureId}` : 'Global view – all structures'}
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* ── KPI Row ── */}
      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        <KPI label="Total Customers"   value={fmt.num(c.total_customers)}   icon={<Users size={22}/>}         cls="accent" />
        <KPI label="Active 24h"        value={fmt.num(c.active_last_24h)}   icon={<Activity size={22}/>}      cls="success" />
        <KPI label="VIP Members"       value={fmt.num(c.vip_customers)}     icon={<UserCheck size={22}/>}     cls="info" />
        <KPI label="Banned"            value={fmt.num(c.banned_customers)}  icon={<UserX size={22}/>}         cls="danger" />
        <KPI label="Total Lots"        value={fmt.lots(t.total_lots)}       icon={<TrendingUp size={22}/>}    cls="" mono />
        <KPI label="Total Trades"      value={fmt.num(t.total_trades)}      icon={<TrendingUp size={22}/>}    cls="" />
        <KPI label="Total Deposits"    value={fmt.money(f.total_deposits)}  icon={<DollarSign size={22}/>}    cls="success" mono />
        <KPI label="Total Withdrawals" value={fmt.money(f.total_withdrawals)} icon={<DollarSign size={22}/>}  cls="danger" mono />
      </div>

      {/* ── At Risk row ── */}
      {(parseInt(r.at_risk)+parseInt(r.withdrawn)+parseInt(r.vip_mismatch_in_group)) > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          <RiskBadge label="At Risk"       n={r.at_risk}              color="var(--orange)" />
          <RiskBadge label="Withdrawn"     n={r.withdrawn}            color="var(--red)"    />
          <RiskBadge label="VIP Mismatch"  n={r.vip_mismatch_in_group} color="var(--purple)" />
          <RiskBadge label="On Watchlist"  n={r.on_watchlist}         color="var(--blue)"   />
          <RiskBadge label="Open Cases"    n={r.open_cases}           color="var(--accent)" />
          <RiskBadge label="Open Alerts"   n={r.open_alerts}          color="var(--red)"    />
        </div>
      )}

      {/* ── Daily panel ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="flex items-center justify-between mb-4">
          <div className="card-title">Day View</div>
          <input
            type="date"
            className="input"
            style={{ width: 160 }}
            value={selDate}
            max={dayjs().format('YYYY-MM-DD')}
            onChange={e => setSelDate(e.target.value)}
          />
        </div>
        <div className="kpi-grid">
          <KPI label="Lots Today"        value={fmt.lots(daily?.lots)}         cls="" mono />
          <KPI label="Trades Today"      value={fmt.num(daily?.trades)}        cls="" />
          <KPI label="Deposits Today"    value={fmt.money(daily?.deposits)}    cls="success" mono />
          <KPI label="Withdrawals Today" value={fmt.money(daily?.withdrawals)} cls="danger" mono />
          <KPI label="New Users Today"   value={fmt.num(daily?.newUsers)}      cls="info" />
        </div>
      </div>

      {/* ── Charts ── */}
      <div className="grid-2" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-title">Active Customers – 30d</div>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={charts?.activeCustomers || []} margin={{ top: 4, right: 0, left: -30, bottom: 0 }}>
              <defs>
                <linearGradient id="gradActive" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="var(--accent)" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="var(--accent)" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={d => dayjs(d).format('DD.MM')} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={d => dayjs(d).format('DD.MM.YYYY')} />
              <Area type="monotone" dataKey="active_users" stroke="var(--accent)" fill="url(#gradActive)" strokeWidth={2} dot={false} name="Active" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <div className="card-title">Deposits vs Withdrawals – 30d</div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={charts?.fundingOverTime || []} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={d => dayjs(d).format('DD.MM')} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="deposits"    fill="var(--green)" radius={[2,2,0,0]} name="Deposits"    maxBarSize={20} />
              <Bar dataKey="withdrawals" fill="var(--red)"   radius={[2,2,0,0]} name="Withdrawals" maxBarSize={20} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <div className="card-title">Trading Lots – 30d</div>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={charts?.tradingActivity || []} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="gradLots" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="var(--blue)" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="var(--blue)" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={d => dayjs(d).format('DD.MM')} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Area type="monotone" dataKey="lots" stroke="var(--blue)" fill="url(#gradLots)" strokeWidth={2} dot={false} name="Lots" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <div className="card-title">Banned Over Time – 30d</div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={charts?.bannedOverTime || []} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={d => dayjs(d).format('DD.MM')} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="newly_banned" fill="var(--red)" radius={[2,2,0,0]} name="Banned" maxBarSize={20} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Alerts ── */}
      {alerts.length > 0 && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 14 }}>
            Open Alerts ({alerts.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {alerts.slice(0, 10).map(a => (
              <div key={a.id} className="flex items-center gap-3" style={{
                background: 'var(--bg-elevated)', borderRadius: 8, padding: '10px 14px',
                border: '1px solid var(--border)'
              }}>
                <AlertTriangle size={14} style={{ color: 'var(--orange)', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13 }}>{a.title}</div>
                  <div className="text-muted">{a.first_name} {a.last_name} · {fmt.relative(a.created_at)}</div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => handleResolveAlert(a.id)}>Resolve</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function KPI({ label, value, icon, cls, mono }) {
  return (
    <div className={`kpi-card ${cls}`}>
      {icon && <div className="kpi-icon">{icon}</div>}
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${mono ? 'mono' : ''}`}>{value ?? '—'}</div>
    </div>
  );
}

function RiskBadge({ label, n, color }) {
  if (!n || parseInt(n) === 0) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-surface)',
      border: `1px solid ${color}30`, borderRadius: 8, padding: '7px 12px', cursor: 'default',
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
      <span style={{ fontSize: 12, fontWeight: 600, color }}>{n}</span>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
    </div>
  );
}
