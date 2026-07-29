# Go-Live Checklist — Hair Simo

Use this checklist when moving from **local mode** to **production on GCP**.  
Everything works locally without GCP; you only connect services and set keys.

---

## Phase 0 — Local verification (no GCP)

```bash
cp .env.example .env
# Set JWT_SECRET only

pnpm install
pnpm db:setup
pnpm dev
```

Verify:
- [ ] Website: http://localhost:3000/de
- [ ] Booking wizard: full flow including **Simulate payment**
- [ ] Chat widget: text + voice simulator tabs
- [ ] Admin: http://localhost:3001/login (team account from seed)
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

---

## Phase 1 — GCP project setup

1. Create GCP project with billing
2. Enable APIs (see `infra/terraform/README.md`)
3. Run Terraform:

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit project_id, passwords, domains
terraform init && terraform apply
```

4. Build & push containers:

```bash
docker build -f apps/web/Dockerfile -t <region>-docker.pkg.dev/<project>/hair-simo/web:latest .
docker build -f apps/admin/Dockerfile -t <region>-docker.pkg.dev/<project>/hair-simo/admin:latest .
docker push ...
```

---

## Phase 2 — Environment variables (Secret Manager)

| Variable | When to set | What it enables |
|----------|-------------|-----------------|
| `GCP_PROJECT_ID` | **Required for GCP** | Gemini, Pub/Sub, Tasks, STT/TTS |
| `DATABASE_URL` | Always | AlloyDB connection string |
| `JWT_SECRET` | Dev / fallback | Local admin login |
| `GCP_IDENTITY_PLATFORM_ENABLED=true` | Production auth | Firebase admin login |
| `GCP_GEMINI_MODEL` | Optional | Default: `gemini-2.5-flash` |
| `GCP_DIALOGFLOW_AGENT_ID` | Voice telephony | Phone Gateway webhook |
| `GCP_GMAIL_SENDER` | Email notifications | Gmail API sender |
| `GCP_GOOGLE_PAY_MERCHANT_ID` | Real payments | Google Pay button |
| `GCP_PAYMENT_GATEWAY` | Real payments | PSP gateway name |
| `GCP_PAYMENT_GATEWAY_MERCHANT_ID` | Real payments | PSP merchant ID |
| `GCP_PAYMENT_WEBHOOK_SECRET` | Real payments | Webhook auth |
| `GCP_CLOUD_TASKS_HANDLER_URL` | Async notifications | Task handler URL |
| `GCP_CLOUD_TASKS_SECRET` | Async notifications | Task auth |
| `PAYMENTS_MOCK_ENABLED=false` | Production | Disable dev payment mock |

---

## Phase 3 — Service wiring

### Chat AI (Vertex AI Gemini)
1. Set `GCP_PROJECT_ID`
2. Grant Cloud Run SA `roles/aiplatform.user`
3. Chat widget automatically uses Gemini (no code change)

### Voice (Dialogflow CX + Chirp)
1. Create Dialogflow CX agent
2. Configure Phone Gateway (Swiss number)
3. Webhook URL: `https://<web-domain>/api/voice/dialogflow`
4. Chirp STT/TTS enabled via GCP project

### Admin Auth (Identity Platform)
1. Enable Identity Platform in GCP Console
2. Set `GCP_IDENTITY_PLATFORM_ENABLED=true`
3. Create users matching seed emails with custom claims: `{ "role": "owner" }`
4. Update admin login UI to use Firebase Auth SDK (optional — API already accepts `idToken`)

### Notifications
1. Set `GCP_GMAIL_SENDER` + grant `gmail.send` scope to service account
2. Pub/Sub topic created by Terraform
3. Cloud Scheduler triggers `/api/notifications/reminder`

### Payments (Google Pay)
1. Complete Google Pay merchant registration
2. Set merchant ID + PSP gateway credentials
3. Set `PAYMENTS_MOCK_ENABLED=false`
4. PSP webhook → `POST /api/payments/webhook`

---

## Phase 4 — DNS & domains

- [ ] Point `hairsimo.example.com` → Cloud Load Balancer IP (Terraform output)
- [ ] Point `admin.hairsimo.example.com` → Admin Cloud Run URL or separate LB
- [ ] SSL certificates auto-provisioned by Google Managed Certs

---

## What stays the same after go-live

No code changes needed — only configuration:
- Website, booking, admin UI
- API routes and business logic
- Database schema and seed data
- Chat widget (auto-switches to Gemini when `GCP_PROJECT_ID` set)
- Voice simulator → Dialogflow CX in production

---

## Quick reference: local vs production

| Feature | Local (no GCP) | Production (GCP) |
|---------|----------------|------------------|
| Chat AI | Regex fallback | Vertex AI Gemini |
| Voice | `/api/voice/simulate` | Dialogflow CX + Phone Gateway |
| TTS audio | Text only | Chirp 3 HD |
| Payments | Mock button | Google Pay + PSP |
| Auth | JWT + seed users | Identity Platform |
| Email | Console log | Gmail API |
| SMS/WhatsApp | Pub/Sub log | Pub/Sub + partner worker |
