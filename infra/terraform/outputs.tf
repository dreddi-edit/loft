output "web_service_url" {
  value       = google_cloud_run_v2_service.web.uri
  description = "Internal Cloud Run URL. Not publicly reachable: ingress is load balancer only."
}

output "admin_service_url" {
  value       = google_cloud_run_v2_service.admin.uri
  description = "Internal Cloud Run URL. Not publicly reachable: ingress is load balancer only."
}

output "web_public_url" {
  value = "https://${var.web_domain}"
}

output "admin_public_url" {
  value = "https://${var.admin_domain}"
}

output "alloydb_cluster" {
  value = var.enable_alloydb ? google_alloydb_cluster.primary[0].name : null
}

output "pubsub_topic" {
  value = google_pubsub_topic.notifications.name
}

output "pubsub_dead_letter_topic" {
  value = google_pubsub_topic.notifications_dead_letter.name
}

output "cloud_tasks_queue" {
  value = google_cloud_tasks_queue.tasks.name
}

output "load_balancer_ip" {
  value       = var.enable_load_balancer ? google_compute_global_address.web_ip[0].address : null
  description = "Point the A records for web_domain and admin_domain at this address."
}

output "artifact_registry" {
  value = google_artifact_registry_repository.hair_simo.name
}

output "terraform_state_bucket" {
  value       = google_storage_bucket.terraform_state.name
  description = "Must match the bucket in the backend \"gcs\" block in main.tf."
}

output "scheduler_service_account" {
  value       = google_service_account.scheduler.email
  description = "Issuer of the OIDC token on the reminder cron call."
}

output "armor_policy" {
  value = google_compute_security_policy.armor.name
}

output "admin_armor_policy" {
  value = google_compute_security_policy.admin_armor.name
}

output "uptime_check_id" {
  value = var.enable_monitoring ? google_monitoring_uptime_check_config.web[0].uptime_check_id : null
}

output "alert_notification_channel" {
  value = var.enable_monitoring ? google_monitoring_notification_channel.email[0].id : null
}
