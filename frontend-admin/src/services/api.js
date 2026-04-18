const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';

// Store token
const getToken = () => localStorage.getItem('adminToken');
const setToken = (token) => localStorage.setItem('adminToken', token);
const removeToken = () => localStorage.removeItem('adminToken');

// API call helper
async function apiCall(endpoint, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `API call failed: ${response.status}`);
  }

  return response.json();
}

// Auth functions
export const login = async (email, password) => {
  const result = await apiCall('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (result.token) {
    setToken(result.token);
  }
  return result;
};

export const getMe = async () => {
  return apiCall('/auth/me', { method: 'GET' });
};


export const getCustomerAccounts = (id) => {
  return apiCall(`/customers/${id}/accounts`);
};

export const logout = () => {
  removeToken();
};

// Dashboard functions
export const getOverview = (params) => {
  const query = new URLSearchParams(params).toString();
  return apiCall(`/dashboard/overview${query ? `?${query}` : ''}`);
};

export const getCharts = (days = 30) => {
  return apiCall(`/dashboard/charts?days=${days}`);
};

export const getAlerts = (resolved = false) => {
  return apiCall(`/dashboard/alerts?resolved=${resolved}`);
};

export const resolveAlert = (id) => {
  return apiCall(`/dashboard/alerts/${id}/resolve`, { method: 'PATCH' });
};

// Dashboard functions - ADD THESE THREE
export const getDashboardOverview = (params) => {
  const query = new URLSearchParams(params).toString();
  return apiCall(`/dashboard/overview${query ? `?${query}` : ''}`);
};

export const getDashboardCharts = (days = 30) => {
  return apiCall(`/dashboard/charts?days=${days}`);
};

export const getDashboardDaily = (date) => {
  const query = date ? `?date=${date}` : '';
  return apiCall(`/dashboard/daily${query}`);
};

// Customers functions
export const getCustomers = (params) => {
  const query = new URLSearchParams(params).toString();
  return apiCall(`/customers${query ? `?${query}` : ''}`);
};

export const getCustomer = (id) => {
  return apiCall(`/customers/${id}`);
};

export const getCustomerStats = (id) => {
  return apiCall(`/customers/${id}/stats`);
};

export const getCustomerTimeline = (id, page = 1) => {
  return apiCall(`/customers/${id}/timeline?page=${page}`);
};

export const banCustomer = (id, banType, reason) => {
  return apiCall(`/customers/${id}/ban`, {
    method: 'POST',
    body: JSON.stringify({ ban_type: banType, reason }),
  });
};

export const unbanCustomer = (id, reason) => {
  return apiCall(`/customers/${id}/unban`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
};

export const updateCustomer = (id, data) => {
  return apiCall(`/customers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
};

export const updateCustomerTask = (customerId, taskId, updates) => {
  return apiCall(`/customers/${customerId}/tasks/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
};

export const syncCustomer = (id) => {
  return apiCall(`/customers/${id}/sync`, { method: 'POST' });
};

export const getCustomerNotes = (id) => {
  return apiCall(`/customers/${id}/notes`);
};

export const addCustomerNote = (id, content, category) => {
  return apiCall(`/customers/${id}/notes`, {
    method: 'POST',
    body: JSON.stringify({ content, category }),
  });
};

export const getCustomerTasks = (id) => {
  return apiCall(`/customers/${id}/tasks`);
};

export const createCustomerTask = (id, task) => {
  return apiCall(`/customers/${id}/tasks`, {
    method: 'POST',
    body: JSON.stringify(task),
  });
};

// Rules functions
export const getRules = (active, triggerType) => {
  const params = new URLSearchParams();
  if (active !== undefined) params.append('active', active);
  if (triggerType) params.append('trigger_type', triggerType);
  return apiCall(`/rules${params.toString() ? `?${params}` : ''}`);
};

export const getRuleFields = () => {
  return apiCall('/rules/fields');
};

export const createRule = (rule) => {
  return apiCall('/rules', {
    method: 'POST',
    body: JSON.stringify(rule),
  });
};

export const updateRule = (id, updates) => {
  return apiCall(`/rules/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
};

export const toggleRule = (id) => {
  return apiCall(`/rules/${id}/toggle`, { method: 'POST' });
};

export const deleteRule = (id) => {
  return apiCall(`/rules/${id}`, { method: 'DELETE' });
};

export const runRule = (id) => {
  return apiCall(`/rules/${id}/run`, { method: 'POST' });
};

export const dryRunRule = (ruleDefinition) => {
  return apiCall('/rules/dry-run', {
    method: 'POST',
    body: JSON.stringify(ruleDefinition),
  });
};

export const getRuleExecutions = (id, page = 1) => {
  return apiCall(`/rules/${id}/executions?page=${page}`);
};

// VIP Groups functions
export const getVipGroups = () => {
  return apiCall('/vip-groups');
};

export const createVipGroup = (group) => {
  return apiCall('/vip-groups', {
    method: 'POST',
    body: JSON.stringify(group),
  });
};

export const updateVipGroup = (id, updates) => {
  return apiCall(`/vip-groups/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
};

export const getVipGroupMembers = (id, status) => {
  const query = status ? `?status=${status}` : '';
  return apiCall(`/vip-groups/${id}/members${query}`);
};

export const getVipGroupPendingInvites = (id) => {
  return apiCall(`/vip-groups/${id}/pending`);
};

export const sendInvite = (groupId, userId, send = true) => {
  return apiCall(`/vip-groups/${groupId}/invite`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, send }),
  });
};

