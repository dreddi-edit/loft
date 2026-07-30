# Terminal-Agent Anleitung — Hair Simo (lokal + gcloud)

Diese Anleitung ist für **Cursor CLI / Terminal-Agent auf deinem Laptop** — nicht für den Cloud Agent.

Ziel: Repo von GitHub holen, lokal starten, dann Schritt für Schritt GCP anbinden.

---

## 0) Voraussetzungen auf dem Laptop

Installiere (falls noch nicht vorhanden):

| Tool | Check | Install |
|------|-------|---------|
| Git | `git --version` | https://git-scm.com |
| Node 22+ | `node -v` | https://nodejs.org |
| pnpm 10+ | `pnpm -v` | `corepack enable && corepack prepare pnpm@10.15.1 --activate` |
| Docker | `docker --version` | Docker Desktop |
| gcloud | `gcloud --version` | https://cloud.google.com/sdk/docs/install |
| Terraform 1.5+ | `terraform -version` | https://developer.hashicorp.com/terraform/install |
| Cursor CLI | `agent --version` | `curl https://cursor.com/install -fsS \| bash` |

Cursor CLI einloggen:

```bash
agent login
agent status
```

---

## 1) Alles von GitHub holen (ein Befehl)

### Variante A — Bootstrap-Skript (empfohlen)

```bash
curl -fsSL https://raw.githubusercontent.com/dreddi-edit/loft/cursor/delete-all-repo-content-e10a/scripts/bootstrap-from-github.sh | bash
```

Oder nach dem Klonen im Repo:

```bash
bash scripts/bootstrap-from-github.sh
# optional: anderes Zielverzeichnis
bash scripts/bootstrap-from-github.sh ~/projects/loft
```

Das Skript macht:

1. Clone **oder** `git pull` (Branch `cursor/delete-all-repo-content-e10a`)
2. `pnpm install`
3. `.env` aus `.env.example` (mit generiertem `JWT_SECRET`)
4. `pnpm db:setup` (wenn Docker läuft)

### Variante B — Manuell

```bash
git clone https://github.com/dreddi-edit/loft.git
cd loft
git checkout cursor/delete-all-repo-content-e10a
git pull origin cursor/delete-all-repo-content-e10a
cp .env.example .env
pnpm install
pnpm db:setup
```

---

## 2) Lokal testen (ohne GCP)

```bash
cd loft   # oder dein Zielordner
pnpm dev
```

| Service | URL |
|---------|-----|
| Website | http://localhost:3000/de |
| Buchung | http://localhost:3000/de/booking |
| Kontakt | http://localhost:3000/de/contact |
| Admin | http://localhost:3001/login |

Admin-Login (Seed):

- Team login via seed accounts (`simona@hairsimo.it`, etc.)

Verify:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

---

## 3) Cursor Terminal-Agent starten

```bash
cd loft
agent
```

Wähle **lokalen Agent** (nicht Cloud). Dann den Starter-Prompt unten einfügen.

---

## 4) STARTER_PROMPT für den Terminal-Agent

Kopiere **alles** zwischen `STARTER_PROMPT_BEGIN` und `STARTER_PROMPT_END` in `agent`:

<!-- STARTER_PROMPT_BEGIN -->

Du arbeitest am Hair-Simo-Projekt auf meinem Laptop (lokaler Terminal-Agent, NICHT Cloud Agent).

**Repository**
- GitHub: https://github.com/dreddi-edit/loft
- Branch: `cursor/delete-all-repo-content-e10a`
- PR: #1

**Deine ersten Schritte (in dieser Reihenfolge):**
1. Prüfe ob wir im Repo-Root sind. Wenn nicht: `bash scripts/bootstrap-from-github.sh`
2. Sonst: `git fetch origin && git checkout cursor/delete-all-repo-content-e10a && git pull --ff-only`
3. Lies `docs/TERMINAL-AGENT-GUIDE.md` und `docs/GO-LIVE.md`
4. Zeige mir: `git log -1 --oneline`, `git status`, ob `.env` existiert
5. Wenn Docker läuft: `pnpm db:setup` falls DB fehlt
6. Starte NICHT terraform apply ohne meine Bestätigung von project_id + billing

