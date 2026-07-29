# Hair Simo — Google Cloud Terraform

Production infrastructure for the Hair Simo salon platform on GCP.
The salon is in Brixen / Bressanone, South Tyrol, Italy — everything is `Europe/Rome`.

## Architecture

- **Cloud Run** — `web` and `admin` Next.js apps, load-balancer ingress only
- **AlloyDB** — PostgreSQL-compatible primary database, daily backups + PITR
- **Identity Platform** — Admin authentication
- **Vertex AI Gemini 2.5** — Chat AI with function calling
- **Dialogflow CX + Phone Gateway** — Voice telephony
- **Cloud Speech-to-Text (Chirp)** — Speech recognition
- **Cloud Text-to-Speech (Chirp 3 HD)** — Natural voice synthesis
- **Cloud Armor** — WAF (OWASP CRS), rate limiting, admin source allowlist
- **Secret Manager** — Credentials and API keys
- **Pub/Sub + Cloud Tasks** — Async notifications with a dead letter topic
- **Cloud Scheduler** — Appointment reminders
- **Cloud Monitoring** — Uptime check, log based metrics, alert policies

## Prerequisites

1. GCP project with billing enabled
2. Terraform >= 1.5
3. `gcloud auth application-default login`
4. Enable APIs:

```bash
gcloud services enable \
  run.googleapis.com \
  alloydb.googleapis.com \
  secretmanager.googleapis.com \
  pubsub.googleapis.com \
  cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com \
  aiplatform.googleapis.com \
  dialogflow.googleapis.com \
  speech.googleapis.com \
  texttospeech.googleapis.com \
  identitytoolkit.googleapis.com \
  compute.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  monitoring.googleapis.com \
  logging.googleapis.com \
  storage.googleapis.com \
  vpcaccess.googleapis.com \
  servicenetworking.googleapis.com
```

## Usage

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your project_id, domains and secrets

terraform init
terraform plan
terraform apply
```

## Remote state

State contains the AlloyDB password and the cron secret in plaintext, so it must not
live on a laptop. It is stored in the GCS bucket `hair-simo-tfstate-683522826150`
(versioned, uniform bucket level access, public access prevented, 10 noncurrent
versions retained, `prevent_destroy`).

A `backend` block cannot use variables, so the bucket name is hardcoded in **two**
places that must stay in sync:

- `google_storage_bucket.terraform_state.name` in `main.tf`
- the commented `backend "gcs"` block in `main.tf`

If you deploy into a different project, change both.

### One-time migration to remote state

```bash
cd infra/terraform

# 1. Create the bucket while state is still local
terraform apply -target=google_storage_bucket.terraform_state

# 2. Uncomment the backend "gcs" block in main.tf

# 3. Copy the local state into the bucket
terraform init -migrate-state
# answer "yes" when asked to copy the existing state

# 4. Verify, then delete the local copies
terraform plan          # must show no changes
rm terraform.tfstate terraform.tfstate.backup
```

After migration, `terraform.tfvars` still holds secrets locally — keep it gitignored.

## Ingress and reachability

Both Cloud Run services set `ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"`.
The `*.run.app` URLs are no longer reachable, which is the point: previously anyone
could hit them directly and bypass Cloud Armor entirely.

Consequences:

- **`enable_load_balancer` must be `true` in production.** With it `false` nothing is
  publicly reachable and the reminder cron cannot run.
- `NEXT_PUBLIC_BASE_URL`, `GCP_CLOUD_TASKS_HANDLER_URL` and the Cloud Scheduler target
  are all derived from `var.web_domain` / `var.admin_domain`. No more hardcoded
  project numbers.
- DNS: point A records for both `web_domain` and `admin_domain` at the
  `load_balancer_ip` output. The managed certificate covers both names and is only
  issued once DNS resolves.
- `roles/run.invoker` for `allUsers` is granted explicitly on both services. Serverless
  NEGs cannot authenticate to Cloud Run, so this is required for the load balancer to
  work at all. The perimeter is the ingress setting plus the Cloud Armor policies, not
  Cloud Run IAM.

### Admin allowlist

`hair-simo-admin-armor` denies by default and only allows `var.admin_allowed_cidrs`.
The default is `["0.0.0.0/0"]` so the rollout breaks nothing, which means the backoffice
is initially protected only by application login and the WAF rules. **Narrow it** to the
salon and operator networks as soon as those addresses are known.

