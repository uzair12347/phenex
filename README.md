# Phenex VIP System – Backend

Telegram-bound VIP Membership & Retention Operating System for broker customers.

## Architecture

```
phenex/
├── backend/
│   └── src/
│       ├── api/
│       │   ├── middleware/   auth.js
│       │   └── routes/       customers, dashboard, rules, misc (auth/miniapp/logs/integrations)
│       ├── db/
│       │   ├── migrations/   001_initial_schema.sql
│       │   ├── index.js      (pool, query, transaction)
│       │   ├── migrate.js
│       │   └── seed.js
│       ├── engine/
│       │   ├── rules/        engine.js, facts.js, actions.js
│       │   └── crm/          timeline.js
│       ├── jobs/             scheduler.js  (cron)
│       ├── services/
│       │   ├── tauro/        adapter.js, sync.js
│       │   ├── telegram/     service.js
│       │   └── integrations/ kommo.js, sheets-notion.js, webhook.js
│       └── utils/            logger.js, auditLog.js
└── docker-compose.yml
```

## Quick Start

### 1. Copy environment file
```bash
cp backend/.env.example backend/.env
# Fill in TELEGRAM_BOT_TOKEN, TAURO_API_KEY, KOMMO_*, etc.
```

### 2. Start services
```bash
docker-compose up -d postgres redis
```

### 3. Install dependencies
```bash
cd backend && npm install
```

### 4. Run migrations + seed
```bash
npm run migrate
npm run seed
# Creates admin: admin@phenex.com / admin123
```

### 5. Start backend
```bash
npm run dev
```

## API Overview

| Endpoint | Description |
|---|---|
| `POST /api/auth/login` | Admin login → JWT |
| `GET  /api/auth/me` | Current admin |
| `POST /api/miniapp/init` | Telegram WebApp init |
| `POST /api/miniapp/profile` | Submit email + Tauro ID |
| `GET  /api/miniapp/verify?jwt=` | JWT callback from Tauro email |
| `GET  /api/miniapp/status` | User VIP/ban status |
| `POST /api/miniapp/vip/join` | Get VIP invite link |
| `GET  /api/dashboard/overview` | KPI summary |
| `GET  /api/dashboard/daily?date=` | Daily numbers |
| `GET  /api/dashboard/charts?days=` | Time-series data |
| `GET  /api/dashboard/alerts` | Open alerts |
| `GET  /api/customers` | List customers (filterable) |
| `GET  /api/customers/:id` | Customer detail |
| `GET  /api/customers/:id/accounts` | Trading accounts |
| `GET  /api/customers/:id/stats` | Aggregated stats + charts |
| `GET  /api/customers/:id/timeline` | Event timeline |
| `POST /api/customers/:id/ban` | Ban customer |
| `POST /api/customers/:id/unban` | Unban customer |
| `PATCH /api/customers/:id` | Update segment/tags/cm |
| `POST /api/customers/:id/sync` | Force re-sync from Tauro |
| `GET  /api/customers/:id/notes` | CRM notes |
| `POST /api/customers/:id/notes` | Add note |
| `GET  /api/customers/:id/tasks` | CRM tasks |
| `POST /api/customers/:id/tasks` | Create task |
| `GET  /api/rules` | List rules |
| `POST /api/rules` | Create rule |
| `PATCH /api/rules/:id` | Update rule |
| `POST /api/rules/:id/toggle` | Activate/deactivate |
| `POST /api/rules/:id/run` | Manual trigger |
| `POST /api/rules/dry-run` | Test rule (no side effects) |
| `GET  /api/rules/:id/executions` | Rule execution log |
| `GET  /api/logs?log_type=&actor_id=&from=&to=` | Audit logs |
| `GET  /api/integrations` | Integration list |
| `POST /api/integrations/sync/:type` | Trigger sync |
| `POST /api/integrations/webhooks/inbound` | Receive external webhook |

## Rule Engine

Rules are stored in the `rules` table and evaluated every 15 minutes against all users.

### Condition fields available
`days_since_last_trade`, `days_since_last_deposit`, `days_since_last_withdrawal`,
`total_trading_balance`, `wallet_balance`, `total_deposits`, `total_withdrawals`,
`withdrawal_ratio`, `net_funding`, `total_trades`, `risk_score`,
`is_banned`, `vip_member`, `in_telegram_group`, `broker_verified`, `watchlist`,
`status`, `segment`, `open_tasks_count`, `reminders_last_3d`

### Operators
`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `is_true`, `is_false`, `is_null`, `is_not_null`,
`contains`, `not_contains`

### Action types
`set_status`, `set_segment`, `set_tag`, `set_watchlist`,
`ban_user`, `unban_user`,
`send_telegram`, `create_crm_task`, `create_crm_case`,
`notify_admin`, `push_to_kommo`, `send_webhook`

## Background Jobs

| Job | Schedule |
|---|---|
| Tauro structure sync | Every 5 min (configurable via `TAURO_SYNC_INTERVAL`) |
| Rule engine evaluation | Every 15 min |
| Daily account snapshots | 00:05 daily |
| Telegram membership check | Every hour |

## Integrations

All integrations are registered in the `integrations` table and activated via the admin UI.
Supported: **TauroMarkets API**, **Kommo CRM**, **Google Sheets**, **Notion**, **Generic Webhook/Python Middleware**

## VIP Flow (Mini App)

```
Telegram Bot Start
  → POST /miniapp/init      (validate Telegram initData, create user)
  → POST /miniapp/profile   (email + Tauro ID → trigger verification email)
  → GET  /miniapp/verify    (Tauro JWT callback → mark broker_verified)
  → GET  /miniapp/status    (poll status)
  → POST /miniapp/vip/join  (get invite link if qualified)
```
