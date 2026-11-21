# Deployment Guide

1. Node ≥ 20; deploy `mineralbridge-backend` as today.
2. Set env secrets (JWT, Mongo, cookies, optional BTC/payment).
3. No production collection drops. Additive indexes/fields only; migrations need approval.
4. Process starts outbox worker automatically (`server.ts`).
5. Smoke: `/health`, `/v2/health` + `X-Client: mobile`, `/v2/admin/health` + `X-Client: admin`, legacy `/v1` path.
6. Clients cut over to `/v2` gradually; keep `/v1` until approved cut-over.
