## Lead Generation Engine — Backend

Express service (main entry `index.js`) that powers sources, prospects, campaigns, enrichment, social posts, and Lead Desk pushes for the Lead Gen Engine.

### Requirements
- Node 18+ (uses global `fetch` in `index.js`).
- Env vars: `PORT` (default 3004), `LEADDESK_API_BASE` (default `http://127.0.0.1:3003`), `OPENAI_API_KEY` (optional; without it, AI suggestions fall back).

### Local setup
1) `npm install`
2) Create `.env` with variable names above (no secrets committed).
3) Run: `node index.js` (defaults to PORT 3004).

### Database
- SQLite file: `data/leads-gen.sqlite` (created by `db.js`).
- Tables (high level): sources (+ ICP fields), prospects (status, archivedAt), prospect_notes, outreach_steps, campaigns, social_posts (+ status), post_metrics, domains cache.
- Backups: `data/leads-gen.sqlite.backup-YYYYMMDD-HHMMSS` and one-off `data/leads-gen-backup-sentAt-20251206.sqlite`.
- Avoid manual edits; keep backups safe.

### API endpoints (summary)
- Health: `GET /health`
- Sources: `GET/POST /sources`, `PATCH /sources/:id`, `GET /sources/:id`
- Campaigns: `GET /campaigns`, `POST /campaigns`
- AI: `POST /ai/campaigns/:id/suggest-posts`, `POST /ai/sources/:sourceId/enrich-preview`, `POST /ai/image-from-idea`
- Social posts: `GET /social-posts`, `POST /social-posts`, `PATCH /social-posts/:id`
- Prospects: `GET /prospects` (non-archived), `GET /prospects?archived=1`, `GET /prospects/:id`, `POST /prospects`, `PATCH /prospects/:id`, `PATCH /prospects/:id/archive`, `PATCH /prospects/:id/restore`, `DELETE /prospects/:id` (only when archived)
- Notes: `GET /prospects/:id/notes`, `POST /prospects/:id/notes`
- Lead Desk: `POST /prospects/:id/push-to-leaddesk`
- Bulk import: `POST /sources/:sourceId/prospects/bulk`

### Prospect guardrails
- Normalised fields stored: `normalizedEmail`, `normalizedDomain`, `normalizedContactName`.
- Dedupe rules: primary on `normalizedEmail`; fallback on `normalizedDomain + normalizedContactName` only when email is missing.
- Origin: defaults to `manual` for single create, `purchased` for bulk import unless a non-empty `origin` is provided.
- Suppression: `suppressedAt` marks suppressed rows; hidden from `GET /prospects` unless `?suppressed=1` is passed; suppressed rows are excluded from enrichment payloads.

### Suppression endpoints
- `PATCH /prospects/:id/suppress`
- `PATCH /prospects/:id/unsuppress`

### Bulk import reporting
- Response headers: `X-LeadGen-Import-Received`, `X-LeadGen-Import-Valid`, `X-LeadGen-Import-Inserted`, `X-LeadGen-Import-Skipped-Invalid`, `X-LeadGen-Import-Skipped-Duplicate-Email`, `X-LeadGen-Import-Skipped-Duplicate-Fallback`, `X-LeadGen-Import-Skipped-Suppressed`, `X-LeadGen-Import-Skipped-Other`.
- Response body remains the inserted prospect rows array.

### Enrichment context
- Uses WEBSITE_EXCERPT (domain fetch + cache) plus ICP campaign context.
- Includes NOTES: recent prospect notes concatenated and truncated before being sent for enrichment.

### Production notes
- PM2 process name: `leads-gen-backend` (existing deployment).
- Nginx proxies `/leads-gen-api/` to `127.0.0.1:3004` (frontend uses `BASE_URL="/leads-gen-api"`).

### Troubleshooting
- Missing `OPENAI_API_KEY`: AI suggestions fall back to defaults.
- 500 errors: check logs; common causes are DB locks or missing upstream config.
- DB locked: retry after a few seconds; avoid concurrent writes.

### Safety
- Never commit secrets or .env contents.
- Back up the DB before risky changes or migrations.