**gcloud — prüfe meinen lokalen Login:**
```bash
gcloud auth list
gcloud config get-value project
gcloud auth application-default print-access-token >/dev/null && echo "ADC OK" || echo "ADC missing — run: gcloud auth application-default login"
```

**Ziel heute:** Phase für Phase durch `docs/TERMINAL-AGENT-GUIDE.md` — erst lokal verifizieren, dann GCP APIs, dann Terraform plan (nur plan bis ich "apply" sage).

**Regeln:**
- Keine Secrets committen
- Nach Code-Änderungen: lint/typecheck/test/build
- Kurze Updates auf Deutsch
- Bei Unsicherheit: erst `terraform plan`, nicht `apply`

Fang mit Schritt 1 an und sag mir was du siehst.

<!-- STARTER_PROMPT_END -->

---

## 5) gcloud vorbereiten (du im Terminal)

```bash
# Browser-Login
gcloud auth login

# Für Terraform + SDKs (wichtig!)
gcloud auth application-default login

# Projekt setzen
gcloud config set project DEIN-PROJECT-ID

# Check
gcloud auth list
gcloud config get-value project
gcloud billing projects describe DEIN-PROJECT-ID
```

Dem Agent die Ausgabe von `gcloud auth list` und `gcloud config get-value project` schicken.

---

## 6) GCP APIs aktivieren

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
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

---

## 7) Terraform (Infra)

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
```

`terraform.tfvars` bearbeiten:

```hcl
project_id  = "dein-gcp-project-id"
region      = "europe-west8"          # Milan — nicht mehr europe-west6 (Zürich)
environment = "staging"               # erst staging!
web_domain   = "staging.deine-domain.it"
admin_domain = "admin-staging.deine-domain.it"
db_password  = "STARKES_PASSWORT"     # heißt seit dem Cloud-SQL-Wechsel db_password, nicht mehr alloydb_password
```

Dann:

```bash
terraform init
terraform plan    # erst plan — Agent soll Output erklären
# terraform apply  # nur wenn du bereit bist
```

---

## 8) Nach Terraform — Container deployen

```bash
# Region + Project aus terraform.tfvars
export PROJECT_ID=dein-gcp-project-id
export REGION=europe-west8

gcloud auth configure-docker ${REGION}-docker.pkg.dev

docker build -f apps/web/Dockerfile -t ${REGION}-docker.pkg.dev/${PROJECT_ID}/hair-simo/web:latest .
docker build -f apps/admin/Dockerfile -t ${REGION}-docker.pkg.dev/${PROJECT_ID}/hair-simo/admin:latest .

