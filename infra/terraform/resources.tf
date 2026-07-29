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

resource "google_pubsub_topic" "notifications_dead_letter" {
  name                       = "hair-simo-${var.environment}-notifications-dead-letter"
  labels                     = local.labels
  message_retention_duration = "604800s"
}

resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  topic  = google_pubsub_topic.notifications_dead_letter.name
  role   = "roles/pubsub.publisher"
  member = local.pubsub_service_agent
}

resource "google_pubsub_subscription" "notifications_worker" {
  name  = "hair-simo-${var.environment}-notifications-worker"
  topic = google_pubsub_topic.notifications.name

  ack_deadline_seconds       = 60
  labels                     = local.labels
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = ""
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.notifications_dead_letter.id
    max_delivery_attempts = 10
  }

  depends_on = [google_pubsub_topic_iam_member.dead_letter_publisher]
}

resource "google_pubsub_subscription_iam_member" "worker_subscriber" {
  subscription = google_pubsub_subscription.notifications_worker.name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_service_agent
}

resource "google_pubsub_subscription" "notifications_dead_letter" {
  name  = "hair-simo-${var.environment}-notifications-dead-letter-worker"
  topic = google_pubsub_topic.notifications_dead_letter.name

  ack_deadline_seconds       = 60
  labels                     = local.labels
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = ""
  }
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

# Terraform creates the container but never the version: the connection string embeds
# var.db_password, and writing it here would park the production password in the state
# file a second time. Add the version by hand after the instance exists, using the
# database_url_hint output as the template. See README.md "Database".
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

resource "google_secret_manager_secret" "admin_jwt_secret" {
  secret_id = "hair-simo-admin-jwt-secret"
  labels    = local.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "appointment_token_secret" {
  secret_id = "hair-simo-appointment-token-secret"
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

# Keeps the value Cloud Run reads as GCP_CLOUD_TASKS_SECRET / CRON_SECRET identical to
# the token Cloud Scheduler sends. Without this the two drift and every cron run 401s.
resource "google_secret_manager_secret_version" "cloud_tasks_secret" {
  secret      = google_secret_manager_secret.cloud_tasks_secret.id
  secret_data = var.cron_secret
}

# Cloud SQL for PostgreSQL, not AlloyDB. AlloyDB has no small tier: its smallest
# primary is 2 vCPU / 16 GB at roughly EUR 240/month, which is absurd for a salon
# booking around 260 appointments a month. Every protection the AlloyDB config had
# is carried over below.
resource "google_sql_database_instance" "primary" {
  count               = var.enable_database ? 1 : 0
  name                = var.db_instance_name
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = true

  settings {
    tier                        = var.db_tier
    edition                     = "ENTERPRISE"
    availability_type           = var.db_availability_type
    disk_type                   = "PD_SSD"
    disk_size                   = var.db_disk_size_gb
    disk_autoresize             = true
    disk_autoresize_limit       = var.db_disk_autoresize_limit_gb
    deletion_protection_enabled = true
    user_labels                 = local.labels

    backup_configuration {
      enabled = true

      # Cloud SQL schedules in UTC: 01:00 UTC is 03:00 in Europe/Rome during CEST
      # and 02:00 during CET. Both fall inside the salon's closed window.
      start_time                     = "01:00"
      location                       = "eu"
      point_in_time_recovery_enabled = true

      # WAL retention for point-in-time recovery. 7 is the maximum on the ENTERPRISE
      # edition; only ENTERPRISE_PLUS allows up to 35, and that edition has no
      # shared-core tier, so raising this means leaving the cheap tiers behind.
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 35
        retention_unit   = "COUNT"
      }
    }

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.vpc.id
      ssl_mode                                      = "ENCRYPTED_ONLY"
      enable_private_path_for_google_cloud_services = false
    }

    # day 1 is Monday and hour is UTC. The salon is open Tue-Sat 08:00-17:00 and
    # closed Sun+Mon, so a Monday 02:00 UTC (03:00/04:00 local) window cannot touch
    # a trading day even if a restart runs long.
    maintenance_window {
      day          = 1
      hour         = 2
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = false
      record_client_address   = false
    }

    database_flags {
      name  = "max_connections"
      value = tostring(var.db_max_connections)
    }

    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }
  }

  depends_on = [google_service_networking_connection.private_vpc_connection]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_sql_database" "app" {
  count    = var.enable_database ? 1 : 0
  name     = var.db_name
  instance = google_sql_database_instance.primary[0].name

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_sql_user" "app" {
  count    = var.enable_database ? 1 : 0
  name     = var.db_user
  instance = google_sql_database_instance.primary[0].name
  password = var.db_password
  type     = "BUILT_IN"

  # A PostgreSQL role that owns tables cannot be dropped, so let Terraform forget the
  # user instead of failing the destroy half way through.
  deletion_policy = "ABANDON"
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

