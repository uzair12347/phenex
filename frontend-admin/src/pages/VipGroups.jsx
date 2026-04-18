import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Users, Link, RefreshCw, ExternalLink, Send, RotateCcw } from 'lucide-react';
import axios from 'axios';
import { fmt } from '../utils/helpers';
import toast from 'react-hot-toast';
import dayjs from 'dayjs';

const api = axios.create({ baseURL: '/api' });
api.interceptors.request.use(cfg => {
  const t = localStorage.getItem('phenex_token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

export default function VipGroups() {
  const [groups, setGroups]       = useState([]);
  const [selected, setSelected]   = useState(null);
  const [members, setMembers]     = useState(null);
  const [pending, setPending]     = useState(null);
  const [backsyncs, setBacksyncs] = useState([]);
  const [tab, setTab]             = useState('overview');
  const [loading, setLoading]     = useState(true);
  const [createModal, setCreateModal] = useState(false);
  const [inviteModal, setInviteModal] = useState(null); // group
  const [inviteUserId, setInviteUserId] = useState('');
  const [newGroup, setNewGroup]   = useState({
    name: '', telegram_group_id: '', telegram_name: '',
    brand: '', invite_expiry_hours: 24, group_type: 'supergroup',
  });

  const load = async () => {
    setLoading(true);
    try {
      const [gr, bs] = await Promise.all([
        api.get('/vip-groups').then(r => r.data),
        api.get('/vip-groups/backsyncs?status=pending').then(r => r.data),
      ]);
      setGroups(gr); setBacksyncs(bs);
    } catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  const loadGroupDetail = async (groupId) => {
    const [m, p] = await Promise.all([
      api.get(`/vip-groups/${groupId}/members`).then(r => r.data),
      api.get(`/vip-groups/${groupId}/pending`).then(r => r.data),
    ]);
    setMembers(m); setPending(p);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (selected) loadGroupDetail(selected.id);
  }, [selected]);

  const handleCreateGroup = async () => {
    if (!newGroup.name || !newGroup.telegram_group_id) { toast.error('Name and Telegram Group ID required'); return; }
    try {
      await api.post('/vip-groups', newGroup);
      toast.success('VIP Group created');
      setCreateModal(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const handleToggleGroup = async (group) => {
    await api.patch(`/vip-groups/${group.id}`, { is_active: !group.is_active });
    toast.success(group.is_active ? 'Group deactivated' : 'Group activated');
    load();
  };

  const handleSendInvite = async () => {
    if (!inviteUserId.trim()) { toast.error('User ID required'); return; }
    try {
      const r = await api.post(`/vip-groups/${inviteModal.id}/invite`, { user_id: inviteUserId, send: true });
      toast.success('Invite link generated and sent!');
      setInviteModal(null); setInviteUserId(''); loadGroupDetail(inviteModal.id);
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const handleRetryBacksyncs = async (groupId) => {
    await api.post(`/vip-groups/${groupId}/backsync/retry`);
    toast.success('Backsync retry queued');
    load();
  };

  const INVITE_STATUS_COLORS = {
    created:  'badge-blue',
    sent:     'badge-yellow',
    redeemed: 'badge-green',
    expired:  'badge-gray',
    revoked:  'badge-red',
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">VIP Groups CRM</h1>
          <p className="page-subtitle">Manage Telegram VIP groups, invite links, and join tracking</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreateModal(true)}>
          <Plus size={14}/> Add Group
        </button>
      </div>

      {/* Pending backsyncs banner */}
      {backsyncs.length > 0 && (
        <div style={{
          background: 'var(--orange-dim)', border: '1px solid var(--orange)',
          borderRadius: 8, padding: '10px 16px', marginBottom: 16,
          display: 'flex', alignItems: 'center', gap: 12, fontSize: 13,
        }}>
          <span style={{ color: 'var(--orange)' }}>⚠</span>
          <span style={{ flex: 1 }}><strong>{backsyncs.length}</strong> pending CRM backsync events</span>
          <button className="btn btn-secondary btn-sm" onClick={() => api.post('/vip-groups/backsyncs/retry-all').then(() => load())}>
            <RotateCcw size={12}/> Retry All
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '340px 1fr' : '1fr', gap: 16 }}>
        {/* Groups list */}
        <div>
          {loading ? <div className="spinner" style={{ margin: '48px auto' }} /> :
          groups.length === 0 ? (
            <div className="empty-state"><p>No VIP groups yet. Add your first group.</p></div>
          ) : groups.map(g => (
            <div key={g.id}
              className="card"
              style={{
                marginBottom: 10, cursor: 'pointer',
                borderColor: selected?.id === g.id ? 'var(--accent)' : undefined,
                opacity: g.is_active ? 1 : 0.5,
              }}
              onClick={() => setSelected(g)}
            >
              <div className="flex items-center justify-between mb-2">
                <div style={{ fontWeight: 600, fontSize: 14 }}>{g.name}</div>
                <span className={`badge ${g.is_active ? 'badge-green' : 'badge-gray'}`}>
                  {g.is_active ? 'Active' : 'Paused'}
                </span>
              </div>
              <div className="text-muted mono" style={{ fontSize: 11, marginBottom: 8 }}>
                {g.telegram_group_id}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                {[
                  { label: 'Members', value: g.total_members || 0 },
                  { label: 'Invites', value: g.total_invites_sent || 0 },
                  { label: 'Redeemed', value: g.total_invites_redeemed || 0 },
                ].map(s => (
                  <div key={s.label} style={{ textAlign: 'center', background: 'var(--bg-elevated)', borderRadius: 6, padding: '6px 4px' }}>
                    <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-display)' }}>{s.value}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.label}</div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 mt-2">
                <button className="btn btn-primary btn-sm" style={{ flex: 1 }}
                  onClick={e => { e.stopPropagation(); setInviteModal(g); setInviteUserId(''); }}>
                  <Send size={12}/> Send Invite
                </button>
                <button className="btn btn-secondary btn-sm btn-icon"
                  onClick={e => { e.stopPropagation(); handleToggleGroup(g); }}>
                  {g.is_active ? '⏸' : '▶'}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Group detail panel */}
        {selected && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{selected.name}</div>
                <div className="text-muted">{selected.brand && `${selected.brand} · `}{selected.telegram_name}</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button>
            </div>

            <div className="tabs">
              {['members','pending','backsyncs'].map(t => (
                <div key={t} className={`tab ${tab===t?'active':''}`} onClick={() => setTab(t)} style={{ textTransform: 'capitalize' }}>{t}</div>
              ))}
            </div>

            {tab === 'members' && members && (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr><th>User</th><th>Telegram</th><th>Joined</th><th>Invite</th><th>Backsync</th></tr>
                  </thead>
                  <tbody>
                    {members.members.map(m => (
                      <tr key={m.id}>
                        <td>
                          <div style={{ fontWeight: 500 }}>{m.first_name} {m.last_name}</div>
                          <div className="text-muted">{m.email}</div>
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {m.telegram_username ? `@${m.telegram_username}` : String(m.telegram_user_id)}
                        </td>
                        <td style={{ fontSize: 12 }}>{fmt.datetime(m.joined_at)}</td>
                        <td>
                          <span className={`badge ${INVITE_STATUS_COLORS[m.invite_status] || 'badge-gray'}`}>
                            {m.invite_status || '—'}
                          </span>
                        </td>
                        <td>
                          <span className={`badge ${m.backsync_status === 'confirmed' ? 'badge-green' : m.backsync_status === 'failed' ? 'badge-red' : 'badge-gray'}`}>
                            {m.backsync_status || 'pending'}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {members.members.length === 0 && (
                      <tr><td colSpan={5}><div className="empty-state"><p>No members yet</p></div></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'pending' && pending && (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr><th>User</th><th>Link Status</th><th>Created</th><th>Sent</th><th>Expires</th></tr>
                  </thead>
                  <tbody>
                    {pending.map(p => (
                      <tr key={p.id}>
                        <td>
                          <div>{p.first_name} {p.last_name}</div>
                          <div className="text-muted mono" style={{ fontSize: 11 }}>{p.email}</div>
                        </td>
                        <td><span className={`badge ${INVITE_STATUS_COLORS[p.status] || 'badge-gray'}`}>{p.status}</span></td>
                        <td style={{ fontSize: 12 }}>{fmt.datetime(p.created_at)}</td>
                        <td style={{ fontSize: 12 }}>{p.sent_at ? fmt.datetime(p.sent_at) : '—'}</td>
                        <td style={{ fontSize: 12, color: new Date(p.expires_at) < new Date() ? 'var(--red)' : undefined }}>
                          {fmt.datetime(p.expires_at)}
                        </td>
                      </tr>
                    ))}
                    {pending.length === 0 && (
                      <tr><td colSpan={5}><div className="empty-state"><p>No pending invites</p></div></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'backsyncs' && (
              <div>
                <div className="flex justify-between items-center mb-3">
                  <span className="text-muted">CRM backsync events for this group</span>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleRetryBacksyncs(selected.id)}>
                    <RotateCcw size={12}/> Retry Failed
                  </button>
                </div>
                {/* Show backsyncs filtered for this group */}
                {backsyncs.filter(b => b.vip_group_id === selected.id).length === 0
                  ? <div className="empty-state"><p>No backsync events for this group</p></div>
                  : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {backsyncs.filter(b => b.vip_group_id === selected.id).map(b => (
                        <div key={b.id} className="card card-sm">
                          <div className="flex items-center gap-3">
                            <div style={{ flex: 1 }}>
                              <span className={`badge ${b.status==='confirmed'?'badge-green':b.status==='failed'?'badge-red':'badge-yellow'}`}>{b.status}</span>
                              <span style={{ fontSize: 12, marginLeft: 8 }}>{b.source_name}</span>
                            </div>
                            <div className="text-muted">{fmt.relative(b.created_at)}</div>
                          </div>
                          {b.last_error && <div className="text-danger" style={{ fontSize: 11, marginTop: 6 }}>{b.last_error}</div>}
                        </div>
                      ))}
                    </div>
                }
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create group modal */}
      {createModal && (
        <div className="modal-backdrop" onClick={() => setCreateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Add VIP Group</span>
              <button className="btn btn-ghost btn-icon" onClick={() => setCreateModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              {[
                { k: 'name', label: 'Internal Name *', placeholder: 'Signals DE VIP' },
                { k: 'telegram_group_id', label: 'Telegram Group ID *', placeholder: '-100xxxxxxxxx' },
                { k: 'telegram_name', label: 'Telegram Display Name', placeholder: 'Optional' },
                { k: 'brand', label: 'Brand', placeholder: 'Phenex' },
              ].map(f => (
                <div className="form-field" key={f.k}>
                  <label className="form-label">{f.label}</label>
                  <input className="input" placeholder={f.placeholder} value={newGroup[f.k] || ''}
                    onChange={e => setNewGroup({...newGroup, [f.k]: e.target.value})} />
                </div>
              ))}
              <div className="form-field">
                <label className="form-label">Invite Link Expiry (hours)</label>
                <input className="input" type="number" value={newGroup.invite_expiry_hours}
                  onChange={e => setNewGroup({...newGroup, invite_expiry_hours: parseInt(e.target.value)})} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setCreateModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreateGroup}>Create Group</button>
            </div>
          </div>
        </div>
      )}

      {/* Send invite modal */}
      {inviteModal && (
        <div className="modal-backdrop" onClick={() => setInviteModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Send Invite – {inviteModal.name}</span>
              <button className="btn btn-ghost btn-icon" onClick={() => setInviteModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-field">
                <label className="form-label">Customer ID (internal UUID)</label>
                <input className="input mono" placeholder="Paste user UUID…"
                  value={inviteUserId} onChange={e => setInviteUserId(e.target.value)} />
              </div>
              <div className="tip">
                A unique Telegram invite link will be generated and sent directly to the user via the bot. The link is one-time use and expires in {inviteModal.invite_expiry_hours}h.
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setInviteModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSendInvite}><Send size={13}/> Generate & Send</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
