variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "Primary GCP region. europe-west8 (Milan) is the cheapest EU region close to Brixen; europe-west6 (Zurich) cost roughly 25-30% more for the same resources."
  default     = "europe-west8"
}

variable "vertex_location" {
  type        = string
  description = "Vertex AI region for Gemini. Deliberately decoupled from var.region: Gemini model availability is per region and europe-west1 (Belgium) is the closest region that reliably serves gemini-2.5-flash. See README.md 'Region'."
  default     = "europe-west1"
}

variable "environment" {
  type        = string
  description = "Deployment environment"
  default     = "production"
}

variable "web_domain" {
  type        = string
  description = "Public web domain served by the load balancer. All public traffic, the Cloud Tasks handler and the Cloud Scheduler cron target are derived from this."
  default     = "hairsimo.example.com"
}

variable "admin_domain" {
  type        = string
  description = "Admin backoffice domain served by the same load balancer"
  default     = "admin.hairsimo.example.com"
}

variable "enable_database" {
  type        = bool
  description = "Create the Cloud SQL instance, database and application user. Defaults to true: unlike the AlloyDB setup it replaced, a db-g1-small instance is cheap enough that there is no reason to run the platform without it."
  default     = true
}

variable "db_instance_name" {
  type        = string
  description = "Cloud SQL instance name. Cloud SQL reserves a deleted instance name for about a week, so bump the suffix if you ever recreate it."
  default     = "hair-simo-db"
}

variable "db_tier" {
  type        = string
  description = "Cloud SQL machine tier. db-g1-small (1 shared vCPU / 1.7 GB) carries roughly 260 appointments a month with room to spare. Move to db-custom-1-3840 or db-custom-2-7680 if query insights show sustained CPU pressure."
  default     = "db-g1-small"
}

variable "db_availability_type" {
  type        = string
  description = "ZONAL or REGIONAL. REGIONAL adds a synchronous standby and doubles the instance cost; for a salon whose booking flow tolerates a few minutes of downtime the daily backup plus PITR is the cheaper trade."
  default     = "ZONAL"

  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.db_availability_type)
    error_message = "db_availability_type must be ZONAL or REGIONAL."
  }
}

variable "db_disk_size_gb" {
  type        = number
  description = "Initial Cloud SQL data disk in GB. Autoresize is on, so this only sets the floor."
  default     = 10
}

variable "db_disk_autoresize_limit_gb" {
  type        = number
  description = "Ceiling for Cloud SQL disk autoresize. 0 means unlimited, which is how a runaway table turns into a runaway bill."
  default     = 50
}

variable "db_max_connections" {
  type        = number
  description = "Cloud SQL max_connections flag. Each PostgreSQL backend costs roughly 8 MB, so this must stay well under what db_tier's memory can hold. Keep the Prisma connection_limit in DATABASE_URL below max_connections / max Cloud Run instances."
  default     = 60
}

variable "db_name" {
  type        = string
  description = "Application database created on the Cloud SQL instance"
  default     = "hair_simo"
}

variable "db_user" {
  type        = string
  description = "Application PostgreSQL user"
  default     = "hair_simo_app"
}

variable "db_password" {
  type        = string
  description = "Password for db_user. Was named alloydb_password before the Cloud SQL migration; rename it in terraform.tfvars."
  sensitive   = true
}

variable "enable_load_balancer" {
  type        = bool
  description = "Create the external HTTPS load balancer. Required in production. When false, Cloud Run accepts all ingress (run.app URLs) for staging smoke tests."
  default     = false
}

variable "enable_cdn" {
  type        = bool
  description = "Serve /_next/static, /images, /videos, /products and /brand through Cloud CDN instead of paying Cloud Run CPU and egress for every byte."
  default     = true
}

variable "cron_secret" {
  type        = string
  description = "Shared secret for /api/cron/reminders, sent by Cloud Scheduler as X-Cron-Secret and stored as the cloud-tasks secret version"
  sensitive   = true
}

variable "admin_allowed_cidrs" {
  type        = list(string)
  description = "Source networks allowed to reach the admin backoffice through Cloud Armor. Defaults to the whole internet so nothing breaks on rollout; narrow this to the salon and operator networks."
  default     = ["0.0.0.0/0"]
}

variable "web_min_instances" {
  type        = number
  description = "Warm web instances. 0 means the first visitor after an idle period waits for a cold start (roughly 2-3 s for the Next.js standalone server); 1 means paying for an always-on instance around the clock. See docs/GO-LIVE.md 'Cold starts'."
  default     = 0
}

variable "web_max_instances" {
  type        = number
  description = "Upper bound on web instances. Also caps the number of PostgreSQL connections the web app can open."
  default     = 10
}

variable "web_cpu" {
  type        = string
  description = "vCPU limit for the web container. A Next.js standalone server for a four-chair salon does not saturate one core."
  default     = "1"
}

variable "web_memory" {
  type        = string
  description = "Memory limit for the web container"
  default     = "1Gi"
}

variable "admin_min_instances" {
  type        = number
  description = "Warm admin instances. The backoffice is used by a handful of staff during opening hours, so a cold start on first login is fine."
  default     = 0
}

variable "admin_max_instances" {
  type        = number
  description = "Upper bound on admin instances"
  default     = 3
}

variable "admin_cpu" {
  type        = string
  description = "vCPU limit for the admin container"
  default     = "1"
}

variable "admin_memory" {
  type        = string
  description = "Memory limit for the admin container"
  default     = "512Mi"
}

variable "enable_monitoring" {
  type        = bool
  description = "Create the uptime check, log based metrics, notification channel and alert policies"
  default     = true
}

variable "alert_email" {
  type        = string
  description = "Destination address for all alert policies"
  default     = "ops@hairsimo.example.com"
}

variable "alert_5xx_threshold" {
  type        = number
  description = "Cloud Run 5xx responses in a five minute window before alerting"
  default     = 5
}

variable "alert_latency_p95_ms" {
  type        = number
  description = "Cloud Run p95 request latency in milliseconds before alerting"
  default     = 2000
}

variable "alert_db_cpu_threshold" {
  type        = number
  description = "Cloud SQL average CPU utilization (0-1) before alerting. A shared-core tier is expected to sit higher than a dedicated one, so do not set this too low."
  default     = 0.85
}

variable "alert_pubsub_unacked_seconds" {
  type        = number
  description = "Age of the oldest unacknowledged notification message before alerting"
  default     = 600
}

variable "alert_payment_failure_threshold" {
  type        = number
  description = "Payment failures in a five minute window before alerting"
  default     = 3
}

variable "alert_notification_failure_threshold" {
  type        = number
  description = "Notification delivery failures in a five minute window before alerting"
  default     = 3
}
