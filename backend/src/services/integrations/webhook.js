/**
 * Generic Webhook Service
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../../utils/logger');

class WebhookService {
  async send(url, payload, secret) {
    const body = JSON.stringify(payload);
    const sig  = secret
      ? crypto.createHmac('sha256', secret).update(body).digest('hex')
      : null;

    try {
      await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          ...(sig ? { 'X-Phenex-Signature': sig } : {}),
          'X-Phenex-Timestamp': Date.now(),
        },
        timeout: 8000,
      });
      return { sent: true };
    } catch (err) {
      logger.warn(`[Webhook] POST to ${url} failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Verify an inbound webhook signature from external systems.
   */
  verifySignature(payload, signature, secret) {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }
}

module.exports = new WebhookService();
