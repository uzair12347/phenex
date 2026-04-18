/**
 * TauroMarkets Partners API Adapter
 *
 * Endpoints discovered from WhatsApp integration chat:
 *   GET  https://phenex-api.tauromarkets.com/?key=<API_KEY>&id=<STRUCTURE_ID>
 *   GET  https://web-api.tauromarkets.com/api/v2/partners?email=<email>&id=<tauro_client_id>&sendEmail=<bool>
 *        Authorization: Bearer <PSK>
 *   POST https://api.phenex-signals.com/verify?jwt=<token>   (our callback)
 *
 * API response shape (from chat):
 *   - brokerInfo: { customers, activeCustomers, totalLots, totalTrades, ... }
 *   - customers[]: { id, email, firstName, lastName, ... }
 *   - accounts[]: { id, accountNumber, currency, balance, equity, signupDate, type }
 *   - trades: []
 *   - fundingEvents: []
 */

const axios = require('axios');
const logger = require('../../utils/logger');

class TauroAdapter {
  constructor() {
    this.structureBaseUrl = process.env.TAURO_API_BASE_URL || 'https://phenex-api.tauromarkets.com';
    this.partnersBaseUrl  = 'https://web-api.tauromarkets.com';
    this.apiKey           = process.env.TAURO_API_KEY;
    this.psk              = process.env.TAURO_PSK;
    this.jwtKey           = process.env.TAURO_JWT_KEY;
    this.rootStructureId  = process.env.TAURO_ROOT_STRUCTURE_ID || '278785';
    this.defaultStructureId = process.env.TAURO_DEFAULT_STRUCTURE_ID || '321718';
    this.timeout          = 15000; // 15s – API can be slow at 8 req/s
  }

  // ─── Structure API ────────────────────────────────────────────

  /**
   * Fetch full structure data for a given structure owner ID.
   * Returns customers, accounts, trades, funding for the entire downline.
   */
  async getStructure(structureId) {
    const id = structureId || this.defaultStructureId;
    try {
      const resp = await axios.get(this.structureBaseUrl, {
        params: { key: this.apiKey, id },
        timeout: this.timeout,
      });
      return this._normalizeStructureResponse(resp.data, id);
    } catch (err) {
      logger.error(`[TauroAdapter] getStructure(${id}) failed: ${err.message}`);
      throw new TauroApiError(`Structure fetch failed: ${err.message}`, err);
    }
  }

