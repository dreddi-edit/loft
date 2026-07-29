variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "Primary GCP region"
  default     = "europe-west6"
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

variable "alloydb_cluster_id" {
  type        = string
  description = "AlloyDB cluster ID"
  default     = "hair-simo-db"
}

variable "enable_alloydb" {
  type        = bool
  description = "Create the AlloyDB cluster and primary instance"
  default     = false
}

variable "enable_load_balancer" {
  type        = bool
  description = "Create the external HTTPS load balancer. Required in production: both Cloud Run services only accept load balancer ingress."
  default     = false
}

variable "alloydb_password" {
  type        = string
  description = "Initial postgres user password for AlloyDB"
  sensitive   = true
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

variable "alert_alloydb_cpu_threshold" {
  type        = number
  description = "AlloyDB average CPU utilization (0-1) before alerting"
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
