output "web_service_url" {
  value = google_cloud_run_v2_service.web.uri
}

output "admin_service_url" {
  value = google_cloud_run_v2_service.admin.uri
}

output "alloydb_cluster" {
  value = google_alloydb_cluster.primary.name
}

output "pubsub_topic" {
  value = google_pubsub_topic.notifications.name
}

output "cloud_tasks_queue" {
  value = google_cloud_tasks_queue.tasks.name
}

output "load_balancer_ip" {
  value = google_compute_global_address.web_ip.address
}

output "artifact_registry" {
  value = google_artifact_registry_repository.hair_simo.name
}