  /**
   * Fetch a single customer's data by email + tauro client ID.
   * sendEmail=false means no verification email is triggered (post-onboarding).
   */
  async getCustomer(email, tauroClientId, sendEmail = false) {
    try {
      const resp = await axios.get(`${this.partnersBaseUrl}/api/v2/partners`, {
        params: { email, id: tauroClientId, sendEmail },
        headers: { Authorization: `Bearer ${this.psk}` },
        timeout: this.timeout,
      });
      return this._normalizeCustomerResponse(resp.data);
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) return null;
      logger.error(`[TauroAdapter] getCustomer(${email}) failed: ${err.message}`);
      throw new TauroApiError(`Customer fetch failed: ${err.message}`, err);
    }
  }

  /**
   * Trigger verification email. Called once during onboarding.
   * sendEmail=true (default) causes Tauro to send the JWT link email.
   */
  async triggerVerificationEmail(email, tauroClientId) {
    return this.getCustomer(email, tauroClientId, true);
  }

  /**
   * Verify a JWT token received at our callback endpoint.
   * The JWT is signed with TAURO_JWT_KEY (PSK shared with Tauro).
   */
  verifyJwtToken(token) {
    const jwt = require('jsonwebtoken');
    try {
      const decoded = jwt.verify(token, this.jwtKey, { algorithms: ['HS256'] });
      return { valid: true, payload: decoded };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  // ─── Normalizers ──────────────────────────────────────────────

  _normalizeStructureResponse(raw, structureId) {
    if (!raw) return null;

    // The API returns broker-level structure info + customer list
    return {
      structureId,
      fetchedAt: new Date().toISOString(),
      summary: {
        totalCustomers:   raw.customerCount      ?? raw.customers?.length ?? 0,
        activeCustomers:  raw.activeCustomerCount ?? 0,
        bannedCustomers:  raw.bannedCustomerCount ?? 0,
        totalLots:        this._divideLots(raw.totalLots ?? 0),
        totalTrades:      raw.totalTrades         ?? 0,
        totalDeposits:    raw.totalDeposits       ?? 0,
        totalWithdrawals: raw.totalWithdrawals    ?? 0,
      },
      customers: (raw.customers || []).map(c => this._normalizeCustomer(c)),
      // Some endpoints return a flat accounts array at structure level
      accounts:  (raw.accounts  || []).map(a => this._normalizeAccount(a)),
    };
  }

  _normalizeCustomerResponse(raw) {
    if (!raw) return null;
    return {
      customer: this._normalizeCustomer(raw.customer || raw),
      accounts: (raw.accounts || raw.tradingAccounts || []).map(a => this._normalizeAccount(a)),
      trades:   (raw.trades || raw.tradeHistory     || []).map(t => this._normalizeTrade(t)),
      funding:  (raw.funding || raw.fundingEvents   || []).map(f => this._normalizeFunding(f)),
    };
  }

  _normalizeCustomer(c) {
    return {
      tauroClientId:  String(c.clientId || c.id || ''),
      email:          c.email || '',
      firstName:      c.firstName || c.first_name || '',
      lastName:       c.lastName  || c.last_name  || '',
      fullName:       [c.firstName || c.first_name, c.lastName || c.last_name].filter(Boolean).join(' '),
      kycStatus:      c.kycStatus || c.kyc_status || null,
      registeredAt:   c.registrationDate || c.signupDate ? new Date(c.registrationDate || c.signupDate) : null,
      structureId:    c.structureId || c.partnerId || null,
      uplineId:       c.uplineId    || c.sponsorId || null,
      raw: c,
    };
  }

  _normalizeAccount(a) {
    // Determine account type from type field or naming
    const type = this._resolveAccountType(a);
    return {
      brokerLocalId:   String(a.id || ''),
      accountNumber:   String(a.accountNumber || a.account_number || a.mt5Login || a.mt4Login || ''),
      type,
      platform:        a.platform || a.server || this._resolvePlatform(type),
      currency:        a.currency || 'USD',
      isDemo:          a.isDemo   || a.demo   || false,
      balance:         parseFloat(a.balance  || 0),
      equity:          a.equity  != null ? parseFloat(a.equity)  : null,
      freeMargin:      a.freeMargin != null ? parseFloat(a.freeMargin) : null,
      openPositions:   a.openPositions || 0,
      openLots:        parseFloat(a.openLots || 0),
      totalDeposits:   parseFloat(a.totalDeposits   || 0),
      totalWithdrawals:parseFloat(a.totalWithdrawals || 0),
      totalTrades:     parseInt(a.totalTrades  || 0),
      totalLots:       parseFloat(this._divideLots(a.totalLots || 0)),
      totalProfit:     parseFloat(a.totalProfit || 0),
      lastTradeAt:     a.lastTradeAt ? new Date(a.lastTradeAt) : null,
      signupDate:      a.signupDate  ? new Date(a.signupDate)  : null,
      raw: a,
    };
  }

  _normalizeTrade(t) {
    return {
      tradeId:   String(t.id || t.ticket || ''),
      symbol:    t.symbol || '',
      tradeType: (t.type || t.direction || '').toLowerCase(),
      lots:      parseFloat(t.lots || t.volume || 0),
      profit:    parseFloat(t.profit || 0),
      openPrice: parseFloat(t.openPrice || 0),
      closePrice:parseFloat(t.closePrice || 0),
      openedAt:  t.openTime  ? new Date(t.openTime)  : null,
      closedAt:  t.closeTime ? new Date(t.closeTime) : null,
      raw: t,
    };
  }

  _normalizeFunding(f) {
    return {
      eventType: (f.type || f.event || '').toLowerCase(),
      amount:    parseFloat(f.amount || 0),
      currency:  f.currency || 'USD',
      happenedAt:f.date || f.createdAt ? new Date(f.date || f.createdAt) : null,
      raw: f,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * The API was found to return inflated lot numbers (bug reported in chat, March 2026).
   * Tauro confirmed the numbers need to be divided – dividing by 100 as discussed.
   */
  _divideLots(rawLots) {
    const n = parseFloat(rawLots || 0);
    return n > 1000000 ? n / 100 : n; // heuristic for inflated values
  }

  _resolveAccountType(a) {
    const t = (a.type || a.accountType || a.serverType || '').toLowerCase();
    if (t.includes('wallet') || t.includes('ib'))   return 'wallet';
    if (t.includes('pamm'))                         return 'pamm';
    if (t.includes('demo'))                         return 'trading_demo';
    if (t.includes('mt4') || t.includes('4'))       return 'trading_live_mt4';
    if (t.includes('mt5') || t.includes('5'))       return 'trading_live_mt5';
    // If no type info, infer from fields
    if (a.mt4Login)                                 return 'trading_live_mt4';
    if (a.mt5Login)                                 return 'trading_live_mt5';
    return 'unknown';
  }

  _resolvePlatform(type) {
    if (type === 'trading_live_mt4') return 'MT4';
    if (type === 'trading_live_mt5') return 'MT5';
    if (type === 'pamm')             return 'PAMM';
    return null;
  }
}

class TauroApiError extends Error {
  constructor(message, originalError) {
    super(message);
    this.name = 'TauroApiError';
    this.originalError = originalError;
    this.statusCode = originalError?.response?.status;
  }
}

module.exports = new TauroAdapter();
module.exports.TauroAdapter = TauroAdapter;
module.exports.TauroApiError = TauroApiError;