docker push ${REGION}-docker.pkg.dev/${PROJECT_ID}/hair-simo/web:latest
docker push ${REGION}-docker.pkg.dev/${PROJECT_ID}/hair-simo/admin:latest
```

Cloud Run URLs + Secrets → siehe `docs/GO-LIVE.md`.

---

## 9) .env für GCP-Staging (lokal oder Secret Manager)

Mindestens setzen wenn GCP aktiv:

```env
GCP_PROJECT_ID=dein-gcp-project-id
GCP_REGION=europe-west8
DATABASE_URL=postgresql://...   # aus Terraform output / Cloud SQL for PostgreSQL 16
JWT_SECRET=...
GCP_CLOUD_TASKS_HANDLER_URL=https://<web-url>/api/tasks/notification
GCP_CLOUD_TASKS_SECRET=...
CRON_SECRET=...
PAYMENTS_MOCK_ENABLED=true      # erst true, später false
NEXT_PUBLIC_BASE_URL=https://<web-url>
```

---

## 10) Phasen-Checkliste (Reihenfolge!)

### Phase A — Lokal ✅
- [ ] `bootstrap-from-github.sh` erfolgreich
- [ ] `pnpm dev` — Website + Buchung + Admin
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

### Phase B — gcloud Login
- [ ] `gcloud auth login`
- [ ] `gcloud auth application-default login`
- [ ] Projekt + Billing aktiv

### Phase C — APIs
- [ ] Alle APIs enabled (Abschnitt 6)

### Phase D — Terraform staging ✅
- [x] `terraform.tfvars` ausgefüllt
- [x] `terraform plan` reviewed
- [x] `terraform apply` — Cloud SQL (nicht AlloyDB), Direct VPC, Secrets

### Phase E — Deploy Apps ✅ (staging)
- [x] Docker images gebaut + gepusht (`bcc0cb6`, linux/amd64)
- [x] Cloud Run Services laufen (web + admin)
- [x] `DATABASE_URL` + Secrets gesetzt (Cloud SQL private IP, URL-encoded password)
- [x] DB migrate + seed auf Cloud SQL for PostgreSQL 16 (`hair-simo-migrate` Job)
- [x] Smoke: `/de`, `/login`, `/api/services` (5), `/api/staff` (4)

### Phase F — Services anbinden (einzeln)
- [ ] Vertex AI Gemini (Chat)
- [ ] Gmail API (E-Mails)
- [x] Cloud Scheduler → `/api/cron/reminders` und `/api/cron/sweep`
- [ ] Dialogflow CX (Voice) — später
- [ ] Google Pay + PSP — später
- [ ] Identity Platform (Admin Auth) — später

### Phase G — Production
- [ ] Domains + SSL (`enable_load_balancer = true`)
- [ ] `PAYMENTS_MOCK_ENABLED=false`
- [ ] PR #3 nach `master` mergen (PR #1 bereits gemerged)

---

## 11) Nützliche Agent-Befehle (copy-paste)

**Repo aktualisieren:**
```
Pull den neuesten Stand von GitHub (branch cursor/delete-all-repo-content-e10a), install dependencies, und sag mir was sich geändert hat.
```

**gcloud Status:**
```
Prüfe gcloud auth, project, billing und ob alle APIs für Hair Simo enabled sind. Zeig mir was fehlt.
```

**Nur Terraform plan:**
```
Mach terraform plan in infra/terraform und erklär mir die Änderungen. Kein apply ohne meine Freigabe.
```

**Lokaler Health-Check:**
```
Führ lint, typecheck, test und build aus und fixe Fehler minimal-invasiv.
```

---

## 12) Cloud Agent vs Terminal-Agent

| | Cloud Agent | Terminal-Agent (du) |
|---|-------------|---------------------|
| Wo | Cursor VM | Dein Laptop |
| gcloud | nicht dein Login | ✅ dein Login |
| Repo | automatisch | `bootstrap-from-github.sh` |
| Chat übernehmen | ❌ nicht 1:1 | neuer Chat + Starter-Prompt |

**Workflow:** Code auf GitHub → lokal pullen → Terminal-Agent weiterarbeiten.

---

## 13) Troubleshooting

| Problem | Lösung |
|---------|--------|
| `gcloud: command not found` | Google Cloud SDK installieren |
| `pnpm: command not found` | `corepack enable` |
| DB connection failed | Docker starten → `pnpm db:setup` |
| Port 3000 belegt | anderen Prozess killen oder Port ändern |
| Terraform auth error | `gcloud auth application-default login` |
| Agent will Cloud nutzen | Lokalen Agent wählen, nicht `&` Prefix |

---

## 14) Links

- Repo: https://github.com/dreddi-edit/loft
- PR: https://github.com/dreddi-edit/loft/pull/3
- Go-Live: `docs/GO-LIVE.md`
- Terraform: `infra/terraform/README.md`
- Cursor CLI: https://cursor.com/docs/cli/overview
