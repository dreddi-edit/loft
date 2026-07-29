# Go-Live Checklist — Hair Simo

Use this checklist when moving from **local mode** to **production on GCP**.  
Everything works locally without GCP; you only connect services and set keys.

Production region is **`europe-west8` (Milan)** and the database is **Cloud SQL for
PostgreSQL 16**. If you are reading an older runbook that says Zurich or AlloyDB, it is
out of date — see `infra/terraform/README.md`.

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
# Edit project_id, db_password, cron_secret, domains
terraform init && terraform apply
```

`terraform.tfvars` uses `db_password`. If you are carrying over an older file it will
still say `alloydb_password` — rename it, or the plan fails on an unset variable.

4. Build & push containers. The registry host follows the region:

```bash
REGION=europe-west8
docker build -f apps/web/Dockerfile   -t $REGION-docker.pkg.dev/<project>/hair-simo/web:latest .
docker build -f apps/admin/Dockerfile -t $REGION-docker.pkg.dev/<project>/hair-simo/admin:latest .
docker push ...
```

Images pushed to a `europe-west6` registry are **not** usable from `europe-west8` — the
digests pinned in `resources.tf` must be re-pinned after the first push to the new repo.

5. Add the `hair-simo-database-url` secret version. Terraform creates the secret but not
   the value, because the connection string contains the password:

```bash
terraform output database_url_hint
# postgresql://hair_simo_app:<PASSWORD>@10.x.x.x:5432/hair_simo?sslmode=require&connection_limit=4&pool_timeout=20

