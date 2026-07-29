#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT_ID="${GCP_PROJECT_ID:-project-53728961-826a-472e-9a6}"
REGION="${GCP_REGION:-europe-west6}"

log() { printf '\n==> %s\n' "$*"; }

log "GCP project: $PROJECT_ID"

gcloud config set project "$PROJECT_ID" >/dev/null

APIS=(
  run.googleapis.com
  alloydb.googleapis.com
  secretmanager.googleapis.com
  pubsub.googleapis.com
  cloudtasks.googleapis.com
  cloudscheduler.googleapis.com
  aiplatform.googleapis.com
  dialogflow.googleapis.com
  speech.googleapis.com
  texttospeech.googleapis.com
  identitytoolkit.googleapis.com
  compute.googleapis.com
  artifactregistry.googleapis.com
  cloudbuild.googleapis.com
  vpcaccess.googleapis.com
  servicenetworking.googleapis.com
)

log "Enabling APIs"
gcloud services enable "${APIS[@]}" --project="$PROJECT_ID"

log "Creating Pub/Sub topic"
gcloud pubsub topics describe hair-simo-notifications --project="$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud pubsub topics create hair-simo-notifications --project="$PROJECT_ID"

log "Creating Pub/Sub subscription"
gcloud pubsub subscriptions describe hair-simo-notifications-worker --project="$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud pubsub subscriptions create hair-simo-notifications-worker \
    --topic=hair-simo-notifications --project="$PROJECT_ID"

log "Creating Cloud Tasks queue"
gcloud tasks queues describe hair-simo-tasks --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud tasks queues create hair-simo-tasks --location="$REGION" --project="$PROJECT_ID"

if [ -f .env ] && ! grep -q '^GCP_PROJECT_ID=.' .env; then
  log "Setting GCP_PROJECT_ID in .env"
  if sed --version >/dev/null 2>&1; then
    sed -i "s|^GCP_PROJECT_ID=.*|GCP_PROJECT_ID=$PROJECT_ID|" .env
    sed -i "s|^GCP_FIREBASE_PROJECT_ID=.*|GCP_FIREBASE_PROJECT_ID=$PROJECT_ID|" .env
  else
    sed -i '' "s|^GCP_PROJECT_ID=.*|GCP_PROJECT_ID=$PROJECT_ID|" .env
    sed -i '' "s|^GCP_FIREBASE_PROJECT_ID=.*|GCP_FIREBASE_PROJECT_ID=$PROJECT_ID|" .env
  fi
fi

log "Done. Set GOOGLE_APPLICATION_CREDENTIALS in .env if using a service account key."
log "Sync env to apps: cp .env apps/web/.env && cp .env apps/admin/.env"
log "Restart dev server: pnpm dev"
