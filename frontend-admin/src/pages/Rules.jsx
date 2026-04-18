import React, { useState, useEffect } from 'react';
import { Plus, Play, Trash2, ToggleLeft, ToggleRight, FlaskConical, Zap } from 'lucide-react';
import { getRules, createRule, toggleRule, deleteRule, runRule, dryRunRule } from '../services/api';
import { fmt } from '../utils/helpers';
import toast from 'react-hot-toast';

const FIELDS = [
  { value: 'days_since_last_trade',      label: 'Days since last trade'      },
  { value: 'days_since_last_deposit',    label: 'Days since last deposit'    },
  { value: 'days_since_last_withdrawal', label: 'Days since last withdrawal' },
  { value: 'days_since_registered',      label: 'Days since registered'      },
  { value: 'total_trading_balance',      label: 'Trading balance (total)'    },
  { value: 'wallet_balance',             label: 'Wallet balance'             },
  { value: 'total_balance',             label: 'Total balance'              },
  { value: 'total_deposits',            label: 'Total deposits'             },
  { value: 'total_withdrawals',         label: 'Total withdrawals'          },
  { value: 'net_funding',               label: 'Net funding'                },
  { value: 'withdrawal_ratio',          label: 'Withdrawal ratio (0–1)'     },
  { value: 'total_trades',             label: 'Total trades'               },
  { value: 'risk_score',               label: 'Risk score'                 },
  { value: 'open_tasks_count',         label: 'Open tasks count'           },
  { value: 'reminders_last_3d',        label: 'Reminders last 3 days'      },
  { value: 'is_banned',                label: 'Is banned'                  },
  { value: 'vip_member',              label: 'Is VIP member'              },
  { value: 'in_telegram_group',       label: 'In Telegram group'          },
  { value: 'broker_verified',         label: 'Broker verified'            },
  { value: 'watchlist',               label: 'On watchlist'               },
  { value: 'status',                  label: 'User status'                },
  { value: 'segment',                 label: 'Segment'                    },
];

const OPERATORS = [
  { value: 'gte', label: '≥' }, { value: 'gt', label: '>' },
  { value: 'lte', label: '≤' }, { value: 'lt', label: '<' },
  { value: 'eq', label: '= ' }, { value: 'neq', label: '≠' },
  { value: 'is_true', label: 'is true' }, { value: 'is_false', label: 'is false' },
  { value: 'is_null', label: 'is empty' }, { value: 'is_not_null', label: 'is set' },
  { value: 'contains', label: 'contains' },
];

const ACTIONS = [
  { value: 'set_status',       label: 'Set Status',         fields: ['value'] },
  { value: 'set_segment',      label: 'Set Segment',        fields: ['value'] },
  { value: 'set_tag',          label: 'Add Tag',            fields: ['value'] },
  { value: 'set_watchlist',    label: 'Set Watchlist',      fields: ['value'] },
  { value: 'ban_user',         label: 'Ban User',           fields: ['banType','reason'] },
  { value: 'unban_user',       label: 'Unban User',         fields: ['reason'] },
  { value: 'send_telegram',    label: 'Send Telegram Msg',  fields: ['template','message'] },
  { value: 'create_crm_task',  label: 'Create CRM Task',    fields: ['taskType','title','description'] },
  { value: 'create_crm_case',  label: 'Create CRM Case',    fields: ['caseType','severity','title'] },
  { value: 'notify_admin',     label: 'Notify Admin',       fields: ['severity','title'] },
  { value: 'push_to_kommo',    label: 'Push to Kommo',      fields: [] },
  { value: 'send_webhook',     label: 'Send Webhook',       fields: ['url'] },
];

const emptyRule = () => ({
  name: '', description: '', trigger_type: 'scheduled', priority: 50,
  conditions: [{ field: 'days_since_last_trade', operator: 'gte', value: '7' }],
  conditions_logic: 'AND',
  actions: [{ type: 'set_status', value: 'inactive' }],
  cooldown_hours: 24,
});

