// ── Logs Page ─────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';
import { getLogs } from '../services/api';
import { fmt } from '../utils/helpers';
import toast from 'react-hot-toast';

export function Logs() {
  const [data, setData]       = useState({ logs: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [logType, setLogType] = useState('');
  const [page, setPage]       = useState(1);

  const load = async () => {
    setLoading(true);
    try {
      const params = { page, limit: 100 };
      if (logType) params.log_type = logType;
      setData(await getLogs(params));
    } catch { toast.error('Failed to load logs'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [page, logType]);

  const LOG_TYPE_COLORS = {
    admin:       'badge-yellow',
    system:      'badge-blue',
    rule:        'badge-purple',
    integration: 'badge-green',
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Audit Logs</h1>
          <p className="page-subtitle">{data.total.toLocaleString()} total entries</p>
        </div>
        <select className="select" style={{ width: 180 }} value={logType} onChange={e => setLogType(e.target.value)}>
          <option value="">All types</option>
          <option value="admin">Admin</option>
          <option value="system">System</option>
          <option value="rule">Rule</option>
          <option value="integration">Integration</option>
        </select>
      </div>

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Time</th><th>Type</th><th>Action</th>
              <th>Actor</th><th>Target</th><th>Description</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ textAlign:'center', padding:32 }}>
                <div className="spinner" style={{ margin:'0 auto' }} />
              </td></tr>
            ) : data.logs.map(l => (
              <tr key={l.id}>
                <td style={{ fontSize: 11, color:'var(--text-muted)', whiteSpace:'nowrap' }}>
                  {fmt.datetime(l.created_at)}
                </td>
                <td>
                  <span className={`badge ${LOG_TYPE_COLORS[l.log_type] || 'badge-gray'}`}>{l.log_type}</span>
                </td>
                <td className="mono" style={{ fontSize: 11 }}>{l.action}</td>
                <td style={{ fontSize: 12 }}>{l.actor_name || l.actor_id}</td>
                <td style={{ fontSize: 11, color:'var(--text-muted)' }}>
                  {l.target_type && <span>{l.target_type}: </span>}
                  <span>{l.target_name || l.target_id}</span>
                </td>
                <td style={{ fontSize: 12, color:'var(--text-muted)', maxWidth: 300 }} className="truncate">
                  {l.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.total > 100 && (
        <div className="flex items-center justify-between mt-4" style={{ color:'var(--text-muted)', fontSize:12 }}>
          <span>Page {page} · {data.total} total</span>
          <div className="flex gap-2">
            <button className="btn btn-secondary btn-sm" disabled={page<=1} onClick={() => setPage(p=>p-1)}>← Prev</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setPage(p=>p+1)}>Next →</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Integrations Page ─────────────────────────────────────────
import { getIntegrations, updateIntegration, triggerSync } from '../services/api';
import { Plug, RefreshCw, Check, X } from 'lucide-react';

export function Integrations() {
  const [integrations, setIntegrations] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [syncing, setSyncing]           = useState({});

  const load = async () => {
    setLoading(true);
    try { setIntegrations(await getIntegrations()); }
    catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleToggle = async (id, current) => {
    await updateIntegration(id, { is_active: !current });
    toast.success(!current ? 'Integration activated' : 'Integration deactivated');
    load();
  };

  const handleSync = async (type) => {
    setSyncing(s => ({...s, [type]: true}));
    try {
      const result = await triggerSync(type, {});
      toast.success(`Sync complete: ${JSON.stringify(result)}`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Sync failed');
    } finally {
      setSyncing(s => ({...s, [type]: false}));
    }
  };

  const TYPE_ICONS = {
    kommo:           '🟦',
    google_sheets:   '🟩',
    notion:          '⬜',
    custom_webhook:  '🔗',
    python_middleware:'🐍',
    telegram:        '✈️',
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Integrations</h1>
          <p className="page-subtitle">Connected systems and sync status</p>
        </div>
      </div>

      {loading ? <div className="spinner" style={{ margin: '48px auto' }} /> : (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {integrations.map(int => (
            <div key={int.id} className="card">
              <div className="flex items-center gap-3">
                <span style={{ fontSize: 22 }}>{TYPE_ICONS[int.type] || '🔧'}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{int.name}</div>
                  <div className="text-muted">{int.type} · {int.mapped_users} users mapped · Last sync: {fmt.relative(int.last_sync_at)}</div>
                  {int.last_error && <div className="text-danger" style={{ fontSize: 11, marginTop: 4 }}>{int.last_error}</div>}
                </div>
                <div className="flex gap-2 items-center">
                  {['tauro','sheets'].includes(int.type) && (
                    <button className="btn btn-secondary btn-sm" onClick={() => handleSync(int.type === 'google_sheets' ? 'sheets' : 'tauro')} disabled={syncing[int.type]}>
                      <RefreshCw size={12} /> {syncing[int.type] ? 'Syncing…' : 'Sync Now'}
                    </button>
                  )}
                  <button
                    className={`btn btn-sm ${int.is_active ? 'btn-danger' : 'btn-primary'}`}
                    onClick={() => handleToggle(int.id, int.is_active)}
                  >
                    {int.is_active ? <><X size={12}/> Disable</> : <><Check size={12}/> Enable</>}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Manual sync panel */}
      <div className="card mt-6">
        <div className="card-title">Manual Sync Triggers</div>
        <div className="flex gap-3 mt-2">
          <button className="btn btn-secondary" onClick={() => handleSync('tauro')} disabled={syncing['tauro']}>
            <RefreshCw size={13}/> Sync Tauro Structure
          </button>
          <button className="btn btn-secondary" onClick={() => handleSync('sheets')} disabled={syncing['sheets']}>
            <RefreshCw size={13}/> Export to Google Sheets
          </button>
        </div>
      </div>
    </div>
  );
}
