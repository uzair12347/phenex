require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const logger     = require('./utils/logger');

// Routes
const customersRouter = require('./api/routes/customers');
const dashboardRouter = require('./api/routes/dashboard');
const rulesRouter     = require('./api/routes/rules');
const { authRouter, miniAppRouter, logsRouter, intRouter } = require('./api/routes/misc');
const { sourcesRouter, matchingRouter, vipGroupsRouter, miniAppExtRouter } = require('./api/routes/extSync');

// Jobs
const { startJobs } = require('./jobs/scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security / middleware ──────────────────────────────────────
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// General rate limit
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Stricter limit on auth
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
}));

// ── Request logger ────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',              authRouter);
app.use('/api/miniapp',           miniAppRouter);
app.use('/api/miniapp',           miniAppExtRouter);   // extended flexible submit
app.use('/api/dashboard',         dashboardRouter);
app.use('/api/customers',         customersRouter);
app.use('/api/rules',             rulesRouter);
app.use('/api/logs',              logsRouter);
app.use('/api/integrations',      intRouter);
app.use('/api/sources',           sourcesRouter);      // external data sources
app.use('/api/matching-queue',    matchingRouter);     // identity matching review
app.use('/api/vip-groups',        vipGroupsRouter);    // VIP groups CRM

// Telegram webhook
app.post('/telegram/webhook', express.json(), async (req, res) => {
  res.sendStatus(200); // ACK first
  try {
    const telegramService = require('./services/telegram/service');
    await telegramService.handleUpdate(req.body);
    // Route chat_member updates to VIP groups service
    if (req.body.chat_member || req.body.my_chat_member) {
      const vipGroupsService = require('./services/vip/groups');
      await vipGroupsService.handleTelegramMemberUpdate(
        req.body.chat_member || req.body.my_chat_member
      );
    }
  } catch (err) {
    logger.error(`[Telegram Webhook] ${err.message}`);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), env: process.env.NODE_ENV });
});

// ── Error handler ─────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  logger.info(`Phenex Backend running on port ${PORT} [${process.env.NODE_ENV}]`);

  // Start background jobs (skip in test env)
  if (process.env.NODE_ENV !== 'test') {
    startJobs();
  }
});

module.exports = app;
