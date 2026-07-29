resource "google_artifact_registry_repository" "hair_simo" {
  location      = var.region
  repository_id = "hair-simo"
  description   = "Hair Simo container images"
  format        = "DOCKER"
  labels        = local.labels
}

resource "google_pubsub_topic" "notifications" {
  name   = "hair-simo-${var.environment}-notifications"
  labels = local.labels
}

resource "google_pubsub_subscription" "notifications_worker" {
  name  = "hair-simo-${var.environment}-notifications-worker"
  topic = google_pubsub_topic.notifications.name

  ack_deadline_seconds = 60
  labels               = local.labels
}

resource "google_cloud_tasks_queue" "tasks" {
  name     = "hair-simo-${var.environment}-tasks"
  location = var.region

  rate_limits {
    max_dispatches_per_second = 10
  }

  retry_config {
    max_attempts = 5
  }
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "hair-simo-database-url"
  labels    = local.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "jwt_secret" {
  secret_id = "hair-simo-jwt-secret"
  labels    = local.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "payment_webhook_secret" {
  secret_id = "hair-simo-payment-webhook-secret"
  labels    = local.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "cloud_tasks_secret" {
  secret_id = "hair-simo-cloud-tasks-secret"
  labels    = local.labels

  replication {
    auto {}
  }
}

resource "google_alloydb_cluster" "primary" {
  count      = var.enable_alloydb ? 1 : 0
  cluster_id = var.alloydb_cluster_id
  location   = var.region
  labels     = local.labels

  network_config {
    network = google_compute_network.vpc.id
  }

  initial_user {
    user     = "postgres"
    password = var.alloydb_password
  }

  depends_on = [google_service_networking_connection.private_vpc_connection]
}

resource "google_alloydb_instance" "primary" {
  count         = var.enable_alloydb ? 1 : 0
  cluster       = google_alloydb_cluster.primary[0].name
  instance_id   = "${var.alloydb_cluster_id}-primary"
  instance_type = "PRIMARY"

  machine_config {
    cpu_count = 2
  }

  depends_on = [google_service_networking_connection.private_vpc_connection]
}

resource "google_compute_network" "vpc" {
  name                    = "hair-simo-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  name          = "hair-simo-subnet"
  ip_cidr_range = "10.0.0.0/24"
  region        = var.region
  network       = google_compute_network.vpc.id
}

resource "google_compute_global_address" "private_service_range" {
  name          = "hair-simo-private-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_range.name]
}

resource "google_vpc_access_connector" "connector" {
  name          = "hs-stg-conn"
  region        = var.region
  network       = google_compute_network.vpc.name
  ip_cidr_range = "10.8.0.0/28"
  min_instances = 2
  max_instances = 3
}

resource "google_cloud_run_v2_service" "web" {
  name     = "hair-simo-web"
  location = var.region
  labels   = local.labels

  template {
    service_account = google_service_account.run.email

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/hair-simo/web@sha256:ac0ac46bc29077807fd3df0b7893c722b1e4b33eef4059a8d937c2481ac1cbd1"

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }

      env {
        name  = "GCP_REGION"
        value = var.region
      }

      env {
        name  = "GCP_VERTEX_LOCATION"
        value = "europe-west1"
      }

      env {
        name  = "GCP_GEMINI_MODEL"
        value = "gemini-2.5-flash"
      }

      env {
        name  = "GCP_PUBSUB_TOPIC_NOTIFICATIONS"
        value = google_pubsub_topic.notifications.name
      }

      env {
        name  = "GCP_CLOUD_TASKS_QUEUE"
        value = google_cloud_tasks_queue.tasks.name
      }

      env {
        name  = "GCP_CLOUD_TASKS_HANDLER_URL"
        value = "https://hair-simo-web-${data.google_project.current.number}.${var.region}.run.app/api/tasks/notification"
      }

      env {
        name  = "NEXT_PUBLIC_BASE_URL"
        value = "https://hair-simo-web-${data.google_project.current.number}.${var.region}.run.app"
      }

      env {
        name  = "PAYMENTS_MOCK_ENABLED"
        value = "true"
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.jwt_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GCP_CLOUD_TASKS_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.cloud_tasks_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "CRON_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.cloud_tasks_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GCP_PAYMENT_WEBHOOK_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.payment_webhook_secret.secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "1Gi"
        }
      }
    }

    scaling {
      min_instance_count = 1
      max_instance_count = 10
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [google_artifact_registry_repository.hair_simo]
}

resource "google_cloud_run_v2_service" "admin" {
  name     = "hair-simo-admin"
  location = var.region
  labels   = local.labels

  template {
    service_account = google_service_account.run.email

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/hair-simo/admin@sha256:5242ab44a6e667a60101461e7c7f1d599719f1033c6ed28f021e303d8685eb36"

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }

      env {
        name  = "GCP_IDENTITY_PLATFORM_ENABLED"
        value = "false"
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.jwt_secret.secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

resource "google_service_account" "run" {
  account_id   = "hair-simo-run"
  display_name = "Hair Simo Cloud Run"
}

resource "google_project_iam_member" "run_vertex" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.run.email}"
}

resource "google_project_iam_member" "run_speech" {
  project = var.project_id
  role    = "roles/speech.client"
  member  = "serviceAccount:${google_service_account.run.email}"
}

resource "google_project_iam_member" "run_pubsub" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.run.email}"
}