### Cron authentication

Cloud Scheduler takes ownership of the `Authorization` header as soon as an auth token
is configured, so the job now sends:

- `Authorization: Bearer <OIDC token>` issued for `hair-simo-scheduler@…`
- `X-Cron-Secret: <var.cron_secret>`

`apps/web/app/api/cron/reminders/route.ts` must accept the shared secret from
`x-cron-secret` in addition to `authorization`, otherwise every run returns 401.

## Backups

`google_alloydb_cluster.primary` has:

- daily automated backups at 01:00 UTC (03:00 CEST / 02:00 CET in Brixen), 1 hour
  backup window, 35 day retention
- continuous backup with a 14 day PITR recovery window
- `deletion_policy = "DEFAULT"` and `prevent_destroy` on both cluster and instance

`prevent_destroy` means flipping `enable_alloydb` back to `false` will fail the plan on
purpose. Remove the lifecycle block deliberately if you really mean to drop the database.

## Monitoring

Everything is gated on `var.enable_monitoring` (default `true`) and notifies
`var.alert_email`.

| Alert policy | Fires when |
|---|---|
| Hair Simo web unreachable | uptime check on `https://<web_domain>/de` fails from multiple regions |
| Hair Simo Cloud Run 5xx rate | > `alert_5xx_threshold` 5xx responses per 5 min |
| Hair Simo Cloud Run p95 latency | p95 > `alert_latency_p95_ms` for 10 min |
| Hair Simo AlloyDB CPU high | average CPU > `alert_alloydb_cpu_threshold` for 10 min |
| Hair Simo notification backlog | oldest unacked message older than `alert_pubsub_unacked_seconds`, or messages hitting the dead letter topic |
| Hair Simo payment failures | log metric `hair_simo_payment_failures` over threshold |
| Hair Simo notification delivery failures | log metric `hair_simo_notification_failures` over threshold |

Log based metrics match the application's own error strings (`PAYMENT_*_FAILED`,
`[notification:gmail-error]`) plus 5xx request logs on the relevant API paths. If those
strings change in the app, update the filters in `resources.tf`.

## Post-deploy

1. Build and push container images (Cloud Build triggers included)
2. Point DNS for `web_domain` and `admin_domain` at the `load_balancer_ip` output
3. Configure Dialogflow CX agent webhook → `https://<web-domain>/api/voice/dialogflow`
4. Enable Phone Gateway in Dialogflow CX
5. Create Identity Platform users matching seed emails
6. Configure Google Pay merchant ID and PSP gateway credentials in Secret Manager
7. Confirm the alert email address in the Cloud Monitoring notification channel
8. Narrow `admin_allowed_cidrs`

## Variables

See `variables.tf` for the full list.

| Variable | Description | Default |
|----------|-------------|---------|
| `project_id` | GCP project ID | required |
| `region` | Primary region | `europe-west6` |
| `environment` | `staging` or `production` | `production` |
| `web_domain` | Public LB domain, drives every public URL | `hairsimo.example.com` |
| `admin_domain` | Backoffice LB domain | `admin.hairsimo.example.com` |
| `alloydb_password` | Initial postgres password | required, sensitive |
| `cron_secret` | Shared secret for the reminder cron | required, sensitive |
| `enable_alloydb` | Create the database | `false` |
| `enable_load_balancer` | Create the LB — required in production | `false` |
| `admin_allowed_cidrs` | Source networks allowed to reach the backoffice | `["0.0.0.0/0"]` |
| `enable_monitoring` | Create uptime check, log metrics and alert policies | `true` |
| `alert_email` | Alert destination address | `ops@hairsimo.example.com` |
| `alert_5xx_threshold` | 5xx responses per 5 min before alerting | `5` |
| `alert_latency_p95_ms` | p95 latency in ms before alerting | `2000` |
| `alert_alloydb_cpu_threshold` | AlloyDB CPU utilization (0-1) before alerting | `0.85` |
| `alert_pubsub_unacked_seconds` | Oldest unacked message age before alerting | `600` |
| `alert_payment_failure_threshold` | Payment failures per 5 min before alerting | `3` |
| `alert_notification_failure_threshold` | Notification failures per 5 min before alerting | `3` |
