import React, { useState, useEffect } from 'react';
import { Plus, RefreshCw, Eye, ChevronRight, CheckCircle, XCircle, GitMerge } from 'lucide-react';
import axios from 'axios';
import { fmt } from '../utils/helpers';
import toast from 'react-hot-toast';

const api = axios.create({ baseURL: '/api' });
api.interceptors.request.use(cfg => {
  const t = localStorage.getItem('phenex_token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

const SOURCE_TYPES = [
  { value: 'google_sheets',    label: '🟩 Google Sheets',       color: 'badge-green'  },
  { value: 'database',         label: '🗄️ Database (PostgreSQL)', color: 'badge-blue'   },
  { value: 'kommo',            label: '🟦 Kommo CRM',           color: 'badge-blue'   },
  { value: 'notion',           label: '⬜ Notion',              color: 'badge-gray'   },
  { value: 'generic_api',      label: '🔗 Generic REST API',    color: 'badge-purple' },
  { value: 'python_middleware', label: '🐍 Python Middleware',   color: 'badge-orange' },
  { value: 'csv',              label: '📄 CSV Feed',            color: 'badge-gray'   },
];

const INTERNAL_FIELDS = [
  'email','first_name','last_name','telegram_id','telegram_username',
  'tauro_client_id','phone','country','language',
  'net_deposit','gross_deposit','withdrawal','balance','equity',
  'lots_total','trades_total','last_trade_ext','last_deposit_ext',
  'last_withdrawal_ext','ftd_amount','ftd_date',
  'crm_owner','crm_status','pipeline_stage','lead_source','kyc_status',
  'broker_client_id','broker_account_id','structure_id',
];

// ── Data Sources Page ─────────────────────────────────────────

export function DataSources() {
  const [sources, setSources]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [selected, setSelected]     = useState(null);
  const [mappings, setMappings]     = useState([]);
  const [records, setRecords]       = useState(null);
  const [preview, setPreview]       = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [tab, setTab]               = useState('mappings');
  const [createModal, setCreateModal] = useState(false);
  const [newSource, setNewSource]   = useState({ name:'', type:'google_sheets', priority:50, direction:'import_only', sync_interval_min:60, config:{} });

  const load = async () => {
    setLoading(true);
    try { setSources(await api.get('/sources').then(r => r.data)); }
    catch { toast.error('Failed to load sources'); }
    finally { setLoading(false); }
  };

  const loadDetail = async (id) => {
    const [m, r] = await Promise.all([
      api.get(`/sources/${id}/mappings`).then(r => r.data),
      api.get(`/sources/${id}/records?limit=20`).then(r => r.data),
    ]);
    setMappings(m); setRecords(r);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { if (selected) loadDetail(selected.id); }, [selected]);

  const handleSync = async (id) => {
    await api.post(`/sources/${id}/sync`);
    toast.success('Sync started in background');
  };

  const handlePreview = async (id) => {
    setPreviewLoading(true); setPreview(null);
    try {
      const p = await api.post(`/sources/${id}/preview`).then(r => r.data);
      setPreview(p);
    } catch (e) { toast.error(e.response?.data?.error || 'Preview failed'); }
    finally { setPreviewLoading(false); }
  };

  const handleCreate = async () => {
    if (!newSource.name || !newSource.type) { toast.error('Name and type required'); return; }
    try {
      await api.post('/sources', newSource);
      toast.success('Source created');
      setCreateModal(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const saveMappings = async () => {
    await api.put(`/sources/${selected.id}/mappings`, { mappings });
    toast.success('Field mappings saved');
  };

  const addMapping = () => setMappings(prev => [...prev, {
    external_field: '', internal_field: '', data_type: 'string',
    is_required: false, is_matching_field: false, is_backsync_field: false, is_readonly: false,
  }]);

  const updateMapping = (i, k, v) => setMappings(prev =>
    prev.map((m, idx) => idx === i ? { ...m, [k]: v } : m)
  );

  const removeMapping = (i) => setMappings(prev => prev.filter((_, idx) => idx !== i));

  const HEALTH_COLORS = { ok: 'badge-green', degraded: 'badge-orange', error: 'badge-red', unknown: 'badge-gray' };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Data Sources</h1>
          <p className="page-subtitle">Connect external CRMs, databases, and sheets as alternative or fallback data sources</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreateModal(true)}>
          <Plus size={14}/> Add Source
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '300px 1fr' : '1fr', gap: 16 }}>
        {/* Source list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {loading ? <div className="spinner" style={{ margin: '48px auto' }} /> :
          sources.map(s => {
            const typeInfo = SOURCE_TYPES.find(t => t.value === s.type);
            return (
              <div key={s.id} className="card" style={{ cursor:'pointer', borderColor: selected?.id===s.id?'var(--accent)':undefined }}
                onClick={() => setSelected(s)}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`badge ${typeInfo?.color||'badge-gray'}`} style={{ fontSize:10 }}>{typeInfo?.label||s.type}</span>
                  <span className={`badge ${HEALTH_COLORS[s.health_status]||'badge-gray'}`} style={{ fontSize:10 }}>{s.health_status}</span>
                  {!s.is_active && <span className="badge badge-gray" style={{ fontSize:10 }}>Inactive</span>}
                </div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{s.name}</div>
                <div className="text-muted" style={{ fontSize: 11 }}>
                  Priority {s.priority} · {s.total_records||0} records · {s.matched_records||0} matched · {s.pending_review||0} pending
                </div>
                {s.last_sync_at && <div className="text-muted" style={{ fontSize: 11 }}>Last sync: {fmt.relative(s.last_sync_at)}</div>}
                {s.last_error && <div className="text-danger" style={{ fontSize: 11 }}>{s.last_error.slice(0,80)}</div>}
                <div className="flex gap-2 mt-2">
                  <button className="btn btn-secondary btn-sm" style={{ flex:1 }} onClick={e => { e.stopPropagation(); handleSync(s.id); }}>
                    <RefreshCw size={11}/> Sync
                  </button>
                  <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); handlePreview(s.id); setSelected(s); }}>
                    <Eye size={13}/>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Detail panel */}
        {selected && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div style={{ fontWeight: 700, fontSize: 15 }}>{selected.name}</div>
              <button className="btn btn-ghost btn-sm" onClick={() => { setSelected(null); setPreview(null); }}>✕</button>
            </div>

            {preview && (
              <div className="card mb-4" style={{ borderColor: 'var(--accent)' }}>
                <div className="card-title">Sync Preview</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginTop: 8 }}>
                  {[
                    { label: 'Total', value: preview.totalRecords, color: 'var(--text-primary)' },
                    { label: 'New users', value: preview.new, color: 'var(--green)' },
                    { label: 'Updates', value: preview.update, color: 'var(--accent)' },
                    { label: 'For review', value: preview.review, color: 'var(--orange)' },
                  ].map(s => (
                    <div key={s.label} style={{ textAlign:'center', background:'var(--bg-elevated)', borderRadius:8, padding:'10px 4px' }}>
                      <div style={{ fontSize:20, fontWeight:700, color:s.color }}>{s.value}</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)' }}>{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {previewLoading && <div className="card mb-4" style={{ textAlign:'center', padding:24 }}><div className="spinner" style={{ margin:'0 auto' }}/><div className="text-muted mt-2">Fetching preview…</div></div>}

            <div className="tabs">
              {['mappings','records'].map(t => (
                <div key={t} className={`tab ${tab===t?'active':''}`} onClick={() => setTab(t)} style={{ textTransform:'capitalize' }}>{t}</div>
              ))}
            </div>

            {tab === 'mappings' && (
              <div>
                <div className="flex justify-between items-center mb-3">
                  <span className="text-muted">Map external field names to internal fields</span>
                  <div className="flex gap-2">
                    <button className="btn btn-secondary btn-sm" onClick={addMapping}><Plus size={12}/> Add</button>
                    <button className="btn btn-primary btn-sm" onClick={saveMappings}>Save Mappings</button>
                  </div>
                </div>
                {mappings.map((m, i) => (
                  <div key={i} style={{
                    display:'grid', gridTemplateColumns:'1fr 1fr 80px auto',
                    gap:8, alignItems:'center', marginBottom:8,
                    background:'var(--bg-elevated)', borderRadius:8, padding:'8px 10px',
                    border:'1px solid var(--border)',
                  }}>
                    <input className="input" style={{ fontSize:12 }} placeholder="External field name…"
                      value={m.external_field} onChange={e => updateMapping(i,'external_field',e.target.value)} />
                    <select className="select" style={{ fontSize:12 }} value={m.internal_field}
                      onChange={e => updateMapping(i,'internal_field',e.target.value)}>
                      <option value="">Select internal field…</option>
                      {INTERNAL_FIELDS.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                    <select className="select" style={{ fontSize:11 }} value={m.data_type||'string'}
                      onChange={e => updateMapping(i,'data_type',e.target.value)}>
                      <option value="string">string</option>
                      <option value="integer">integer</option>
                      <option value="decimal">decimal</option>
                      <option value="boolean">boolean</option>
                      <option value="datetime">datetime</option>
                    </select>
                    <div className="flex gap-1 items-center">
                      <button className={`btn btn-sm btn-icon ${m.is_matching_field?'btn-primary':''}`} title="Use for identity matching"
                        onClick={() => updateMapping(i,'is_matching_field',!m.is_matching_field)} style={{ fontSize:10 }}>M</button>
                      <button className={`btn btn-sm btn-icon ${m.is_backsync_field?'btn-primary':''}`} title="Backsync this field"
                        onClick={() => updateMapping(i,'is_backsync_field',!m.is_backsync_field)} style={{ fontSize:10 }}>B</button>
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={() => removeMapping(i)} style={{ color:'var(--red)' }}>✕</button>
                    </div>
                  </div>
                ))}
                {mappings.length === 0 && (
                  <div className="empty-state"><p>No field mappings yet. Add mappings to tell the system how to read this source.</p></div>
                )}
                <div className="tip mt-4">
                  <strong>M</strong> = matching field (used for identity resolution) · <strong>B</strong> = backsync (written back to source when events happen)
                </div>
              </div>
            )}

            {tab === 'records' && records && (
              <div>
                <div className="text-muted mb-3">{records.total} total records imported from this source</div>
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr><th>External ID</th><th>Matched User</th><th>Status</th><th>Score</th><th>Imported</th></tr>
                    </thead>
                    <tbody>
                      {records.records.map(r => (
                        <tr key={r.id}>
                          <td className="mono" style={{ fontSize:11 }}>{r.external_id}</td>
                          <td style={{ fontSize:12 }}>
                            {r.first_name ? `${r.first_name} ${r.last_name||''}` : <span className="text-muted">—</span>}
                            {r.email && <div className="text-muted" style={{ fontSize:11 }}>{r.email}</div>}
                          </td>
                          <td>
                            <span className={`badge ${r.match_status==='matched'?'badge-green':r.match_status==='pending_review'?'badge-orange':r.match_status==='ignored'?'badge-gray':'badge-blue'}`}>
                              {r.match_status}
                            </span>
                          </td>
                          <td className="mono" style={{ fontSize:12 }}>{r.match_score ?? '—'}</td>
                          <td style={{ fontSize:11, color:'var(--text-muted)' }}>{fmt.relative(r.imported_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create source modal */}
      {createModal && (
        <div className="modal-backdrop" onClick={() => setCreateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Add Data Source</span>
              <button className="btn btn-ghost btn-icon" onClick={() => setCreateModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-field">
                <label className="form-label">Name *</label>
                <input className="input" placeholder="My Google Sheet – VIP Master" value={newSource.name}
                  onChange={e => setNewSource({...newSource, name: e.target.value})} />
              </div>
              <div className="form-field">
                <label className="form-label">Type *</label>
                <select className="select" value={newSource.type} onChange={e => setNewSource({...newSource, type: e.target.value})}>
                  {SOURCE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div className="grid-2">
                <div className="form-field">
                  <label className="form-label">Priority</label>
                  <input type="number" className="input" value={newSource.priority}
                    onChange={e => setNewSource({...newSource, priority: parseInt(e.target.value)})} />
                </div>
                <div className="form-field">
                  <label className="form-label">Direction</label>
                  <select className="select" value={newSource.direction}
                    onChange={e => setNewSource({...newSource, direction: e.target.value})}>
                    <option value="import_only">Import only</option>
                    <option value="bidirectional">Bidirectional</option>
                    <option value="export_only">Export only</option>
                  </select>
                </div>
              </div>
              <div className="form-field">
                <label className="form-label">Sync interval (minutes)</label>
                <input type="number" className="input" value={newSource.sync_interval_min}
                  onChange={e => setNewSource({...newSource, sync_interval_min: parseInt(e.target.value)})} />
              </div>
              <div className="tip">After creating, go to the source detail and configure connection settings (API keys, sheet IDs, etc.) and field mappings.</div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setCreateModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate}>Create Source</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Matching Queue Page ───────────────────────────────────────

export function MatchingQueue() {
  const [queue, setQueue]   = useState({ queue: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [resolveModal, setResolveModal] = useState(null);
  const [resolution, setResolution] = useState('linked');
  const [userId, setUserId] = useState('');
  const [notes, setNotes]   = useState('');

  const load = async () => {
    setLoading(true);
    try { setQueue(await api.get('/matching-queue').then(r => r.data)); }
    catch { toast.error('Failed to load queue'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleResolve = async () => {
    if (resolution === 'linked' && !userId.trim()) { toast.error('User ID required for linking'); return; }
    try {
      await api.post(`/matching-queue/${resolveModal.id}/resolve`, { resolution, user_id: userId||undefined, notes });
      toast.success('Match resolved');
      setResolveModal(null); setUserId(''); setNotes(''); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Matching Queue</h1>
          <p className="page-subtitle">{queue.total} records need manual identity review</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}><RefreshCw size={13}/> Refresh</button>
      </div>

      {loading ? <div className="spinner" style={{ margin:'48px auto' }}/> :
      queue.total === 0 ? (
        <div className="empty-state">
          <CheckCircle size={32} style={{ color: 'var(--green)', opacity:0.5 }}/>
          <p>No records pending review. All imports are matched.</p>
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr><th>Source</th><th>Record Data</th><th>Top Candidate</th><th>Score</th><th>Reasons</th><th>Action</th></tr>
            </thead>
            <tbody>
              {queue.queue.map(item => (
                <tr key={item.id}>
                  <td style={{ fontSize:12 }}>{item.source_name}</td>
                  <td>
                    <div style={{ fontSize:12 }}>
                      {item.mapped_data?.email || item.mapped_data?.first_name || 'Unknown'}
                    </div>
                    {item.mapped_data?.telegram_username && (
                      <div className="text-muted">@{item.mapped_data.telegram_username}</div>
                    )}
                  </td>
                  <td style={{ fontSize:12 }}>
                    {item.first_name ? `${item.first_name} ${item.last_name||''}` : <span className="text-muted">No candidate</span>}
                    {item.top_candidate_email && <div className="text-muted" style={{ fontSize:11 }}>{item.top_candidate_email}</div>}
                  </td>
                  <td>
                    <span className={`badge ${item.top_score>=60?'badge-green':item.top_score>=40?'badge-yellow':'badge-red'}`}>
                      {item.top_score ?? 0}
                    </span>
                  </td>
                  <td style={{ fontSize:11, color:'var(--text-muted)' }}>
                    {(item.candidate_user_ids?.[0]?.reasons||[]).join(', ')}
                  </td>
                  <td>
                    <button className="btn btn-primary btn-sm" onClick={() => {
                      setResolveModal(item);
                      setUserId(item.top_candidate_id||'');
                      setResolution(item.top_candidate_id?'linked':'new_user');
                      setNotes('');
                    }}>
                      <GitMerge size={12}/> Resolve
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {resolveModal && (
        <div className="modal-backdrop" onClick={() => setResolveModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Resolve Identity Match</span>
              <button className="btn btn-ghost btn-icon" onClick={() => setResolveModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-field">
                <label className="form-label">Resolution</label>
                <select className="select" value={resolution} onChange={e => setResolution(e.target.value)}>
                  <option value="linked">Link to existing user</option>
                  <option value="new_user">Create as new user</option>
                  <option value="ignored">Ignore this record</option>
                </select>
              </div>
              {resolution === 'linked' && (
                <div className="form-field">
                  <label className="form-label">User UUID to link to</label>
                  <input className="input mono" value={userId} onChange={e => setUserId(e.target.value)}
                    placeholder="User UUID…" />
                  {resolveModal.top_candidate_id && (
                    <div className="tip mt-2">
                      Top candidate: {resolveModal.first_name} {resolveModal.last_name} (score: {resolveModal.top_score})
                    </div>
                  )}
                </div>
              )}
              <div className="form-field">
                <label className="form-label">Notes (optional)</label>
                <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Reason for this resolution…" />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setResolveModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleResolve}>Confirm Resolution</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
