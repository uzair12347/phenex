import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Filter, RefreshCw, Ban, Unlock, ExternalLink, ChevronLeft, ChevronRight } from 'lucide-react';
import { getCustomers, banCustomer, unbanCustomer } from '../services/api';
import { fmt, StatusBadge, inactiveDays, inactiveLabel } from '../utils/helpers';
import toast from 'react-hot-toast';

const INACTIVE_OPTIONS = [1,2,3,5,7,10,14,21,30];

export default function Customers() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initBanned = searchParams.get('banned') === 'true';

  const [data, setData]       = useState({ customers: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState(initBanned ? 'banned' : 'active');
  const [search, setSearch]   = useState('');
  const [inactiveDaysFilter, setInactiveDaysFilter] = useState('');
  const [page, setPage]       = useState(1);
  const [banModal, setBanModal]   = useState(null); // { user, mode: 'ban'|'unban' }
  const [banReason, setBanReason] = useState('');

  const LIMIT = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        page, limit: LIMIT,
        banned: tab === 'banned' ? 'true' : 'false',
      };
      if (search)           params.search        = search;
      if (inactiveDaysFilter) params.inactive_days = inactiveDaysFilter;

      const result = await getCustomers(params);
      setData(result);
    } catch {
      toast.error('Failed to load customers');
    } finally {
      setLoading(false);
    }
  }, [tab, search, inactiveDaysFilter, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [tab, search, inactiveDaysFilter]);

  const handleBan = async () => {
    if (!banReason.trim()) { toast.error('Reason required'); return; }
    try {
      if (banModal.mode === 'ban') {
        await banCustomer(banModal.user.id, { ban_type: 'hard', reason: banReason });
        toast.success('Customer banned');
      } else {
        await unbanCustomer(banModal.user.id, { reason: banReason });
        toast.success('Customer unbanned');
      }
      setBanModal(null); setBanReason(''); load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed');
    }
  };

  const totalPages = Math.ceil(data.total / LIMIT);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Customers</h1>
          <p className="page-subtitle">{data.total.toLocaleString()} total records</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        <div className={`tab ${tab==='active'?'active':''}`} onClick={() => setTab('active')}>
          Active Customers
        </div>
        <div className={`tab ${tab==='banned'?'active':''}`} onClick={() => setTab('banned')}>
          Banned Customers
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 240px' }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            className="input"
            style={{ paddingLeft: 32 }}
            placeholder="Search name, email, telegram, tauro ID…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        {tab === 'active' && (
          <select
            className="select"
            style={{ width: 180 }}
            value={inactiveDaysFilter}
            onChange={e => setInactiveDaysFilter(e.target.value)}
          >
            <option value="">All activity</option>
            {INACTIVE_OPTIONS.map(d => (
              <option key={d} value={d}>Inactive ≥ {d} days</option>
            ))}
          </select>
        )}
        <button className="btn btn-secondary btn-sm" onClick={load}>
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Table */}
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Telegram</th>
              <th>Email</th>
              <th>Tauro ID</th>
              <th>Balance</th>
              <th>Status</th>
              <th>VIP</th>
              <th>{tab==='banned' ? 'Banned' : 'Inactive'}</th>
              <th>Registered</th>
              <th style={{ width: 100 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32 }}>
                <div className="spinner" style={{ margin: '0 auto' }} />
              </td></tr>
            ) : data.customers.length === 0 ? (
              <tr><td colSpan={10}>
                <div className="empty-state"><p>No customers found</p></div>
              </td></tr>
            ) : data.customers.map(u => {
              const days = inactiveDays(u.last_trade_at);
              return (
                <tr key={u.id} style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/customers/${u.id}`)}>
                  <td>
                    <div style={{ fontWeight: 500 }}>
                      {u.first_name} {u.last_name}
                    </div>
                    {u.watchlist && <span className="badge badge-orange" style={{ fontSize: 10, marginTop: 2 }}>Watchlist</span>}
                  </td>
                  <td className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {u.telegram_username ? `@${u.telegram_username}` : '—'}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 160 }} className="truncate">
                    {u.email || '—'}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{u.tauro_client_id || '—'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {fmt.money(parseFloat(u.trading_balance||0) + parseFloat(u.wallet_balance||0))}
                  </td>
                  <td><StatusBadge status={u.status} /></td>
                  <td>
                    {u.vip_member
                      ? <span className="badge badge-yellow">VIP</span>
                      : <span className="badge badge-gray">No</span>}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {tab === 'banned'
                      ? fmt.date(u.banned_at)
                      : <span style={{ color: days > 7 ? 'var(--orange)' : days > 14 ? 'var(--red)' : 'var(--text-secondary)' }}>
                          {inactiveLabel(days)}
                        </span>
                    }
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {fmt.date(u.registered_at)}
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <div className="flex gap-2">
                      <button className="btn btn-ghost btn-sm btn-icon"
                        onClick={() => navigate(`/customers/${u.id}`)}>
                        <ExternalLink size={13} />
                      </button>
                      {tab === 'active' ? (
                        <button className="btn btn-danger btn-sm btn-icon"
                          onClick={() => { setBanModal({ user: u, mode: 'ban' }); setBanReason(''); }}>
                          <Ban size={13} />
                        </button>
                      ) : (
                        <button className="btn btn-secondary btn-sm btn-icon"
                          onClick={() => { setBanModal({ user: u, mode: 'unban' }); setBanReason(''); }}>
                          <Unlock size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          <span>Page {page} of {totalPages} · {data.total} total</span>
          <div className="flex gap-2">
            <button className="btn btn-secondary btn-sm" disabled={page<=1} onClick={() => setPage(p => p-1)}>
              <ChevronLeft size={13}/>
            </button>
            <button className="btn btn-secondary btn-sm" disabled={page>=totalPages} onClick={() => setPage(p => p+1)}>
              <ChevronRight size={13}/>
            </button>
          </div>
        </div>
      )}

      {/* Ban/Unban Modal */}
      {banModal && (
        <div className="modal-backdrop" onClick={() => setBanModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                {banModal.mode === 'ban' ? '⛔ Ban Customer' : '✅ Unban Customer'}
              </span>
              <button className="btn btn-ghost btn-icon" onClick={() => setBanModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: 16, color: 'var(--text-secondary)', fontSize: 13 }}>
                {banModal.mode === 'ban'
                  ? `You are about to ban ${banModal.user.first_name} ${banModal.user.last_name}. They will be removed from the VIP group.`
                  : `You are about to unban ${banModal.user.first_name} ${banModal.user.last_name}. They will regain VIP access eligibility.`
                }
              </p>
              <div className="form-field">
                <label className="form-label">Reason *</label>
                <textarea
                  className="input"
                  rows={3}
                  placeholder="Enter reason…"
                  value={banReason}
                  onChange={e => setBanReason(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setBanModal(null)}>Cancel</button>
              <button
                className={`btn ${banModal.mode==='ban' ? 'btn-danger' : 'btn-primary'}`}
                onClick={handleBan}
              >
                {banModal.mode === 'ban' ? 'Confirm Ban' : 'Confirm Unban'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
