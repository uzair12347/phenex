export const formatDate = (dateString) => {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleDateString('de-DE');
};

export const formatDateTime = (dateString) => {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleString('de-DE');
};

export const formatCurrency = (amount) => {
  if (amount === null || amount === undefined) return '-';
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

export const formatNumber = (num) => {
  if (num === null || num === undefined) return '-';
  return new Intl.NumberFormat('de-DE').format(num);
};

export const getStatusBadge = (status) => {
  const badges = {
    active: 'success',
    inactive: 'warning',
    banned: 'danger',
    vip_active: 'primary',
    registered: 'secondary',
  };
  return badges[status] || 'secondary';
};

export const truncate = (str, length = 50) => {
  if (!str || str.length <= length) return str;
  return str.substring(0, length) + '...';
};

// Ye fmt object add karo - jo errors mein missing tha
export const fmt = {
  date: formatDate,
  dateTime: formatDateTime,
  currency: formatCurrency,
  number: formatNumber,
  truncate: truncate,
  num: formatNumber,  // ✅ YEH LINE ADD KARO
  money: formatCurrency, // ✅ YEH BHI ADD KARO (agar missing hai)
  lots: (lots) => {
  if (lots === null || lots === undefined) return '0';
  const num = typeof lots === 'string' ? parseFloat(lots) : lots;
  if (isNaN(num)) return '0';
  return num.toFixed(2);
},
  relative: (dateString) => {
    if (!dateString) return '-';
    const diff = Math.floor((new Date() - new Date(dateString)) / (1000 * 60 * 60 * 24));
    if (diff === 0) return 'today';
    if (diff === 1) return 'yesterday';
    return `${diff} days ago`;
  },
};

// StatusBadge component (ADD THIS - after existing code)
export const StatusBadge = ({ status }) => {
  const statusMap = {
    active: { label: 'Active', className: 'badge-green' },
    inactive: { label: 'Inactive', className: 'badge-gray' },
    banned: { label: 'Banned', className: 'badge-red' },
    vip_active: { label: 'VIP Active', className: 'badge-yellow' },
    registered: { label: 'Registered', className: 'badge-blue' },
    broker_verified: { label: 'Verified', className: 'badge-green' },
    verification_pending: { label: 'Pending', className: 'badge-orange' },
  };
  const config = statusMap[status] || { label: status, className: 'badge-gray' };
  return <span className={`badge ${config.className}`}>{config.label}</span>;
};

// Account type labels (ADD THIS)
export const ACCOUNT_TYPE_LABELS = {
  mt5: 'MT5 Live',
  wallet: 'Wallet',
  pamm: 'PAMM',
  ib_wallet: 'IB Wallet',
  demo: 'Demo',
};

// Inactive days helper (ADD THIS)
export const inactiveDays = (days) => {
  if (days === null || days === undefined) return '-';
  if (days === 9999) return 'Never';
  return `${days} days`;
};

// Inactive label helper (ADD THIS)
export const inactiveLabel = (days) => {
  if (days === null || days === undefined) return 'Unknown';
  if (days === 9999) return 'Never traded';
  if (days <= 3) return 'Active';
  if (days <= 7) return 'Mildly inactive';
  if (days <= 30) return 'Inactive';
  return 'Highly inactive';
};