// Logs functions
export const getLogs = (filters) => {
  const query = new URLSearchParams(filters).toString();
  return apiCall(`/logs${query ? `?${query}` : ''}`);
};

// Integrations functions
export const getIntegrations = () => {
  return apiCall('/integrations');
};

export const triggerSync = (type, data = {}) => {
  return apiCall(`/integrations/sync/${type}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

export const updateIntegration = (id, data) => {
  return apiCall(`/integrations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
};

// Data Sources functions
export const getDataSources = () => {
  return apiCall('/sources');
};

export const createDataSource = (source) => {
  return apiCall('/sources', {
    method: 'POST',
    body: JSON.stringify(source),
  });
};

export const syncDataSource = (id) => {
  return apiCall(`/sources/${id}/sync`, { method: 'POST' });
};

export const previewDataSource = (id) => {
  return apiCall(`/sources/${id}/preview`, { method: 'POST' });
};

export const getSourceRecords = (id, params) => {
  const query = new URLSearchParams(params).toString();
  return apiCall(`/sources/${id}/records${query ? `?${query}` : ''}`);
};

export const getSourceMappings = (id) => {
  return apiCall(`/sources/${id}/mappings`);
};

export const saveSourceMappings = (id, mappings) => {
  return apiCall(`/sources/${id}/mappings`, {
    method: 'PUT',
    body: JSON.stringify({ mappings }),
  });
};

// Matching Queue
export const getMatchingQueue = (page = 1) => {
  return apiCall(`/matching-queue?page=${page}`);
};

export const resolveMatchingRecord = (id, resolution, userId, notes) => {
  return apiCall(`/matching-queue/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ resolution, user_id: userId, notes }),
  });
};

export default {
  login, getMe, logout,
  getOverview, getCharts, getAlerts, resolveAlert,
  getCustomers, getCustomer, getCustomerStats, getCustomerTimeline,
  banCustomer, unbanCustomer, updateCustomer, syncCustomer,
  getCustomerNotes, addCustomerNote, getCustomerTasks, createCustomerTask,
  getRules, getRuleFields, createRule, updateRule, toggleRule, deleteRule, runRule, dryRunRule, getRuleExecutions,
  getVipGroups, createVipGroup, updateVipGroup, getVipGroupMembers, getVipGroupPendingInvites, sendInvite,
  getLogs,
  getIntegrations, triggerSync,
  getDataSources, createDataSource, syncDataSource, previewDataSource, getSourceRecords, getSourceMappings, saveSourceMappings,
  getMatchingQueue, resolveMatchingRecord,
};