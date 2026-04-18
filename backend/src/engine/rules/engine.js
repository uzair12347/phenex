/**
 * Rule Engine
 *
 * Evaluates configurable rules against user state.
 * Rules are stored in DB with conditions (JSONB) and actions (JSONB).
 *
 * Condition format:
 *   { field: 'days_since_last_trade', operator: 'gte', value: 7 }
 *
 * Action format:
 *   { type: 'set_status', value: 'inactive' }
 *   { type: 'send_telegram', template: 'inactivity_reminder' }
 *   { type: 'create_crm_task', taskType: 'follow_up', title: '...' }
 *   { type: 'ban_user', banType: 'soft', reason: '...' }
 */

const db = require('../../db');
const logger = require('../../utils/logger');
const actionExecutor = require('./actions');
const { getUserFacts } = require('./facts');

class RuleEngine {

  /**
   * Evaluate all active scheduled rules for a single user.
   */
  async evaluateUser(userId) {
    const rules = await this._getActiveRules('scheduled');
    const facts = await getUserFacts(userId);
    if (!facts) return [];

    const results = [];
    for (const rule of rules) {
      try {
        const result = await this._evaluateRule(rule, facts, userId);
        if (result.triggered) results.push(result);
      } catch (err) {
        logger.error(`[RuleEngine] Rule ${rule.id} eval error for user ${userId}: ${err.message}`);
      }
    }
    return results;
  }

  /**
   * Evaluate all users for scheduled rules (batch run).
   * Called by cron job.
   */
  async runScheduledRules() {
    logger.info('[RuleEngine] Starting scheduled rule evaluation...');
    const usersResult = await db.query(`
      SELECT id FROM users
      WHERE is_banned = false OR status != 'banned'
      ORDER BY last_synced_at ASC NULLS LAST
    `);

    let totalTriggered = 0;
    for (const row of usersResult.rows) {
      const results = await this.evaluateUser(row.id);
      totalTriggered += results.length;
    }

    logger.info(`[RuleEngine] Done. ${usersResult.rows.length} users evaluated, ${totalTriggered} rules triggered.`);
  }