resource "google_project_iam_member" "run_tasks" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.run.email}"
}

resource "google_project_iam_member" "run_secrets" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.run.email}"
}

resource "google_project_iam_member" "run_artifact_registry" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.run.email}"
}

resource "google_compute_global_address" "web_ip" {
  count = var.enable_load_balancer ? 1 : 0
  name  = "hair-simo-web-ip"
}

resource "google_compute_managed_ssl_certificate" "web" {
  count = var.enable_load_balancer ? 1 : 0
  name  = "hair-simo-web-cert"

  managed {
    domains = [var.web_domain]
  }
}

resource "google_compute_backend_service" "web" {
  count       = var.enable_load_balancer ? 1 : 0
  name        = "hair-simo-web-backend"
  protocol    = "HTTP"
  timeout_sec = 30

  backend {
    group = google_compute_region_network_endpoint_group.web[0].id
  }
}

resource "google_compute_region_network_endpoint_group" "web" {
  count                 = var.enable_load_balancer ? 1 : 0
  name                  = "hair-simo-web-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.web.name
  }
}

resource "google_compute_url_map" "web" {
  count           = var.enable_load_balancer ? 1 : 0
  name            = "hair-simo-web-urlmap"
  default_service = google_compute_backend_service.web[0].id
}

resource "google_compute_target_https_proxy" "web" {
  count            = var.enable_load_balancer ? 1 : 0
  name             = "hair-simo-web-https-proxy"
  url_map          = google_compute_url_map.web[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.web[0].id]
}

resource "google_compute_global_forwarding_rule" "web" {
  count      = var.enable_load_balancer ? 1 : 0
  name       = "hair-simo-web-forwarding"
  target     = google_compute_target_https_proxy.web[0].id
  port_range = "443"
  ip_address = google_compute_global_address.web_ip[0].address
}

resource "google_compute_security_policy" "armor" {
  name = "hair-simo-armor"

  rule {
    action   = "rate_based_ban"
    priority = 1000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      rate_limit_threshold {
        count        = 100
        interval_sec = 60
      }
      ban_duration_sec = 300
    }
  }

  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}

resource "google_cloud_scheduler_job" "reminders" {
  name             = "hair-simo-appointment-reminders"
  schedule         = "0 * * * *"
  time_zone        = "Europe/Zurich"
  attempt_deadline = "320s"

  http_target {
    http_method = "POST"
    uri         = "https://hair-simo-web-683522826150.europe-west6.run.app/api/cron/reminders"
    headers = {
      "Content-Type"  = "application/json"
      "Authorization" = "Bearer ${var.cron_secret}"
    }
  }
}
