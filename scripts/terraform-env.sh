#!/usr/bin/env bash
# Terraform uses Application Default Credentials by default. On this laptop ADC is a
# user OAuth token (often without project Owner). The gcloud active account is the
# Hair Simo owner service account — export its access token so terraform matches gcloud.
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-project-53728961-826a-472e-9a6}"
SA_ACCOUNT="${GCP_TERRAFORM_ACCOUNT:-edgar-baumann@${PROJECT_ID}.iam.gserviceaccount.com}"

gcloud config set account "${SA_ACCOUNT}" >/dev/null
gcloud config set project "${PROJECT_ID}" >/dev/null
gcloud auth application-default set-quota-project "${PROJECT_ID}" >/dev/null || true

export CLOUDSDK_CORE_PROJECT="${PROJECT_ID}"
export GOOGLE_OAUTH_ACCESS_TOKEN
GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"

echo "terraform will use token for: ${SA_ACCOUNT} (project ${PROJECT_ID})"
echo "run:  source scripts/terraform-env.sh && cd infra/terraform && terraform plan"
