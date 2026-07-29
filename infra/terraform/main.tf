terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Remote state lives in GCS. A backend block cannot use variables, so the bucket
  # name is hardcoded and must stay in sync with google_storage_bucket.terraform_state
  # below. Bootstrap order (one time only, see README.md "Remote state"):
  #   1. terraform apply            -> creates the bucket with local state
  #   2. uncomment the block below
  #   3. terraform init -migrate-state
  # backend "gcs" {
  #   bucket = "hair-simo-tfstate-683522826150"
  #   prefix = "hair-simo/production"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_project" "current" {
  project_id = var.project_id
}

locals {
  labels = {
    app         = "hair-simo"
    environment = var.environment
    managed_by  = "terraform"
  }

  lb_domains = distinct(compact([var.web_domain, var.admin_domain]))

  pubsub_service_agent = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-pubsub.iam.gserviceaccount.com"

  # One year. Next.js emits content-hashed filenames under /_next/static, so a URL that
  # exists today never changes content and a deploy simply mints new URLs.
  cdn_immutable_ttl = 31536000

  cdn_immutable_paths = ["/_next/static/*"]

  # Hand-managed files under apps/web/public. Names are stable across deploys, so these
  # get a shorter TTL and need an invalidation when a file is replaced in place.
  cdn_media_paths = [
    "/images/*",
    "/videos/*",
    "/products/*",
    "/brand/*",
    "/favicon.ico",
  ]

  # Google preconfigured OWASP CRS rule sets, evaluated after the rate limit rule.
  owasp_rules = {
    "sqli-v33-stable"             = 1100
    "xss-v33-stable"              = 1200
    "lfi-v33-stable"              = 1300
    "rce-v33-stable"              = 1400
    "scannerdetection-v33-stable" = 1500
  }
}

resource "google_storage_bucket" "terraform_state" {
  name                        = "hair-simo-tfstate-683522826150"
  location                    = "EU"
  storage_class               = "STANDARD"
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 10
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}