  /**
   * Evaluate a rule on a specific user with their current facts.
   * Returns { triggered, ruleId, conditionsMet, actionsResult }
   */
  async _evaluateRule(rule, facts, userId) {
    // Check cooldown – has this rule fired for this user recently?
    if (rule.cooldown_hours > 0) {
      const recent = await db.query(`
        SELECT id FROM rule_executions
        WHERE rule_id = $1 AND user_id = $2 AND success = true
          AND triggered_at > NOW() - INTERVAL '${rule.cooldown_hours} hours'
        LIMIT 1
      `, [rule.id, userId]);
      if (recent.rows.length > 0) {
        return { triggered: false, ruleId: rule.id, reason: 'cooldown' };
      }
    }

    // Check rule override
    if (facts.rule_override_no_ban_until && new Date(facts.rule_override_no_ban_until) > new Date()) {
      const hasBanAction = (rule.actions || []).some(a => a.type === 'ban_user');
      if (hasBanAction) {
        return { triggered: false, ruleId: rule.id, reason: 'override_active' };
      }
    }

    // Evaluate conditions
    const conditions = rule.conditions || [];
    const logic = (rule.conditions_logic || 'AND').toUpperCase();
    const condResults = conditions.map(cond => ({
      cond,
      met: this._evaluateCondition(cond, facts),
    }));

    const allMet = logic === 'AND'
      ? condResults.every(r => r.met)
      : condResults.some(r => r.met);

    if (!allMet) {
      return { triggered: false, ruleId: rule.id };
    }

    // Execute actions
    const start = Date.now();
    const actionsResult = [];
    for (const action of (rule.actions || [])) {
      try {
        const res = await actionExecutor.execute(action, userId, rule, facts);
        actionsResult.push({ action, success: true, result: res });
      } catch (err) {
        actionsResult.push({ action, success: false, error: err.message });
        logger.warn(`[RuleEngine] Action ${action.type} failed for user ${userId}: ${err.message}`);
      }
    }

    // Log execution
    await db.query(`
      INSERT INTO rule_executions
        (rule_id, user_id, conditions_met, actions_taken, success, execution_ms)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      rule.id, userId,
      JSON.stringify(condResults.filter(r => r.met).map(r => r.cond)),
      JSON.stringify(actionsResult),
      true,
      Date.now() - start,
    ]);

    // Increment rule total_hits
    await db.query('UPDATE rules SET total_hits = total_hits + 1, last_run_at = NOW() WHERE id = $1', [rule.id]);

    return {
      triggered: true,
      ruleId: rule.id,
      ruleName: rule.name,
      conditionsMet: condResults.filter(r => r.met).map(r => r.cond),
      actionsResult,
    };
  }

  /**
   * Evaluate a single condition against user facts.
   */
  _evaluateCondition(cond, facts) {
    const { field, operator, value } = cond;
    const factValue = this._resolveFact(field, facts);

    if (factValue === null || factValue === undefined) {
      // Null facts: 'is_null' is true, everything else is false
      return operator === 'is_null';
    }

    switch (operator) {
      case 'eq':          return factValue == value;
      case 'neq':         return factValue != value;
      case 'gt':          return factValue >  Number(value);
      case 'gte':         return factValue >= Number(value);
      case 'lt':          return factValue <  Number(value);
      case 'lte':         return factValue <= Number(value);
      case 'is_true':     return factValue === true;
      case 'is_false':    return factValue === false;
      case 'is_null':     return factValue == null;
      case 'is_not_null': return factValue != null;
      case 'contains':    return Array.isArray(factValue) ? factValue.includes(value) : String(factValue).includes(String(value));
      case 'not_contains':return Array.isArray(factValue) ? !factValue.includes(value) : !String(factValue).includes(String(value));
      default:
        logger.warn(`[RuleEngine] Unknown operator: ${operator}`);
        return false;
    }
  }

  _resolveFact(field, facts) {
    // Support nested access: 'account.balance'
    return field.split('.').reduce((obj, key) => obj?.[key], facts);
  }

  /**
   * Dry-run: how many users would this rule affect right now?
   */
  async dryRun(ruleDefinition) {
    const allUsers = await db.query('SELECT id FROM users LIMIT 1000');
    const wouldTrigger = [];

    for (const row of allUsers.rows) {
      const facts = await getUserFacts(row.id);
      if (!facts) continue;
      const conditions = ruleDefinition.conditions || [];
      const logic = (ruleDefinition.conditions_logic || 'AND').toUpperCase();
      const met = conditions.map(c => this._evaluateCondition(c, facts));
      const triggered = logic === 'AND' ? met.every(Boolean) : met.some(Boolean);
      if (triggered) wouldTrigger.push(row.id);
    }

    return {
      totalUsers: allUsers.rows.length,
      wouldTrigger: wouldTrigger.length,
      userIds: wouldTrigger.slice(0, 20), // return sample
    };
  }

  async _getActiveRules(triggerType) {
    const result = await db.query(`
      SELECT * FROM rules
      WHERE is_active = true AND trigger_type = $1
      ORDER BY priority ASC
    `, [triggerType]);
    return result.rows;
  }

  async _getEventRules(eventType) {
    const result = await db.query(`
      SELECT * FROM rules
      WHERE is_active = true AND trigger_type = 'on_event' AND trigger_event = $1
      ORDER BY priority ASC
    `, [eventType]);
    return result.rows;
  }

  /**
   * Fire event-based rules (e.g. 'deposit', 'withdrawal', 'trade').
   */
  async fireEvent(eventType, userId) {
    const rules = await this._getEventRules(eventType);
    const facts = await getUserFacts(userId);
    if (!facts) return [];

    const results = [];
    for (const rule of rules) {
      const result = await this._evaluateRule(rule, facts, userId);
      if (result.triggered) results.push(result);
    }
    return results;
  }
}

module.exports = new RuleEngine();
