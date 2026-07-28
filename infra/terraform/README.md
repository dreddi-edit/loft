# Hair Simo — Google Cloud Terraform

Production infrastructure for the Hair Simo salon platform on GCP.

## Architecture

- **Cloud Run** — `web` and `admin` Next.js apps
- **AlloyDB** — PostgreSQL-compatible primary database
- **Identity Platform** — Admin authentication
- **Vertex AI Gemini 2.5** — Chat AI with function calling
- **Dialogflow CX + Phone Gateway** — Voice telephony
- **Cloud Speech-to-Text (Chirp)** — Speech recognition
- **Cloud Text-to-Speech (Chirp 3 HD)** — Natural voice synthesis
- **Cloud Armor** — WAF and rate limiting at load balancer
- **Secret Manager** — Credentials and API keys
- **Pub/Sub + Cloud Tasks** — Async notifications
- **Cloud Scheduler** — Appointment reminders

## Prerequisites

1. GCP project with billing enabled
2. Terraform >= 1.5
3. `gcloud auth application-default login`
4. Enable APIs:

```bash
gcloud services enable \
  run.googleapis.com \
  alloydb.googleapis.com \
  secretmanager.googleapis.com \
  pubsub.googleapis.com \
  cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com \
  aiplatform.googleapis.com \
  dialogflow.googleapis.com \
  speech.googleapis.com \
  texttospeech.googleapis.com \
  identitytoolkit.googleapis.com \
  compute.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com
```

## Usage

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your project_id

terraform init
terraform plan
terraform apply
```

## Post-deploy

1. Build and push container images (Cloud Build triggers included)
2. Configure Dialogflow CX agent webhook → `https://<web-domain>/api/voice/dialogflow`
3. Enable Phone Gateway in Dialogflow CX
4. Create Identity Platform users matching seed emails
5. Set `GCP_CLOUD_TASKS_HANDLER_URL` to `https://<web-domain>/api/tasks/notification`
6. Configure Google Pay merchant ID and PSP gateway credentials in Secret Manager

## Variables

See `variables.tf` for full list. Key variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `project_id` | GCP project ID | required |
| `region` | Primary region | `europe-west6` |
| `environment` | `staging` or `production` | `production` |
