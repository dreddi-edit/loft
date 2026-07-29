# Hair Simo — Google Cloud Terraform

Production infrastructure for the Hair Simo salon platform on GCP.
The salon is in Brixen / Bressanone, South Tyrol, Italy — everything is `Europe/Rome`.

## Architecture

- **Cloud Run** — `web` and `admin` Next.js apps, load-balancer ingress only, Direct VPC egress
- **Cloud SQL for PostgreSQL 16** — private IP only, daily backups + PITR
- **Cloud CDN** — static assets and media served from the edge, not from Cloud Run
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

## Region

`var.region` is **`europe-west8` (Milan)**. It replaced `europe-west6` (Zurich), which is
one of the most expensive GCP regions and, despite feeling close on a map, is further from
Brixen than Milan both physically and in network terms. Everything regional — Cloud Run,
Cloud SQL, Artifact Registry, Cloud Tasks, Cloud Scheduler, the subnet and the serverless
NEGs — follows `var.region`.

Two things deliberately do **not**:

| Setting | Value | Why |
|---|---|---|
| `var.vertex_location` | `europe-west1` | Gemini model availability is per region and is not the same as Cloud Run region availability. `europe-west1` (Belgium) is the closest region that reliably serves `gemini-2.5-flash`. |
| `google_storage_bucket.terraform_state.location` | `EU` | Multi-region, so state survives a single region going away. |

Before changing `vertex_location`, confirm the model is actually served there:

```bash
gcloud ai models list --region=europe-west8 2>/dev/null | grep -i gemini
# or check the "Locations" table for the model in the Vertex AI docs
```

If `gemini-2.5-flash` is listed for `europe-west8`, set `vertex_location = "europe-west8"`
and the split disappears. Data still stays in the EU either way. Cloud Scheduler,
Cloud Tasks and Cloud Run are all available in `europe-west8`; verify with
`gcloud scheduler locations list` and `gcloud tasks locations list` before the first apply,
because those two services historically lag new regions.

## Prerequisites

1. GCP project with billing enabled
2. Terraform >= 1.5
3. `gcloud auth application-default login`
4. Enable APIs:

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
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
  servicenetworking.googleapis.com
```

`alloydb.googleapis.com` and `vpcaccess.googleapis.com` are no longer needed — the
database is Cloud SQL and Cloud Run reaches the VPC directly.

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

State contains the database password and the cron secret in plaintext, so it must not
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

## Database

`google_sql_database_instance.primary` is **Cloud SQL for PostgreSQL 16**, not AlloyDB.
AlloyDB has no small tier: its smallest primary is 2 vCPU / 16 GB at roughly EUR 240 a
month, for a salon that books around 260 appointments a month. Cloud SQL on
`db-g1-small` does the same job for well under a tenth of that.

Everything the AlloyDB configuration protected is carried over:

| Protection | Cloud SQL setting |
|---|---|
| Daily automated backups | `backup_configuration.enabled = true`, `start_time = "01:00"` UTC — 03:00 CEST / 02:00 CET in Brixen, inside the closed window |
| 35 day retention | `backup_retention_settings { retained_backups = 35, retention_unit = "COUNT" }` |
| Point-in-time recovery | `point_in_time_recovery_enabled = true` (WAL archiving), `transaction_log_retention_days = 7` |
| Deletion protection | `deletion_protection = true` (Terraform) **and** `settings.deletion_protection_enabled = true` (server side, also blocks the console) |
| Never destroyed by accident | `lifecycle { prevent_destroy = true }` on the instance and on the database |
| Private IP only | `ipv4_enabled = false`, `private_network = google_compute_network.vpc.id` — no public IP is ever assigned |
| TLS required | `ssl_mode = "ENCRYPTED_ONLY"` |
| Maintenance outside opening hours | `maintenance_window { day = 1, hour = 2 }` — Monday 02:00 UTC. The salon is open Tue-Sat 08:00-17:00 and closed Sun+Mon |
| Backups in the EU | `backup_configuration.location = "eu"` |

Two differences from the AlloyDB setup, both deliberate:

- **PITR window is 7 days, not 14.** `transaction_log_retention_days` maxes out at 7 on
  the `ENTERPRISE` edition. Only `ENTERPRISE_PLUS` goes to 35, and that edition has no
  shared-core tier, so a longer PITR window means paying for a dedicated-core instance.
  35 days of daily backups still exist; only the "restore to an arbitrary second"
  window is shorter.
- **`availability_type = "ZONAL"`.** `REGIONAL` adds a synchronous standby and doubles
  the instance cost. For a salon whose booking flow tolerates a few minutes of
  downtime, the daily backup plus PITR is the better trade. Flip
  `var.db_availability_type` if that judgement changes.

`prevent_destroy` means flipping `enable_database` back to `false` will fail the plan on
purpose. Remove the lifecycle block deliberately if you really mean to drop the database.

### DATABASE_URL

Terraform creates the `hair-simo-database-url` secret **container** but never a version:
the connection string embeds `var.db_password` and writing it here would park the
production password in the state file a second time. Add the version by hand once the
instance exists:

```bash
terraform output database_url_hint
# postgresql://hair_simo_app:<PASSWORD>@10.x.x.x:5432/hair_simo?sslmode=require&connection_limit=4&pool_timeout=20