export default function Rules() {
  const [rules, setRules]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [modal, setModal]       = useState(null); // 'create' | { rule }
  const [draft, setDraft]       = useState(emptyRule());
  const [dryResult, setDryResult] = useState(null);
  const [dryLoading, setDryLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setRules(await getRules()); }
    catch { toast.error('Failed to load rules'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!draft.name) { toast.error('Name required'); return; }
    try {
      await createRule(draft);
      toast.success('Rule created (inactive by default)');
      setModal(null); setDraft(emptyRule()); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const handleToggle = async (id) => {
    const r = await toggleRule(id);
    toast.success(r.is_active ? 'Rule activated' : 'Rule deactivated');
    load();
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this rule?')) return;
    await deleteRule(id); toast.success('Rule deleted'); load();
  };

  const handleRun = async (id) => {
    await runRule(id);
    toast.success('Rule triggered (running in background)');
  };

  const handleDryRun = async () => {
    setDryLoading(true); setDryResult(null);
    try { setDryResult(await dryRunRule(draft)); }
    catch (e) { toast.error(e.message); }
    finally { setDryLoading(false); }
  };

  const addCondition = () => setDraft(d => ({
    ...d, conditions: [...d.conditions, { field: 'days_since_last_trade', operator: 'gte', value: '' }]
  }));

  const removeCondition = (i) => setDraft(d => ({
    ...d, conditions: d.conditions.filter((_,idx)=>idx!==i)
  }));

  const updateCondition = (i, k, v) => setDraft(d => ({
    ...d, conditions: d.conditions.map((c,idx) => idx===i ? {...c,[k]:v} : c)
  }));

  const addAction = () => setDraft(d => ({
    ...d, actions: [...d.actions, { type: 'notify_admin', severity: 'medium', title: '' }]
  }));

  const removeAction = (i) => setDraft(d => ({
    ...d, actions: d.actions.filter((_,idx)=>idx!==i)
  }));

  const updateAction = (i, k, v) => setDraft(d => ({
    ...d, actions: d.actions.map((a,idx) => idx===i ? {...a,[k]:v} : a)
  }));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Rule Engine</h1>
          <p className="page-subtitle">Configure automated customer management rules</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setModal('create'); setDraft(emptyRule()); setDryResult(null); }}>
          <Plus size={14}/> New Rule
        </button>
      </div>

      {loading ? <div style={{ textAlign:'center',padding:48 }}><div className="spinner" style={{ margin:'0 auto' }} /></div>
      : rules.length === 0 ? (
        <div className="empty-state"><Zap size={32} style={{ opacity:.3 }} /><p>No rules yet. Create your first rule.</p></div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Rule</th><th>Trigger</th><th>Priority</th>
                <th>Conditions</th><th>Actions</th><th>Hits</th>
                <th>Last Run</th><th>Status</th><th style={{width:140}}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(r => (
                <tr key={r.id}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{r.name}</div>
                    {r.description && <div className="text-muted">{r.description}</div>}
                  </td>
                  <td><span className="badge badge-blue" style={{ fontSize:10 }}>{r.trigger_type}</span></td>
                  <td className="mono" style={{ fontSize:12 }}>{r.priority}</td>
                  <td style={{ fontSize:12, color:'var(--text-muted)' }}>{r.conditions?.length || 0} condition{r.conditions?.length!==1?'s':''}</td>
                  <td style={{ fontSize:12, color:'var(--text-muted)' }}>{r.actions?.length || 0} action{r.actions?.length!==1?'s':''}</td>
                  <td className="mono" style={{ fontSize:12 }}>{fmt.num(r.total_hits)}</td>
                  <td style={{ fontSize:12, color:'var(--text-muted)' }}>{fmt.relative(r.last_run_at)}</td>
                  <td>
                    <span className={`badge ${r.is_active ? 'badge-green' : 'badge-gray'}`}>
                      {r.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td>
                    <div className="flex gap-2">
                      <button className="btn btn-ghost btn-sm btn-icon" title="Toggle" onClick={() => handleToggle(r.id)}>
                        {r.is_active ? <ToggleRight size={15} style={{color:'var(--green)'}}/> : <ToggleLeft size={15}/>}
                      </button>
                      <button className="btn btn-ghost btn-sm btn-icon" title="Run now" onClick={() => handleRun(r.id)}>
                        <Play size={13}/>
                      </button>
                      <button className="btn btn-ghost btn-sm btn-icon" title="Delete" onClick={() => handleDelete(r.id)}>
                        <Trash2 size={13} style={{color:'var(--red)'}}/>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Modal */}
      {modal === 'create' && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">New Rule</span>
              <button className="btn btn-ghost btn-icon" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ maxHeight:'70vh', overflowY:'auto' }}>

              {/* Meta */}
              <div className="grid-2 mb-4">
                <div className="form-field" style={{margin:0}}>
                  <label className="form-label">Name *</label>
                  <input className="input" value={draft.name} onChange={e => setDraft({...draft,name:e.target.value})} placeholder="Rule name…" />
                </div>
                <div className="form-field" style={{margin:0}}>
                  <label className="form-label">Priority (lower = first)</label>
                  <input className="input" type="number" value={draft.priority} onChange={e => setDraft({...draft,priority:parseInt(e.target.value)})} />
                </div>
              </div>
              <div className="form-field">
                <label className="form-label">Description</label>
                <input className="input" value={draft.description} onChange={e => setDraft({...draft,description:e.target.value})} placeholder="Optional…" />
              </div>
              <div className="grid-2 mb-4">
                <div>
                  <label className="form-label">Trigger</label>
                  <select className="select" value={draft.trigger_type} onChange={e => setDraft({...draft,trigger_type:e.target.value})}>
                    <option value="scheduled">Scheduled (cron)</option>
                    <option value="on_event">On Event</option>
                    <option value="manual">Manual only</option>
                  </select>
                </div>
                <div>
                  <label className="form-label">Cooldown (hours)</label>
                  <input className="input" type="number" value={draft.cooldown_hours} onChange={e => setDraft({...draft,cooldown_hours:parseInt(e.target.value||0)})} />
                </div>
              </div>

              {/* Conditions */}
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                <div className="card-title" style={{margin:0}}>Conditions</div>
                <div className="flex gap-2 items-center">
                  <span style={{ fontSize:12, color:'var(--text-muted)' }}>Logic:</span>
                  <select className="select" style={{width:80}} value={draft.conditions_logic} onChange={e => setDraft({...draft,conditions_logic:e.target.value})}>
                    <option value="AND">AND</option>
                    <option value="OR">OR</option>
                  </select>
                  <button className="btn btn-secondary btn-sm" onClick={addCondition}><Plus size={12}/> Add</button>
                </div>
              </div>
              {draft.conditions.map((c,i) => (
                <div key={i} className="rule-condition-row">
                  <select className="select" style={{flex:2}} value={c.field} onChange={e => updateCondition(i,'field',e.target.value)}>
                    {FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                  <select className="select" style={{flex:1}} value={c.operator} onChange={e => updateCondition(i,'operator',e.target.value)}>
                    {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  {!['is_true','is_false','is_null','is_not_null'].includes(c.operator) && (
                    <input className="input" style={{flex:1}} value={c.value} onChange={e => updateCondition(i,'value',e.target.value)} placeholder="Value…" />
                  )}
                  <button className="btn btn-ghost btn-sm btn-icon" onClick={() => removeCondition(i)}><Trash2 size={12} style={{color:'var(--red)'}}/></button>
                </div>
              ))}

              {/* Actions */}
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', margin:'16px 0 8px' }}>
                <div className="card-title" style={{margin:0}}>Actions</div>
                <button className="btn btn-secondary btn-sm" onClick={addAction}><Plus size={12}/> Add</button>
              </div>
              {draft.actions.map((a,i) => (
                <div key={i} className="rule-action-row" style={{ flexWrap:'wrap' }}>
                  <select className="select" style={{flex:'1 1 160px'}} value={a.type} onChange={e => updateAction(i,'type',e.target.value)}>
                    {ACTIONS.map(ac => <option key={ac.value} value={ac.value}>{ac.label}</option>)}
                  </select>
                  {a.type === 'ban_user' && <>
                    <select className="select" style={{flex:1}} value={a.banType||'hard'} onChange={e => updateAction(i,'banType',e.target.value)}>
                      <option value="hard">Hard ban</option>
                      <option value="soft">Soft ban</option>
                      <option value="shadow">Shadow</option>
                    </select>
                    <input className="input" style={{flex:2}} value={a.reason||''} onChange={e => updateAction(i,'reason',e.target.value)} placeholder="Ban reason…" />
                  </>}
                  {['set_status','set_segment','set_tag','set_watchlist'].includes(a.type) && (
                    <input className="input" style={{flex:2}} value={a.value||''} onChange={e => updateAction(i,'value',e.target.value)} placeholder="Value…" />
                  )}
                  {['create_crm_task','create_crm_case','notify_admin'].includes(a.type) && (
                    <input className="input" style={{flex:2}} value={a.title||''} onChange={e => updateAction(i,'title',e.target.value)} placeholder="Title…" />
                  )}
                  {a.type === 'send_telegram' && (
                    <input className="input" style={{flex:2}} value={a.template||''} onChange={e => updateAction(i,'template',e.target.value)} placeholder="Template key…" />
                  )}
                  {a.type === 'send_webhook' && (
                    <input className="input" style={{flex:2}} value={a.url||''} onChange={e => updateAction(i,'url',e.target.value)} placeholder="https://…" />
                  )}
                  <button className="btn btn-ghost btn-sm btn-icon" onClick={() => removeAction(i)}><Trash2 size={12} style={{color:'var(--red)'}}/></button>
                </div>
              ))}

              {/* Dry run result */}
              {dryResult && (
                <div className="card card-sm mt-4" style={{ borderColor: 'var(--accent)', background: 'var(--accent-dim)' }}>
                  <div style={{ fontSize:13, fontWeight:600, color:'var(--accent)', marginBottom:4 }}>
                    Dry Run Result
                  </div>
                  <div style={{ fontSize:13 }}>
                    Would trigger for <strong>{dryResult.wouldTrigger}</strong> of <strong>{dryResult.totalUsers}</strong> users
                    {dryResult.wouldTrigger > 0 && ` (sample: ${dryResult.userIds?.slice(0,5).join(', ')}…)`}
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn btn-secondary" onClick={handleDryRun} disabled={dryLoading}>
                <FlaskConical size={13}/> {dryLoading ? 'Testing…' : 'Dry Run'}
              </button>
              <button className="btn btn-primary" onClick={handleCreate}>
                Create Rule
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
