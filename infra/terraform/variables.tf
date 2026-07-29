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
  description = "Public web domain"
  default     = "hairsimo.example.com"
}

variable "admin_domain" {
  type        = string
  description = "Admin backoffice domain"
  default     = "admin.hairsimo.example.com"
}

variable "alloydb_cluster_id" {
  type    = string
  default = "hair-simo-db"
}

variable "enable_alloydb" {
  type    = bool
  default = false
}

variable "enable_load_balancer" {
  type    = bool
  default = false
}

variable "alloydb_password" {
  type      = string
  sensitive = true
}

variable "cron_secret" {
  type        = string
  description = "Bearer token for /api/cron/reminders"
  sensitive   = true
}