printf '%s' 'postgresql://…real password…' | gcloud secrets versions add hair-simo-database-url --data-file=-
```

`sslmode=require` is mandatory — the instance runs `ssl_mode = "ENCRYPTED_ONLY"` and
rejects plaintext connections.

6. Run migrations. The instance has **no public IP**, so this goes through the proxy from
   inside the VPC (or a VPN / bastion):

```bash
cloud-sql-proxy "$(terraform output -raw database_connection_name)" --private-ip --port 5433
DATABASE_URL="postgresql://hair_simo_app:…@127.0.0.1:5433/hair_simo" pnpm db:migrate
```

---

## Phase 2 — Environment variables (Secret Manager)

| Variable | When to set | What it enables |
|----------|-------------|-----------------|
| `GCP_PROJECT_ID` | **Required for GCP** | Gemini, Pub/Sub, Tasks, STT/TTS |
| `DATABASE_URL` | Always | Cloud SQL PostgreSQL connection string, private IP + `sslmode=require` |
| `JWT_SECRET` | Dev / fallback | Local admin login |
| `ADMIN_JWT_SECRET` | Always | Admin session tokens |
| `APPOINTMENT_TOKEN_SECRET` | Always | Customer appointment links |
| `GCP_REGION` | Always | `europe-west8` — Cloud Tasks, Artifact Registry, Cloud Run |
| `GCP_VERTEX_LOCATION` | Always | `europe-west1` — **not** the same as `GCP_REGION`, see below |
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
| `CRON_SECRET` | Reminder cron | Same value as `GCP_CLOUD_TASKS_SECRET` |
| `TZ=Europe/Rome` | Always | Set by Terraform on both containers |
| `PAYMENTS_MOCK_ENABLED=false` | Production | Disable dev payment mock |

### Why `GCP_REGION` and `GCP_VERTEX_LOCATION` differ

Everything regional runs in `europe-west8` (Milan): cheapest EU region, physically
closest to Brixen. Vertex AI is the exception — Gemini model availability is decided per
region and is not the same list as Cloud Run's. `GCP_VERTEX_LOCATION` therefore points at
`europe-west1` (Belgium), the closest region that reliably serves `gemini-2.5-flash`.
Data stays in the EU either way.

Before go-live, check whether the split is still needed:

```bash
gcloud ai models list --region=europe-west8 | grep -i gemini
```

If `gemini-2.5-flash` is served from `europe-west8`, set `vertex_location =
"europe-west8"` in `terraform.tfvars` and the two collapse into one.

---

## Phase 3 — Service wiring

### Chat AI (Vertex AI Gemini)
1. Set `GCP_PROJECT_ID`
2. Grant Cloud Run SA `roles/aiplatform.user` (Terraform does this)
3. Chat widget automatically uses Gemini (no code change)

### Voice (Dialogflow CX + Chirp)
1. Create Dialogflow CX agent
2. Configure Phone Gateway with an Italian number
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
3. Cloud Scheduler triggers `/api/cron/reminders` hourly on `Europe/Rome`

### Payments (Google Pay)
1. Complete Google Pay merchant registration
2. Set merchant ID + PSP gateway credentials
3. Set `PAYMENTS_MOCK_ENABLED=false`
4. PSP webhook → `POST /api/payments/webhook`

---

## Phase 4 — DNS & domains

- [ ] Point `hairsimo.example.com` → Cloud Load Balancer IP (`load_balancer_ip` output)
- [ ] Point `admin.hairsimo.example.com` → the **same** IP; the load balancer routes by host
- [ ] SSL certificates auto-provisioned by Google Managed Certs once DNS resolves

Both Cloud Run services accept load-balancer ingress only, so there is no `*.run.app`
fallback to test against. Nothing works until DNS and the certificate are in place.

---

## Cold starts

`web_min_instances` and `admin_min_instances` default to **0**. Nothing is kept warm.

**The trade.** `min_instance_count = 1` on the web service means paying for an instance
24 hours a day, 7 days a week, so that the one visitor who arrives at 04:00 on a Tuesday
does not wait. That is roughly EUR 45 a month for the old 2 vCPU / 1 GiB shape and still
around EUR 20 a month for the current 1 vCPU / 1 GiB shape. The salon takes around 260
appointments a month.

**What it costs instead.** The first request after an idle period waits for the container
to start: roughly **2-3 seconds** for the Next.js standalone server, then normal speed for
everyone behind it. In practice this is rarer than it sounds:

- the uptime check hits `/de` every 300 seconds, which keeps an instance alive through
  most of the day on its own
- `startup_cpu_boost = true` gives the container extra CPU while it boots
- Cloud CDN serves `/_next/static`, `/images`, `/videos`, `/products` and `/brand` from
  the edge, so a cold start only delays the HTML, not the 4.7 MB of assets behind it

**What it looks like when it happens.** A latency spike in the "Hair Simo Cloud Run p95
latency" alert policy, not an outage and not a 5xx. If that policy gets noisy, raise
`alert_latency_p95_ms` before you raise `web_min_instances`.

**When to change it.** Set `web_min_instances = 1` if the salon starts running paid
campaigns that land visitors on a cold site, or if the owner reports the site feeling
slow at opening time. Leave `admin_min_instances` at 0 regardless — staff log in once in
the morning and stay logged in.

---

## What stays the same after go-live

No code changes needed — only configuration:
- Website, booking, admin UI
- API routes and business logic
- Database schema and seed data (Prisma runs on Cloud SQL PostgreSQL 16 unchanged)
- Chat widget (auto-switches to Gemini when `GCP_PROJECT_ID` set)
- Voice simulator → Dialogflow CX in production

---

## Quick reference: local vs production

| Feature | Local (no GCP) | Production (GCP) |
|---------|----------------|------------------|
| Chat AI | Regex fallback | Vertex AI Gemini (`europe-west1`) |
| Voice | `/api/voice/simulate` | Dialogflow CX + Phone Gateway |
| TTS audio | Text only | Chirp 3 HD |
| Payments | Mock button | Google Pay + PSP |
| Auth | JWT + seed users | Identity Platform |
| Email | Console log | Gmail API |
| SMS/WhatsApp | Pub/Sub log | Pub/Sub + partner worker |
| Database | Local postgres | Cloud SQL PostgreSQL 16, private IP, `europe-west8` |
| Static assets | Next.js dev server | Cloud CDN |
| Time zone | `TZ=Europe/Rome` | `TZ=Europe/Rome` on both containers |

---

## Cost expectation

Roughly **EUR 75-95 a month** for a single four-chair salon, down from EUR 430-500 before
the right-sizing. The full breakdown, the assumptions behind it and what is fixed versus
traffic-driven are in `infra/terraform/README.md` under "Cost". Note that the load
balancer plus Cloud Armor account for a little under half of the remaining bill and do
not shrink with traffic.

**Before applying any of this to an environment that is already serving customers**, read
"Applying this to a running environment" in `infra/terraform/README.md`. Swapping AlloyDB
for Cloud SQL and moving region both replace resources rather than modifying them.
