SaaS Gateway Delivery Summary

Scope
- Static loopback under `/st` with HTML injection and CSP relax (no upstream changes)
- Unified API gateway with JSON errors, diagnostics headers, KillList, fallback toggle
- Compatibility endpoints for settings, characters, chats, assets, presets, worldinfo, extensions, search
- Auth + session via JWT cookie `st_access` (email/password + optional card code)
- Storage adapter: auto-select PostgreSQL or file DB with identical API
- Diagnostics + CI with Playwright artifacts

Run
- Start: `node gateway/server.js` → http://localhost:3080/st
- Auth page: http://localhost:3080/st-auth
- Toggle fallback/KillList: `POST /api/_diagnostics/toggle`
- Metrics: `GET /api/_diagnostics/metrics` (p95 per route)

Config
- ST_ENABLE_FALLBACK=true ST_UPSTREAM_BASE=http://127.0.0.1:8000
- ST_KILLLIST=true (block fallback for owned endpoints)
- ST_AUTH_SECRET=<secret>
- PG_URL or DATABASE_URL to enable PostgreSQL

Data Model (PG)
- st_users(id,email,password_hash,tenant_id)
- st_entitlements(user_id,payload jsonb)
- st_settings(user_id,payload jsonb)
- st_characters(user_id,avatar,payload jsonb) index(user_id,avatar)
- st_chats(user_id,character_id,chat_name,messages jsonb) index(user_id,character_id)
- st_presets(user_id,name,payload jsonb) index(user_id,name)
- st_worldinfo(user_id,items jsonb)

Error & Auth Strategy
- Always JSON errors; diagnostic headers: x-st-request-id, x-st-proxy-target, x-st-auth-source
- Write requests require Authorization (from cookie or header). Gateway injects Authorization in front-end via `traffic.js` (fetch + XHR)
- Registration requires card code and auto-grants 30 days entitlement. Login enforces valid entitlements (402) when `ENFORCE_RIGHTS_ON_LOGIN` is enabled (default true). Use `POST /api/_diagnostics/revoke-rights` to simulate expiry in tests.

Mapping & KillList
- Owned endpoints enumerated in `gateway/mapping.js` (includes settings/characters/chats/assets/presets/worldinfo/extensions/search/rights/csrf/diagnostics)
- KillList blocks fallback when enabled; unmatched endpoints radar at `gateway/logs/radar.log`

E2E & CI
- Playwright config in `gateway/e2e`. Run `npm run test:e2e` (after `npx playwright install`).
- GitHub Action `.github/workflows/e2e.yml` collects trace/video/screenshots and diagnostics snapshots.

Known Notes
- Extensions/search/worldinfo import/export are minimal placeholders satisfying UI flows; can be expanded to full fidelity.
- Group chats endpoints are stubs; data model accommodates expansion.