printf '%s' 'postgresql://hair_simo_app:REAL_PASSWORD@10.x.x.x:5432/hair_simo?sslmode=require&connection_limit=4&pool_timeout=20' \
  | gcloud secrets versions add hair-simo-database-url --data-file=-
```

`sslmode=require` is not optional — `ssl_mode = "ENCRYPTED_ONLY"` rejects plaintext.

**`connection_limit` is load-bearing.** Prisma opens a pool per Cloud Run instance, and
`db-g1-small` cannot serve unlimited backends. The budget is:

```
connection_limit x (web_max_instances + admin_max_instances) < db_max_connections
              4 x (10                 + 3                  ) = 52  <  60
```

Raise `var.db_max_connections` and `var.db_tier` together if you raise the instance
caps; a shared-core instance runs out of memory long before it runs out of CPU.

Running migrations from a workstation needs the proxy, because there is no public IP:

```bash
cloud-sql-proxy "$(terraform output -raw database_connection_name)" --private-ip --port 5433
DATABASE_URL="postgresql://hair_simo_app:REAL_PASSWORD@127.0.0.1:5433/hair_simo" pnpm db:migrate
```

`--private-ip` only works from a machine inside the VPC or through a VPN/bastion.

## Networking

There is **no** `google_vpc_access_connector`. A Serverless VPC Access connector bills
two always-on `e2-micro` instances (roughly EUR 15-25/month) purely to forward Cloud Run
traffic to the private database. Cloud Run v2 does the same thing natively:

```hcl
vpc_access {
  egress = "PRIVATE_RANGES_ONLY"

  network_interfaces {
    network    = google_compute_network.vpc.name
    subnetwork = google_compute_subnetwork.subnet.name
  }
}
```

Direct VPC egress is free, has lower latency and scales with the service instead of with
a fixed pool. `PRIVATE_RANGES_ONLY` is kept, so only RFC 1918 traffic is routed through
the VPC; calls to Vertex AI, Pub/Sub and the rest still leave over the internet path.

Two consequences:

- `google_compute_subnetwork.subnet` (`10.0.0.0/24`) must be in `var.region` and must
  have room for the instances. 256 addresses against a ceiling of 13 instances is
  comfortable; a `/28` would not be.
- The Cloud Run service agent needs `roles/compute.networkUser` on the subnet. GCP grants
  it automatically on first use; if a revision fails with a network permission error,
  grant it explicitly to
  `service-<PROJECT_NUMBER>@serverless-robot-prod.iam.gserviceaccount.com`.

## CDN

`apps/web/public` is 4.7 MB — 2.5 MB of it `videos/hero-video.mp4`, 1.4 MB `images/`,
724 KB `products/`. Serving that from Cloud Run means paying container CPU and Cloud Run
egress on every single view. Cloud CDN caches it at the edge instead.

Cache policy is a property of a backend service, not of a path, so three backend
services share the one serverless NEG and `google_compute_url_map.web` routes between
them:

| Backend | Paths | Cache mode | TTL |
|---|---|---|---|
| `hair-simo-web-static-backend` | `/_next/static/*` | `CACHE_ALL_STATIC` | 1 year, client and edge |
| `hair-simo-web-media-backend` | `/images/*`, `/videos/*`, `/products/*`, `/brand/*`, `/favicon.ico` | `CACHE_ALL_STATIC` | 1 day client, 7 days edge |
| `hair-simo-web-backend` | everything else | `USE_ORIGIN_HEADERS` | whatever Next.js sends |
| `hair-simo-admin-backend` | the admin host | CDN off | — |

`/_next/static` is safe at a year because Next.js emits content-hashed filenames: a
deploy mints new URLs rather than changing old ones. The media paths are hand-managed
files with stable names, so **replacing a file in place needs an invalidation**:

```bash
gcloud compute url-maps invalidate-cdn-cache hair-simo-web-urlmap --path "/videos/hero-video.mp4"
```

HTML runs on `USE_ORIGIN_HEADERS` on purpose. Pages are localized (de/it/fr/en) and half
of them are authenticated; letting the origin decide means only responses Next.js
explicitly marks cacheable are cached, and Cloud CDN never caches a response carrying
`Set-Cookie`. `compression_mode = "AUTOMATIC"` is on for all three so text assets are
compressed at the edge.

Set `enable_cdn = false` to turn all of it off without touching the routing.

## Ingress and reachability

Both Cloud Run services set `ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"`.
The `*.run.app` URLs are not reachable, which is the point: previously anyone
could hit them directly and bypass Cloud Armor entirely.

Consequences:

- **`enable_load_balancer` must be `true` in production.** With it `false` nothing is
  publicly reachable and the reminder cron cannot run.
- `NEXT_PUBLIC_BASE_URL`, `GCP_CLOUD_TASKS_HANDLER_URL` and the Cloud Scheduler target
  are all derived from `var.web_domain` / `var.admin_domain`. No hardcoded project
  numbers.
- DNS: point A records for both `web_domain` and `admin_domain` at the
  `load_balancer_ip` output. The managed certificate covers both names and is only
  issued once DNS resolves. `google_compute_global_address.web_ip` is **global**, so it
  survived the region change and the DNS records did not have to move.
- `roles/run.invoker` for `allUsers` is granted explicitly on both services. Serverless
  NEGs cannot authenticate to Cloud Run, so this is required for the load balancer to
  work at all. The perimeter is the ingress setting plus the Cloud Armor policies, not
  Cloud Run IAM.

### Cloud Armor

Both policies are **Standard tier**. Adaptive Protection
(`layer_7_ddos_defense_config`) is deliberately **not** enabled: it requires Cloud Armor
Enterprise at roughly USD 3,000/month. There is a comment saying so above both policies —
do not delete it and do not enable the feature without a budget decision.

`hair-simo-armor` rate-limits at 100 requests per IP per minute. Cloud Armor is evaluated
at the edge on cache hits too, so a media-heavy page can burn through that faster than it
looks. If real visitors start seeing 429s, raise the threshold rather than removing the
rule.

### Admin allowlist

`hair-simo-admin-armor` denies by default and only allows `var.admin_allowed_cidrs`.
The default is `["0.0.0.0/0"]` so the rollout breaks nothing, which means the backoffice
is initially protected only by application login and the WAF rules. **Narrow it** to the
salon and operator networks as soon as those addresses are known.

### Cron authentication

Cloud Scheduler takes ownership of the `Authorization` header as soon as an auth token
is configured, so the job sends:

- `Authorization: Bearer <OIDC token>` issued for `hair-simo-scheduler@…`
- `X-Cron-Secret: <var.cron_secret>`

`apps/web/app/api/cron/reminders/route.ts` must accept the shared secret from
`x-cron-secret` in addition to `authorization`, otherwise every run returns 401.
The job runs on `Europe/Rome`, not UTC.

## Scaling and cold starts

`web_min_instances` and `admin_min_instances` both default to **0**. Nothing is kept
warm, so the first request after an idle period pays a cold start of roughly 2-3 seconds
for the Next.js standalone server. For a salon website that is an acceptable trade
against paying for an always-on instance 24/7 — see docs/GO-LIVE.md "Cold starts" for
the numbers and the symptoms.

Two settings soften it:

- `startup_cpu_boost = true` gives the container extra CPU while it boots.
- `cpu_idle = true` bills CPU only while a request is in flight.

Sizing was dropped from 2 vCPU / 1 GiB to 1 vCPU / 1 GiB for `web` and left at
1 vCPU / 512 MiB for `admin`. A Next.js standalone server for a four-chair salon does
not saturate a single core; the 2 vCPU limit was never reached.

The uptime check runs every 300 s against `/de`, which in practice keeps at least one web
instance warm during most of the day anyway.

## Backups

See "Database" above. In short: daily backups at 01:00 UTC retained 35 days, PITR with a
7 day WAL window, `deletion_protection` on both the Terraform resource and the instance
itself, `prevent_destroy` on the instance and the database.

## Monitoring

Everything is gated on `var.enable_monitoring` (default `true`) and notifies
`var.alert_email`.

| Alert policy | Fires when |
|---|---|
| Hair Simo web unreachable | uptime check on `https://<web_domain>/de` fails from multiple regions |
| Hair Simo Cloud Run 5xx rate | > `alert_5xx_threshold` 5xx responses per 5 min |
| Hair Simo Cloud Run p95 latency | p95 > `alert_latency_p95_ms` for 10 min |
| Hair Simo Cloud SQL CPU high | average CPU > `alert_db_cpu_threshold` for 10 min |
| Hair Simo notification backlog | oldest unacked message older than `alert_pubsub_unacked_seconds`, or messages hitting the dead letter topic |
| Hair Simo payment failures | log metric `hair_simo_payment_failures` over threshold |
| Hair Simo notification delivery failures | log metric `hair_simo_notification_failures` over threshold |

Log based metrics match the application's own error strings (`PAYMENT_*_FAILED`,
`[notification:gmail-error]`) plus 5xx request logs on the relevant API paths. If those
strings change in the app, update the filters in `resources.tf`.

With `web_min_instances = 0`, expect the p95 latency policy to be the noisiest one: a
cold start on the first request of the morning is a latency spike, not an outage. Raise
`alert_latency_p95_ms` before you raise `web_min_instances`.

## Cost

Monthly, EUR, excluding VAT. Assumptions: one four-chair salon, around **260
appointments a month**, roughly **3,000 page views a month**, open Tue-Sat 08:00-17:00,
`db-g1-small` `ZONAL`, `web_min_instances = 0`, CDN on, Cloud Armor Standard, no
Enterprise tiers anywhere.

| Line item | Before (Zurich + AlloyDB) | After (Milan + Cloud SQL) |
|---|---:|---:|
| Database | 240 — AlloyDB 2 vCPU / 16 GB, the smallest primary that exists | 30 — Cloud SQL `db-g1-small` + 10 GB SSD + backup storage |
| Serverless VPC connector | 20 — 2 × `e2-micro`, always on | 0 — Direct VPC egress |
| Cloud Run `web` | 45 — 2 vCPU / 1 GiB, `min_instance_count = 1` | 2 — 1 vCPU / 1 GiB, scales to zero |
| Cloud Run `admin` | 20 — 1 vCPU / 512 MiB, `min_instance_count = 1` | 1 — scales to zero |
| Load balancer | 20 — forwarding rule + data processing | 19 |
| Cloud Armor Standard | 24 — 2 policies × (5 + 7 rules) | 24 |
| Static asset egress | 5 — 4.7 MB per cold visitor, straight off Cloud Run | 1 — CDN cache egress + fill |
| Vertex AI Gemini 2.5 Flash | 3 | 3 |
| Artifact Registry, Secret Manager, Pub/Sub, Cloud Tasks, Scheduler, GCS state | 3 | 3 |
| Cloud Monitoring + Logging above the free tier | 3 | 2 |
| Regional premium (Zurich is 20-30% above Milan on compute and storage) | ~45 | 0 |
| **Total** | **≈ 430-500** | **≈ 75-95** |

What the remaining bill is actually made of: the load balancer and Cloud Armor together
are EUR 43 of it and are fixed regardless of traffic, and Cloud SQL is EUR 30. Compute is
under EUR 5. Further savings would have to come from dropping Cloud Armor (do not) or
from moving off the global load balancer (which would mean giving up the ingress
restriction), so this is close to the floor for this shape of deployment.

Numbers are list price and rounded; check the Google Cloud pricing calculator for the
exact figures in `europe-west8` before quoting them to anyone.

## Applying this to a running environment

Most of the changes above are **destructive** if applied in place. Read this before
running `terraform apply` against an environment that already serves customers.

| Change | Destructive? | What happens |
|---|---|---|
| AlloyDB → Cloud SQL | **Yes, total** | Different engine and different endpoint. The plan will refuse outright because `prevent_destroy` is set on the AlloyDB resources. Data does not migrate itself. |
| `europe-west6` → `europe-west8` | **Yes, wide** | Regional resources are replaced, not moved: both Cloud Run services, the Artifact Registry repo (images must be rebuilt and re-pushed to the new host), the Cloud Tasks queue (queued tasks are lost), the Cloud Scheduler job, the subnet and both serverless NEGs. |
| Drop the VPC connector | No, but ordering matters | Cloud Run gets a new revision. Applied at the same time as the database swap there is a window where the new revision points at a database that is not there yet. |
| Cloud CDN + new backend services | No | New backend services and a rewritten URL map. Traffic keeps flowing; worst case a misrouted path 404s until fixed. |
| `min_instance_count` 1 → 0 | No | Latency profile changes, nothing is deleted. |
| Cloud Run cpu/memory | No | New revision, rolling. |
| Variable renames (`alloydb_password` → `db_password`, `alloydb_cluster_id` → `db_instance_name`, `enable_alloydb` → `enable_database`, `alert_alloydb_cpu_threshold` → `alert_db_cpu_threshold`) | No, but the plan fails | `terraform.tfvars` must be updated first or the plan errors on an unset required variable. |
| Load balancer IP | No | `google_compute_global_address.web_ip` is global. The IP and therefore the DNS records survive. |

### Migration path

Because the region change replaces nearly everything anyway, do **not** mutate the
running stack. Stand up the new one beside it and cut over with DNS:

1. **Freeze.** Announce a maintenance window on a Sunday or Monday — the salon is
   closed and no bookings are being taken.
2. **Dump.** `pg_dump --format=custom` from AlloyDB through the existing connector or a
   bastion in `europe-west6`. Verify the dump restores into a scratch database before
   trusting it.
3. **Build.** New workspace / new state prefix, `region = "europe-west8"`,
   `enable_load_balancer = false` initially so the new stack has no public surface.
   Apply. This creates the Cloud SQL instance, the VPC, the subnet and both services.
4. **Push images.** Rebuild and push `web` and `admin` to
   `europe-west8-docker.pkg.dev/<project>/hair-simo/…` and update the two image digests
   in `resources.tf`. The `europe-west6` digests are not valid in the new repo.
5. **Restore.** `pg_restore` into the Cloud SQL instance through `cloud-sql-proxy
   --private-ip` from a VM in the new VPC. Then `pnpm db:migrate` to confirm the schema
   is at head.
6. **Secret.** Add the new `hair-simo-database-url` version (see "Database" above) and
   redeploy both services so they pick it up.
7. **Verify with the LB off.** Temporarily set `ingress` to allow direct access, or use
   `gcloud run services proxy`, and walk the booking flow end to end: availability,
   booking, deposit, confirmation email, reminder cron.
8. **Cut over.** Set `enable_load_balancer = true`, apply, wait for the managed
   certificate, then repoint DNS. Keep the old stack running until the new one has
   served a full week.
9. **Reconcile before teardown.** Bookings taken during the window land in the old
   database. Either keep the booking form closed for the whole window or replay the
   delta before switching off the old stack.
10. **Tear down.** Remove the `prevent_destroy` blocks on the old AlloyDB resources
    deliberately, take a final backup, then destroy the old workspace. Cloud SQL and
    AlloyDB both reserve a deleted instance name for about a week, so do not plan to
    reuse the name immediately.

If you only want the cheap parts and are not ready for the database move: apply I3
(Direct VPC egress), I4 (`min_instance_count = 0` and the resource limits) and I5 (CDN)
on their own against the existing region. Those three are non-destructive and are worth
roughly EUR 90 a month on their own.

## Post-deploy

1. Build and push container images to `europe-west8-docker.pkg.dev/<project>/hair-simo/`
2. Point DNS for `web_domain` and `admin_domain` at the `load_balancer_ip` output
3. Add the `hair-simo-database-url` secret version (see "Database")
4. Configure Dialogflow CX agent webhook → `https://<web-domain>/api/voice/dialogflow`
5. Enable Phone Gateway in Dialogflow CX with an Italian number
6. Create Identity Platform users matching seed emails
7. Configure Google Pay merchant ID and PSP gateway credentials in Secret Manager
8. Confirm the alert email address in the Cloud Monitoring notification channel
9. Narrow `admin_allowed_cidrs`

## Variables

See `variables.tf` for the full list.

| Variable | Description | Default |
|----------|-------------|---------|
| `project_id` | GCP project ID | required |
| `region` | Primary region | `europe-west8` |
| `vertex_location` | Vertex AI region for Gemini, decoupled on purpose | `europe-west1` |
| `environment` | `staging` or `production` | `production` |
| `web_domain` | Public LB domain, drives every public URL | `hairsimo.example.com` |
| `admin_domain` | Backoffice LB domain | `admin.hairsimo.example.com` |
| `enable_database` | Create the Cloud SQL instance, database and user | `true` |
| `db_instance_name` | Cloud SQL instance name | `hair-simo-db` |
| `db_tier` | Cloud SQL machine tier | `db-g1-small` |
| `db_availability_type` | `ZONAL` or `REGIONAL` | `ZONAL` |
| `db_disk_size_gb` | Initial data disk, autoresize is on | `10` |
| `db_disk_autoresize_limit_gb` | Ceiling for autoresize, 0 means unlimited | `50` |
| `db_max_connections` | PostgreSQL `max_connections` flag | `60` |
| `db_name` | Application database | `hair_simo` |
| `db_user` | Application PostgreSQL user | `hair_simo_app` |
| `db_password` | Password for `db_user` (was `alloydb_password`) | required, sensitive |
| `cron_secret` | Shared secret for the reminder cron | required, sensitive |
| `enable_load_balancer` | Create the LB — required in production | `false` |
| `enable_cdn` | Cloud CDN in front of static assets and media | `true` |
| `web_min_instances` | Warm web instances, 0 accepts a cold start | `0` |
| `web_max_instances` | Upper bound on web instances | `10` |
| `web_cpu` / `web_memory` | Web container limits | `1` / `1Gi` |
| `admin_min_instances` | Warm admin instances | `0` |
| `admin_max_instances` | Upper bound on admin instances | `3` |
| `admin_cpu` / `admin_memory` | Admin container limits | `1` / `512Mi` |
| `admin_allowed_cidrs` | Source networks allowed to reach the backoffice | `["0.0.0.0/0"]` |
| `enable_monitoring` | Create uptime check, log metrics and alert policies | `true` |
| `alert_email` | Alert destination address | `ops@hairsimo.example.com` |
| `alert_5xx_threshold` | 5xx responses per 5 min before alerting | `5` |
| `alert_latency_p95_ms` | p95 latency in ms before alerting | `2000` |
| `alert_db_cpu_threshold` | Cloud SQL CPU utilization (0-1) before alerting | `0.85` |
| `alert_pubsub_unacked_seconds` | Oldest unacked message age before alerting | `600` |
| `alert_payment_failure_threshold` | Payment failures per 5 min before alerting | `3` |
| `alert_notification_failure_threshold` | Notification failures per 5 min before alerting | `3` |
