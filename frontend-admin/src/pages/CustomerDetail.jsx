import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { ArrowLeft, RefreshCw, Ban, Unlock, Plus, CheckCircle } from 'lucide-react';
import {
  getCustomer, getCustomerAccounts, getCustomerStats, getCustomerTimeline,
  getCustomerNotes, addCustomerNote, getCustomerTasks, createCustomerTask,
  updateCustomerTask, banCustomer, unbanCustomer, syncCustomer
} from '../services/api';
import { fmt, StatusBadge, ACCOUNT_TYPE_LABELS } from '../utils/helpers';
import toast from 'react-hot-toast';
import dayjs from 'dayjs';

const TP = { backgroundColor:'var(--bg-elevated)', border:'1px solid var(--border)', borderRadius:8, fontSize:12, color:'var(--text-primary)' };

export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [user, setUser]         = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [stats, setStats]       = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [notes, setNotes]       = useState([]);
  const [tasks, setTasks]       = useState([]);
  const [tab, setTab]           = useState('overview');
  const [loading, setLoading]   = useState(true);
  const [banModal, setBanModal] = useState(null);
  const [banReason, setBanReason] = useState('');
  const [noteText, setNoteText]   = useState('');
  const [newTask, setNewTask]     = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [u, acc, st, tl, n, tk] = await Promise.all([
        getCustomer(id),
        getCustomerAccounts(id),
        getCustomerStats(id),
        getCustomerTimeline(id, { limit: 50 }),
        getCustomerNotes(id),
        getCustomerTasks(id),
      ]);
      setUser(u); setAccounts(acc); setStats(st);
      setTimeline(tl); setNotes(n); setTasks(tk);
    } catch { toast.error('Failed to load customer'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [id]);

  const handleSync = async () => {
    try { await syncCustomer(id); toast.success('Synced'); load(); }
    catch { toast.error('Sync failed'); }
  };

  const handleBanAction = async () => {
    if (!banReason.trim()) { toast.error('Reason required'); return; }
    try {
      if (banModal === 'ban') await banCustomer(id, { ban_type: 'hard', reason: banReason });
      else await unbanCustomer(id, { reason: banReason });
      toast.success(banModal === 'ban' ? 'Customer banned' : 'Customer unbanned');
      setBanModal(null); setBanReason(''); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    await addCustomerNote(id, { content: noteText }); setNoteText(''); load();
    toast.success('Note added');
  };

  const handleCreateTask = async () => {
    if (!newTask?.title) return;
    await createCustomerTask(id, newTask); setNewTask(null); load();
    toast.success('Task created');
  };

  const handleCompleteTask = async (taskId) => {
    await updateCustomerTask(id, taskId, { status: 'done' }); load();
    toast.success('Task completed');
  };

  if (loading) return <div className="flex items-center" style={{ height: 200, justifyContent: 'center' }}><div className="spinner" /></div>;
  if (!user) return <div className="empty-state"><p>Customer not found</p></div>;

  const s = stats?.summary || {};

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <div className="flex items-center gap-3">
          <button className="btn btn-ghost btn-icon" onClick={() => navigate(-1)}><ArrowLeft size={16}/></button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="page-title">{user.first_name} {user.last_name}</h1>
              <StatusBadge status={user.status} />
              {user.vip_member && <span className="badge badge-yellow">VIP</span>}
              {user.is_banned  && <span className="badge badge-red">Banned</span>}
            </div>
            <p className="page-subtitle">{user.email} · @{user.telegram_username} · Tauro: {user.tauro_client_id}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary btn-sm" onClick={handleSync}><RefreshCw size={13}/> Sync</button>
          {user.is_banned
            ? <button className="btn btn-secondary btn-sm" onClick={() => { setBanModal('unban'); setBanReason(''); }}>
                <Unlock size={13}/> Unban
              </button>
            : <button className="btn btn-danger btn-sm" onClick={() => { setBanModal('ban'); setBanReason(''); }}>
                <Ban size={13}/> Ban
              </button>
          }
        </div>
      </div>

      {/* Top KPIs */}
      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        <div className="kpi-card"><div className="kpi-label">Total Balance</div><div className="kpi-value mono" style={{ fontSize: 18 }}>{fmt.money(parseFloat(s.total_balance||0))}</div></div>
        <div className="kpi-card"><div className="kpi-label">Total Deposits</div><div className="kpi-value mono" style={{ fontSize: 18 }}>{fmt.money(s.total_deposits)}</div></div>
        <div className="kpi-card"><div className="kpi-label">Total Withdrawals</div><div className="kpi-value mono" style={{ fontSize: 18 }}>{fmt.money(s.total_withdrawals)}</div></div>
        <div className="kpi-card"><div className="kpi-label">Total Profit</div><div className={`kpi-value mono`} style={{ fontSize: 18, color: parseFloat(s.total_profit||0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt.money(s.total_profit)}</div></div>
        <div className="kpi-card"><div className="kpi-label">Total Trades</div><div className="kpi-value">{fmt.num(s.total_trades)}</div></div>
        <div className="kpi-card"><div className="kpi-label">Total Lots</div><div className="kpi-value mono" style={{ fontSize: 18 }}>{fmt.lots(s.total_lots)}</div></div>
        <div className="kpi-card"><div className="kpi-label">Accounts</div><div className="kpi-value">{fmt.num(s.account_count)}</div></div>
        <div className="kpi-card"><div className="kpi-label">Last Trade</div><div className="kpi-value" style={{ fontSize: 14 }}>{fmt.relative(s.last_trade_at)}</div></div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {['overview','accounts','charts','timeline','notes','tasks'].map(t => (
          <div key={t} className={`tab ${tab===t?'active':''}`} onClick={() => setTab(t)} style={{ textTransform: 'capitalize' }}>{t}</div>
        ))}
      </div>

      {/* Overview */}
      {tab === 'overview' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-title">Identity</div>
            <InfoRow label="Telegram ID"   value={user.telegram_id} mono />
            <InfoRow label="Username"      value={user.telegram_username ? `@${user.telegram_username}` : null} />
            <InfoRow label="Email"         value={user.email} />
            <InfoRow label="Tauro Client"  value={user.tauro_client_id} mono />
            <InfoRow label="Structure"     value={user.structure_id} mono />
            <InfoRow label="Broker Verified" value={user.broker_verified ? 'Yes' : 'No'} />
            <InfoRow label="In VIP Group"  value={user.in_telegram_group ? 'Yes' : 'No'} />
            <InfoRow label="Registered"    value={fmt.datetime(user.registered_at)} />
            <InfoRow label="Last Sync"     value={fmt.relative(user.last_synced_at)} />
          </div>
          <div className="card">
            <div className="card-title">Status & Segment</div>
            <InfoRow label="Status"   value={<StatusBadge status={user.status}/>} />
            <InfoRow label="Segment"  value={user.segment || '—'} />
            <InfoRow label="Risk Score" value={user.risk_score} />
            <InfoRow label="Watchlist"  value={user.watchlist ? 'Yes' : 'No'} />
            <InfoRow label="Tags"       value={user.tags?.join(', ') || '—'} />
            {user.is_banned && <>
              <div className="divider" />
              <InfoRow label="Ban Type"   value={user.ban_type} />
              <InfoRow label="Ban Reason" value={user.ban_reason} />
              <InfoRow label="Banned At"  value={fmt.datetime(user.banned_at)} />
            </>}
            {user.rule_override_no_ban_until && <>
              <div className="divider" />
              <InfoRow label="Override Until" value={fmt.datetime(user.rule_override_no_ban_until)} />
              <InfoRow label="Override Reason" value={user.rule_override_reason} />
            </>}
          </div>
        </div>
      )}

      {/* Accounts */}
      {tab === 'accounts' && (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Type</th><th>Account #</th><th>Currency</th><th>Balance</th>
                <th>Equity</th><th>Total Deposits</th><th>Total Withdrawals</th>
                <th>Trades</th><th>Lots</th><th>Last Trade</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => (
                <tr key={a.id}>
                  <td><span className="badge badge-blue">{ACCOUNT_TYPE_LABELS[a.account_type] || a.account_type}</span></td>
                  <td className="mono" style={{ fontSize: 12 }}>{a.account_number || a.broker_local_id}</td>
                  <td>{a.currency}</td>
                  <td className="mono">{fmt.money(a.balance, a.currency)}</td>
                  <td className="mono">{fmt.money(a.equity,  a.currency)}</td>
                  <td className="mono">{fmt.money(a.total_deposits,    a.currency)}</td>
                  <td className="mono">{fmt.money(a.total_withdrawals, a.currency)}</td>
                  <td>{fmt.num(a.total_trades)}</td>
                  <td className="mono">{fmt.lots(a.total_lots)}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmt.relative(a.last_trade_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Charts */}
      {tab === 'charts' && stats && (
        <div className="grid-2">
          <div className="card">
            <div className="card-title">Daily Lots – 90d</div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={stats.dailyLots || []} margin={{ left: -25, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={d => dayjs(d).format('DD.MM')} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                <Tooltip contentStyle={TP} />
                <Bar dataKey="lots" fill="var(--accent)" radius={[2,2,0,0]} maxBarSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="card">
            <div className="card-title">Daily Trades – 90d</div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={stats.dailyTrades || []} margin={{ left: -25, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={d => dayjs(d).format('DD.MM')} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                <Tooltip contentStyle={TP} />
                <Bar dataKey="trades" fill="var(--blue)" radius={[2,2,0,0]} maxBarSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="card">
            <div className="card-title">Balance History – 90d</div>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={stats.snapshots || []} margin={{ left: -25, bottom: 0 }}>
                <defs>
                  <linearGradient id="gBal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="var(--green)" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="var(--green)" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="snapshot_date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={d => dayjs(d).format('DD.MM')} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                <Tooltip contentStyle={TP} />
                <Area type="monotone" dataKey="balance" stroke="var(--green)" fill="url(#gBal)" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="card">
            <div className="card-title">Deposits & Withdrawals – 90d</div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={stats.snapshots || []} margin={{ left: -25, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="snapshot_date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={d => dayjs(d).format('DD.MM')} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                <Tooltip contentStyle={TP} />
                <Bar dataKey="deposits"    fill="var(--green)" maxBarSize={14} radius={[2,2,0,0]} />
                <Bar dataKey="withdrawals" fill="var(--red)"   maxBarSize={14} radius={[2,2,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Timeline */}
      {tab === 'timeline' && (
        <div className="card">
          <div className="timeline">
            {timeline.length === 0 && <div className="empty-state"><p>No events yet</p></div>}
            {timeline.map(e => {
              const dotCls = e.event_type.includes('ban') ? 'red' : e.event_type.includes('vip') ? 'green' : '';
              return (
                <div key={e.id} className="timeline-item">
                  <div className={`timeline-dot ${dotCls}`} />
                  <div className="timeline-time">{fmt.datetime(e.created_at)}</div>
                  <div className="timeline-content">
                    <div className="timeline-title">{e.title || e.event_type}</div>
                    {e.description && <div className="timeline-meta">{e.description}</div>}
                    {e.actor_name && <div className="timeline-meta">by {e.actor_name} ({e.actor_type})</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Notes */}
      {tab === 'notes' && (
        <div>
          <div className="card mb-4">
            <div className="card-title">Add Note</div>
            <textarea className="input mt-2" rows={3} placeholder="Write a note…" value={noteText} onChange={e => setNoteText(e.target.value)} />
            <button className="btn btn-primary btn-sm mt-2" onClick={handleAddNote}><Plus size={13}/> Add Note</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {notes.map(n => (
              <div key={n.id} className="card card-sm">
                <div className="flex items-center justify-between mb-2">
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{n.author_name || 'System'}</span>
                  <span className="text-muted">{fmt.datetime(n.created_at)}</span>
                </div>
                <p style={{ fontSize: 13 }}>{n.content}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tasks */}
      {tab === 'tasks' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <div className="page-subtitle">CRM Tasks</div>
            <button className="btn btn-primary btn-sm" onClick={() => setNewTask({ title:'', task_type:'follow_up', description:'' })}>
              <Plus size={13}/> New Task
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {tasks.map(t => (
              <div key={t.id} className="card card-sm flex items-center gap-3" style={{ opacity: t.status==='done' ? 0.5 : 1 }}>
                <button className="btn btn-ghost btn-icon" onClick={() => handleCompleteTask(t.id)}>
                  <CheckCircle size={16} style={{ color: t.status==='done' ? 'var(--green)' : 'var(--border)' }} />
                </button>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{t.title}</div>
                  {t.description && <div className="text-muted">{t.description}</div>}
                </div>
                <div>
                  <span className="badge badge-blue" style={{ fontSize: 10 }}>{t.task_type}</span>
                </div>
                <div className="text-muted">{t.due_at ? fmt.date(t.due_at) : '—'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ban modal */}
      {banModal && (
        <div className="modal-backdrop" onClick={() => setBanModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{banModal==='ban' ? '⛔ Ban Customer' : '✅ Unban Customer'}</span>
              <button className="btn btn-ghost btn-icon" onClick={() => setBanModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-field">
                <label className="form-label">Reason *</label>
                <textarea className="input" rows={3} value={banReason} onChange={e => setBanReason(e.target.value)} placeholder="Enter reason…" />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setBanModal(null)}>Cancel</button>
              <button className={`btn ${banModal==='ban'?'btn-danger':'btn-primary'}`} onClick={handleBanAction}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New task modal */}
      {newTask && (
        <div className="modal-backdrop" onClick={() => setNewTask(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">New Task</span>
              <button className="btn btn-ghost btn-icon" onClick={() => setNewTask(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-field">
                <label className="form-label">Title *</label>
                <input className="input" value={newTask.title} onChange={e => setNewTask({...newTask, title: e.target.value})} placeholder="Task title…" />
              </div>
              <div className="form-field">
                <label className="form-label">Type</label>
                <select className="select" value={newTask.task_type} onChange={e => setNewTask({...newTask, task_type: e.target.value})}>
                  <option value="follow_up">Follow Up</option>
                  <option value="call">Call</option>
                  <option value="check_account">Check Account</option>
                  <option value="reactivation">Reactivation</option>
                  <option value="manual_review">Manual Review</option>
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Description</label>
                <textarea className="input" rows={2} value={newTask.description} onChange={e => setNewTask({...newTask, description: e.target.value})} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setNewTask(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreateTask}>Create Task</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value, mono }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: '7px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 12, fontFamily: mono ? 'var(--font-mono)' : undefined, color: 'var(--text-secondary)', maxWidth: 220, textAlign: 'right' }} className="truncate">
        {value ?? '—'}
      </span>
    </div>
  );
}