# There is deliberately no google_vpc_access_connector. A Serverless VPC Access
# connector bills two always-on e2-micro instances (roughly EUR 15-25/month) purely to
# forward traffic to the private database. Cloud Run v2 does the same thing natively
# with Direct VPC egress (the network_interfaces block below) at no extra charge.
resource "google_cloud_run_v2_service" "web" {
  name     = "hair-simo-web"
  location = var.region
  labels   = local.labels
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account = google_service_account.run.email

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = google_compute_network.vpc.name
        subnetwork = google_compute_subnetwork.subnet.name
      }
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/hair-simo/web@sha256:ac0ac46bc29077807fd3df0b7893c722b1e4b33eef4059a8d937c2481ac1cbd1"

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "TZ"
        value = "Europe/Rome"
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }

      env {
        name  = "GCP_REGION"
        value = var.region
      }

      # Not var.region: Gemini is only served from a subset of regions and the salon's
      # own region is not one of the guaranteed ones. See README.md "Region".
      env {
        name  = "GCP_VERTEX_LOCATION"
        value = var.vertex_location
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

      # Ingress is load-balancer only, so the run.app URL is no longer reachable by
      # Cloud Tasks or by browsers. Everything goes through the public LB domain.
      env {
        name  = "GCP_CLOUD_TASKS_HANDLER_URL"
        value = "https://${var.web_domain}/api/tasks/notification"
      }

      env {
        name  = "NEXT_PUBLIC_BASE_URL"
        value = "https://${var.web_domain}"
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
        name = "ADMIN_JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.admin_jwt_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "APPOINTMENT_TOKEN_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.appointment_token_secret.secret_id
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
          cpu    = var.web_cpu
          memory = var.web_memory
        }

        # Bill CPU only while a request is in flight, and hand the container extra CPU
        # during startup so the cold start that min_instance_count = 0 buys us stays
        # in the two to three second range.
        cpu_idle          = true
        startup_cpu_boost = true
      }
    }

    scaling {
      min_instance_count = var.web_min_instances
      max_instance_count = var.web_max_instances
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
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account = google_service_account.run.email

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = google_compute_network.vpc.name
        subnetwork = google_compute_subnetwork.subnet.name
      }
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/hair-simo/admin@sha256:5242ab44a6e667a60101461e7c7f1d599719f1033c6ed28f021e303d8685eb36"

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "TZ"
        value = "Europe/Rome"
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }

      # GCP_PROJECT_ID is set above, so getGcpConfig() in packages/gcp resolves here too,
      # and its region default is still the old europe-west6. Set it explicitly rather
      # than letting the admin app address a region that holds none of our resources.
      env {
        name  = "GCP_REGION"
        value = var.region
      }

      env {
        name  = "GCP_IDENTITY_PLATFORM_ENABLED"
        value = "false"
      }

      env {
        name  = "NEXT_PUBLIC_BASE_URL"
        value = "https://${var.admin_domain}"
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
        name = "ADMIN_JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.admin_jwt_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "APPOINTMENT_TOKEN_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.appointment_token_secret.secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = var.admin_cpu
          memory = var.admin_memory
        }

        cpu_idle          = true
        startup_cpu_boost = true
      }
    }

    scaling {
      min_instance_count = var.admin_min_instances
      max_instance_count = var.admin_max_instances
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

# Serverless NEGs do not authenticate to Cloud Run, so the load balancer can only
# reach these services when they are invokable by allUsers. The actual perimeter is
# ingress = INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER plus the Cloud Armor policies.
resource "google_cloud_run_v2_service_iam_member" "web_public" {
  project  = var.project_id
  location = google_cloud_run_v2_service.web.location
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "admin_public" {
  project  = var.project_id
  location = google_cloud_run_v2_service.admin.location
  name     = google_cloud_run_v2_service.admin.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "web_scheduler" {
  project  = var.project_id
  location = google_cloud_run_v2_service.web.location
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_service_account" "run" {
  account_id   = "hair-simo-run"
  display_name = "Hair Simo Cloud Run"
}

resource "google_service_account" "scheduler" {
  account_id   = "hair-simo-scheduler"
  display_name = "Hair Simo Cloud Scheduler"
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

  # Managed certificates are immutable, so the name carries a digest of the domain
  # set and the certificate is replaced before the old one is dropped.
  name = "hair-simo-web-cert-${substr(sha256(join(",", local.lb_domains)), 0, 8)}"

  managed {
    domains = local.lb_domains
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Three backend services share one serverless NEG because Cloud CDN caching policy is
# a property of the backend service, not of a path. Routing in google_compute_url_map.web
# sends the two static prefixes to the aggressive backends and everything else here.
resource "google_compute_backend_service" "web" {
  count            = var.enable_load_balancer ? 1 : 0
  name             = "hair-simo-web-backend"
  protocol         = "HTTP"
  timeout_sec      = 30
  security_policy  = google_compute_security_policy.armor.id
  enable_cdn       = var.enable_cdn
  compression_mode = "AUTOMATIC"

  backend {
    group = google_compute_region_network_endpoint_group.web[0].id
  }

  # HTML is localized (de/it/fr/en) and half of it is authenticated, so the origin
  # decides: USE_ORIGIN_HEADERS caches only what Next.js explicitly marks cacheable and
  # never caches a response carrying Set-Cookie.
  dynamic "cdn_policy" {
    for_each = var.enable_cdn ? [1] : []
    content {
      cache_mode        = "USE_ORIGIN_HEADERS"
      negative_caching  = true
      serve_while_stale = 86400

      cache_key_policy {
        include_host         = true
        include_protocol     = true
        include_query_string = true
      }
    }
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

# /_next/static/* only ever holds content-hashed build output, so a new deploy produces
# new URLs and the old ones can be cached for a year without an invalidation step.
resource "google_compute_backend_service" "web_static" {
  count            = var.enable_load_balancer ? 1 : 0
  name             = "hair-simo-web-static-backend"
  protocol         = "HTTP"
  timeout_sec      = 30
  security_policy  = google_compute_security_policy.armor.id
  enable_cdn       = var.enable_cdn
  compression_mode = "AUTOMATIC"

  backend {
    group = google_compute_region_network_endpoint_group.web[0].id
  }

  dynamic "cdn_policy" {
    for_each = var.enable_cdn ? [1] : []
    content {
      cache_mode        = "CACHE_ALL_STATIC"
      client_ttl        = local.cdn_immutable_ttl
      default_ttl       = local.cdn_immutable_ttl
      max_ttl           = local.cdn_immutable_ttl
      negative_caching  = true
      serve_while_stale = 86400

      cache_key_policy {
        include_host         = true
        include_protocol     = true
        include_query_string = false
      }
    }
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

# /images, /videos, /products and /brand are hand-managed files under apps/web/public
# with stable names: 4.7 MB in total, 2.5 MB of it hero-video.mp4. Serving those from
# Cloud Run means paying container CPU and Cloud Run egress on every single view. They
# are cached for a day at the client and a week at the edge; a replaced file needs a
# cache invalidation (see README.md "CDN").
resource "google_compute_backend_service" "web_media" {
  count            = var.enable_load_balancer ? 1 : 0
  name             = "hair-simo-web-media-backend"
  protocol         = "HTTP"
  timeout_sec      = 30
  security_policy  = google_compute_security_policy.armor.id
  enable_cdn       = var.enable_cdn
  compression_mode = "AUTOMATIC"

  backend {
    group = google_compute_region_network_endpoint_group.web[0].id
  }

  dynamic "cdn_policy" {
    for_each = var.enable_cdn ? [1] : []
    content {
      cache_mode        = "CACHE_ALL_STATIC"
      client_ttl        = 86400
      default_ttl       = 86400
      max_ttl           = 604800
      negative_caching  = true
      serve_while_stale = 86400

      cache_key_policy {
        include_host         = true
        include_protocol     = true
        include_query_string = false
      }
    }
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

# No CDN here on purpose: every backoffice response is authenticated and per-user.
resource "google_compute_backend_service" "admin" {
  count           = var.enable_load_balancer ? 1 : 0
  name            = "hair-simo-admin-backend"
  protocol        = "HTTP"
  timeout_sec     = 30
  security_policy = google_compute_security_policy.admin_armor.id
  enable_cdn      = false

  backend {
    group = google_compute_region_network_endpoint_group.admin[0].id
  }

  log_config {
    enable      = true
    sample_rate = 1.0
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

resource "google_compute_region_network_endpoint_group" "admin" {
  count                 = var.enable_load_balancer ? 1 : 0
  name                  = "hair-simo-admin-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.admin.name
  }
}

resource "google_compute_url_map" "web" {
  count           = var.enable_load_balancer ? 1 : 0
  name            = "hair-simo-web-urlmap"
  default_service = google_compute_backend_service.web[0].id

  host_rule {
    hosts        = [var.web_domain]
    path_matcher = "web"
  }

  host_rule {
    hosts        = [var.admin_domain]
    path_matcher = "admin"
  }

  path_matcher {
    name            = "web"
    default_service = google_compute_backend_service.web[0].id

    path_rule {
      paths   = local.cdn_immutable_paths
      service = google_compute_backend_service.web_static[0].id
    }

    path_rule {
      paths   = local.cdn_media_paths
      service = google_compute_backend_service.web_media[0].id
    }
  }

  path_matcher {
    name            = "admin"
    default_service = google_compute_backend_service.admin[0].id
  }
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
  name        = "hair-simo-armor"
  description = "Public site: per-IP rate limiting plus OWASP CRS preconfigured rules"
  type        = "CLOUD_ARMOR"

  # Adaptive Protection (layer_7_ddos_defense_config) is deliberately NOT enabled:
  # it requires Cloud Armor Enterprise, which is billed at roughly USD 3,000/month.
  # The rate_based_ban rule below plus the preconfigured OWASP rules are Standard tier.

  rule {
    action      = "rate_based_ban"
    priority    = 1000
    description = "Per-IP rate limit"
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

  dynamic "rule" {
    for_each = local.owasp_rules
    content {
      action      = "deny(403)"
      priority    = rule.value
      description = "OWASP CRS ${rule.key}"
      match {
        expr {
          expression = "evaluatePreconfiguredExpr('${rule.key}')"
        }
      }
    }
  }

  rule {
    action      = "allow"
    priority    = 2147483647
    description = "Default allow"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}

resource "google_compute_security_policy" "admin_armor" {
  name        = "hair-simo-admin-armor"
  description = "Backoffice: OWASP CRS plus a source network allowlist, default deny"
  type        = "CLOUD_ARMOR"

  # Adaptive Protection (layer_7_ddos_defense_config) is deliberately NOT enabled:
  # it requires Cloud Armor Enterprise, which is billed at roughly USD 3,000/month.
  # The rate_based_ban rule below plus the preconfigured OWASP rules are Standard tier.

  rule {
    action      = "rate_based_ban"
    priority    = 1000
    description = "Per-IP rate limit"
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
        count        = 60
        interval_sec = 60
      }
      ban_duration_sec = 600
    }
  }

  dynamic "rule" {
    for_each = local.owasp_rules
    content {
      action      = "deny(403)"
      priority    = rule.value
      description = "OWASP CRS ${rule.key}"
      match {
        expr {
          expression = "evaluatePreconfiguredExpr('${rule.key}')"
        }
      }
    }
  }

  rule {
    action      = "allow"
    priority    = 1600
    description = "Allowlisted operator networks (var.admin_allowed_cidrs)"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = var.admin_allowed_cidrs
      }
    }
  }

  rule {
    action      = "deny(403)"
    priority    = 2147483647
    description = "Default deny for everything outside the allowlist"
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
  description      = "Hourly appointment reminder dispatch"
  region           = var.region
  schedule         = "0 * * * *"
  time_zone        = "Europe/Rome"
  attempt_deadline = "320s"

  retry_config {
    retry_count          = 3
    min_backoff_duration = "10s"
    max_backoff_duration = "300s"
    max_doublings        = 3
  }

  # Cloud Scheduler owns the Authorization header once an auth token is configured,
  # so the shared secret travels in X-Cron-Secret and the OIDC token proves the
  # caller identity. The handler must accept both.
  http_target {
    http_method = "POST"
    uri         = "https://${var.web_domain}/api/cron/reminders"
    headers = {
      "Content-Type"  = "application/json"
      "X-Cron-Secret" = var.cron_secret
    }

    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = "https://${var.web_domain}/api/cron/reminders"
    }
  }

  depends_on = [google_cloud_run_v2_service_iam_member.web_scheduler]
}

resource "google_monitoring_notification_channel" "email" {
  count        = var.enable_monitoring ? 1 : 0
  display_name = "Hair Simo Ops"
  type         = "email"
  user_labels  = local.labels

  labels = {
    email_address = var.alert_email
  }
}

resource "google_monitoring_uptime_check_config" "web" {
  count        = var.enable_monitoring ? 1 : 0
  display_name = "hair-simo-web"
  timeout      = "10s"
  period       = "300s"
  checker_type = "STATIC_IP_CHECKERS"
  user_labels  = local.labels

  http_check {
    request_method = "GET"
    path           = "/de"
    port           = 443
    use_ssl        = true
    validate_ssl   = true

    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.web_domain
    }
  }
}

resource "google_logging_metric" "payment_failures" {
  count       = var.enable_monitoring ? 1 : 0
  name        = "hair_simo_payment_failures"
  description = "Failed payment checkouts, captures and webhook handoffs"

  filter = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${google_cloud_run_v2_service.web.name}"
    (
      textPayload:("PAYMENT_CHECKOUT_FAILED" OR "PAYMENT_CAPTURE_FAILED" OR "PAYMENT_WEBHOOK_FAILED" OR "MOCK_PAYMENT_FAILED")
      OR jsonPayload.error=~"^(PAYMENT|MOCK_PAYMENT)_"
      OR (httpRequest.requestUrl=~"/api/payments/" AND httpRequest.status>=500)
    )
  EOT

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Payment failures"
  }
}

resource "google_logging_metric" "notification_failures" {
  count       = var.enable_monitoring ? 1 : 0
  name        = "hair_simo_notification_failures"
  description = "Notification deliveries that never reached the customer"

  filter = <<-EOT
    resource.type="cloud_run_revision"
    (
      textPayload:("notification:gmail-error" OR "NOTIFICATION_DISPATCH_FAILED")
      OR jsonPayload.message:"notification:gmail-error"
      OR (httpRequest.requestUrl=~"/api/(notifications|tasks)/" AND httpRequest.status>=500)
    )
  EOT

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Notification delivery failures"
  }
}

resource "google_monitoring_alert_policy" "uptime" {
  count        = var.enable_monitoring ? 1 : 0
  display_name = "Hair Simo web unreachable"
  combiner     = "OR"
  user_labels  = local.labels

  conditions {
    display_name = "Uptime check failing"

    condition_threshold {
      filter          = "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id = \"${google_monitoring_uptime_check_config.web[0].uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"

      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    subject   = "Hair Simo booking site is down"
    mime_type = "text/markdown"
    content   = "https://${var.web_domain}/de failed from multiple probe locations. Check the Cloud Run revision, the load balancer backend health and the Cloud Armor policy for false positives."
  }

  alert_strategy {
    auto_close = "86400s"
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]
}

resource "google_monitoring_alert_policy" "cloud_run_errors" {
  count        = var.enable_monitoring ? 1 : 0
  display_name = "Hair Simo Cloud Run 5xx rate"
  combiner     = "OR"
  user_labels  = local.labels

  conditions {
    display_name = "5xx responses per 5 minutes"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.label.response_code_class = \"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.alert_5xx_threshold
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }

  documentation {
    subject   = "Hair Simo is returning server errors"
    mime_type = "text/markdown"
    content   = "More than ${var.alert_5xx_threshold} 5xx responses in a five minute window. Inspect the Cloud Run logs for the affected service."
  }

  alert_strategy {
    auto_close = "86400s"
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]
}

resource "google_monitoring_alert_policy" "cloud_run_latency" {
  count        = var.enable_monitoring ? 1 : 0
  display_name = "Hair Simo Cloud Run p95 latency"
  combiner     = "OR"
  user_labels  = local.labels

  conditions {
    display_name = "p95 request latency"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_latencies\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.alert_latency_p95_ms
      duration        = "600s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }

  documentation {
    subject   = "Hair Simo is slow"
    mime_type = "text/markdown"
    content   = "p95 request latency stayed above ${var.alert_latency_p95_ms} ms for ten minutes. Check Cloud SQL load and cold starts: with web_min_instances = 0 a quiet night is followed by a cold start on the first request, which shows up here as a latency spike rather than an outage."
  }

  alert_strategy {
    auto_close = "86400s"
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]
}

resource "google_monitoring_alert_policy" "database_cpu" {
  count        = var.enable_monitoring && var.enable_database ? 1 : 0
  display_name = "Hair Simo Cloud SQL CPU high"
  combiner     = "OR"
  user_labels  = local.labels

  conditions {
    display_name = "Instance CPU utilization"

    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND resource.label.database_id = \"${var.project_id}:${var.db_instance_name}\" AND metric.type = \"cloudsql.googleapis.com/database/cpu/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.alert_db_cpu_threshold
      duration        = "600s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_MEAN"
        group_by_fields      = ["resource.label.database_id"]
      }
    }
  }

  documentation {
    subject   = "Hair Simo database CPU is saturated"
    mime_type = "text/markdown"
    content   = "Cloud SQL CPU stayed above ${var.alert_db_cpu_threshold * 100}% for ten minutes. Read Query Insights first: on a shared-core tier a single missing index looks exactly like an undersized instance. Raise var.db_tier only if the queries are already sane."
  }

  alert_strategy {
    auto_close = "86400s"
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]
}

resource "google_monitoring_alert_policy" "pubsub_backlog" {
  count        = var.enable_monitoring ? 1 : 0
  display_name = "Hair Simo notification backlog"
  combiner     = "OR"
  user_labels  = local.labels

  conditions {
    display_name = "Oldest unacked message age"

    condition_threshold {
      filter          = "resource.type = \"pubsub_subscription\" AND resource.label.subscription_id = \"${google_pubsub_subscription.notifications_worker.name}\" AND metric.type = \"pubsub.googleapis.com/subscription/oldest_unacked_message_age\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.alert_pubsub_unacked_seconds
      duration        = "300s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  conditions {
    display_name = "Messages routed to the dead letter topic"

    condition_threshold {
      filter          = "resource.type = \"pubsub_subscription\" AND resource.label.subscription_id = \"${google_pubsub_subscription.notifications_worker.name}\" AND metric.type = \"pubsub.googleapis.com/subscription/dead_letter_message_count\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "300s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_DELTA"
      }
    }
  }

  documentation {
    subject   = "Hair Simo notifications are not being delivered"
    mime_type = "text/markdown"
    content   = "Notifications are piling up or landing in ${google_pubsub_topic.notifications_dead_letter.name}. Customers are not receiving booking confirmations or reminders."
  }

  alert_strategy {
    auto_close = "86400s"
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]
}

resource "google_monitoring_alert_policy" "payment_failures" {
  count        = var.enable_monitoring ? 1 : 0
  display_name = "Hair Simo payment failures"
  combiner     = "OR"
  user_labels  = local.labels

  conditions {
    display_name = "Payment failures per 5 minutes"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.payment_failures[0].name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.alert_payment_failure_threshold
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  documentation {
    subject   = "Hair Simo deposits are failing"
    mime_type = "text/markdown"
    content   = "Customers cannot pay their booking deposit. Check the payment gateway credentials in Secret Manager and /api/payments logs."
  }

  alert_strategy {
    auto_close = "86400s"
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]
}

resource "google_monitoring_alert_policy" "notification_failures" {
  count        = var.enable_monitoring ? 1 : 0
  display_name = "Hair Simo notification delivery failures"
  combiner     = "OR"
  user_labels  = local.labels

  conditions {
    display_name = "Delivery failures per 5 minutes"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.notification_failures[0].name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.alert_notification_failure_threshold
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  documentation {
    subject   = "Hair Simo is not reaching customers"
    mime_type = "text/markdown"
    content   = "Email or reminder delivery is failing. Check the Gmail/SMTP credentials and the notifications Cloud Tasks queue."
  }

  alert_strategy {
    auto_close = "86400s"
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]
}
