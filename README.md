# Pre-Plan Follow-Up Portal

A web portal that checks online that every field **pre-plan meeting** happens and that every SR leaves it
with an outlet-wise memo plan for the next day. The AMOs upload the evidence, the TSO approves it, the
check-back team verifies it, and a dashboard reports coverage.

## Roles and flow

| Role | Accounts | What they do |
|---|---|---|
| **AMO** (one per zone) | 1,049 (`amo<zone_code>`) | Phone-first page. Records the meeting (held? time, location, SRs present, vacancies) with meeting photos, then takes **several plan photos for each SR live with the phone camera** (*Take plan photo* / *Take meeting photo* open the camera inside the page; each shot uploads instantly with its own progress bar; there is no gallery upload) or a remark saying why there are none. Then *Submit to TSO*. |
| **TSO** (Territory Sales Officer) | 291 (`tso<territory_code>`) | Sees **only the AMOs of their own territory**. Approves each SR (remarks optional), can *Approve all* or *Return to AMO*. Takes their own photo with the camera (*Take TSO photo*); the **Submit** button appears only after a photo is uploaded and every submitted SR is approved. Submitting locks the territory and sends it to the mother portal. |
| **Checker** (check-back team) | 10 (`checker01`..`checker10`) | Mother portal, **limited to the wing(s) assigned to the checker** (shown as "Your wing(s)" at the top). By default each checker owns one wing: `checker01` Chittagong North, `checker02` Chittagong South, `checker03` Noakhali, `checker04` Cumilla, `checker05` Sylhet, `checker06` Dhaka North, `checker07` Dhaka South, `checker08` Gaibandha, `checker09` Rangpur, `checker10` South Bengal; the admin can change this. The **admin** account sees the **National dashboard** (all wings) via the header link. **Tab 1, Territory details**: filter Wing > Division > Territory and date, see everything the territory uploaded in one table, mark each row **Checked** (with "correct photos? yes/no"). **Tab 2, Dashboard**: pie chart with four slices that add up to all SRs in scope (*Images not uploaded* / *Images uploaded (not yet checked)* / *Checked by checker* / *Incorrect photo* = checked but "Correct photos?" = No), bar chart per division (SR count vs SRs with photos), KPI tiles, an **Excel download of the SRs without photos** and a **Full status Excel** (with a *Photo Status* column using the same four buckets) for the selected date and scope. A checker never sees or changes data, photos or exports of other wings (enforced by the server). |
| **Admin** | 1 (`admin`) | Search users, reset passwords, activate or deactivate accounts, and **assign checkers to wings** (*Edit wings*: any set of the 10 wings, or *All wings*; takes effect immediately). Can also open the checker portal (all wings). |

Hierarchy: Wing (10) > Division (50) > Territory (291) > Zone/AMO (1,049) > Route (11,331) > SR (6,963).
Only the last `RETENTION_DAYS` (default 3) days can be viewed, checked or exported; older photos are deleted
automatically. The full build spec is in [`docs/SPEC.md`](docs/SPEC.md).

## Local development

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
python -m app.seed                 # creates data/app.db (SQLite) and loads the hierarchy + users
uvicorn app.main:app --reload      # http://127.0.0.1:8000
```

Photos are stored in `data/uploads/` locally. Run the tests with `pytest`.

## User credentials

The hierarchy Excel was converted with

```bash
python scripts/prepare_data.py "Hierarchy - Wing Division Territory Route SR.xlsx" /secure/place/Meeting_Checker_Credentials.xlsx
```

which writes `seed/hierarchy.csv`, `seed/territories.csv` and `seed/users.json` (**bcrypt hashes only**,
no plaintext) and a credentials workbook with the plaintext passwords (sheets AMO, TSO, Checker, Admin).
**The credentials workbook is delivered separately and is never committed** (`.gitignore` blocks
`*Credentials*.xlsx`). Users can change their own password after logging in.

## Deploying to Azure

### Option A: one command from Azure Cloud Shell (recommended)

Open [Cloud Shell](https://shell.azure.com) (Bash) in the subscription you want to use and run:

```bash
git clone <this-repo-url> preplan-portal && cd preplan-portal && bash deploy/deploy.sh
```

The script:

1. creates the resource group (`RESOURCE_GROUP`, default `rg-preplan-portal`, in `LOCATION`, default `southeastasia`),
2. deploys [`infra/main.bicep`](infra/main.bicep): App Service plan + Web App (Python 3.12), Storage account with a
   private `meeting-images` container, PostgreSQL 16 Flexible Server with database `preplan`, autoscale rules,
3. generates the session secret and the PostgreSQL password with `openssl` and keeps them, together with the
   app name, in `deploy/.deploy-output.env` (git-ignored, `chmod 600`), so **re-running updates the same app**,
4. zips the app (`git archive HEAD`, without tests, data, docs, scripts or credentials) and runs `az webapp deploy`,
   Azure installs `requirements.txt` during the deployment. Because only the last commit is packaged, the script
   stops if `app/`, `seed/`, `requirements.txt` or `startup.sh` have uncommitted or untracked changes
   (`ALLOW_DIRTY=1` overrides), and `deploy/check_package.py` verifies every template and script is in the zip,
5. waits until `/healthz` answers and prints the portal URL.

On the first start `startup.sh` creates the tables and loads the hierarchy and all 1,351 accounts
(`python -m app.seed`, idempotent), then starts gunicorn with uvicorn workers.

Useful variants:

```bash
SKIP_INFRA=1 bash deploy/deploy.sh                       # redeploy code only (fast)
SKU=B2 MIN_INSTANCES=1 MAX_INSTANCES=1 PG_SKU=Standard_B1ms PG_TIER=Burstable bash deploy/deploy.sh   # cheap trial
PG_LOCATION=eastasia bash deploy/deploy.sh               # if PostgreSQL is not offered in your region
az webapp log tail -g rg-preplan-portal -n <app-name>    # live logs
```

Keep `deploy/.deploy-output.env` (or copy it somewhere safe): without it a re-run would generate a new
app name and new secrets.

### Option B: "Deploy to Azure" button / portal

[`infra/main.json`](infra/main.json) is the compiled ARM template. In the Azure portal choose
*Deploy a custom template* > *Build your own template in the editor* > *Load file* > `infra/main.json`
(or link a public raw URL with `https://portal.azure.com/#create/Microsoft.Template/uri/<url-encoded raw URL of main.json>`).
Fill in `appName`, `postgresAdminPassword` (12+ chars, upper, lower and digits) and `secretKey` (32+ random chars).
Then push the code, for example with `SKIP_INFRA=1 APP_NAME=<appName> RESOURCE_GROUP=<rg> bash deploy/deploy.sh`
or with the GitHub workflow below.

### Continuous deployment from GitHub

[`.github/workflows/azure-deploy.yml`](.github/workflows/azure-deploy.yml) deploys the code on every push to `main`
(and on demand). It does not touch the infrastructure. Set up once:

```bash
az ad sp create-for-rbac --name preplan-deploy --role contributor \
  --scopes /subscriptions/<subscription-id>/resourceGroups/rg-preplan-portal --sdk-auth
```

Save the JSON output as the repository secret `AZURE_CREDENTIALS` and the web app name as the repository
variable `AZURE_WEBAPP_NAME`.

## Configuration

Set as App Service application settings (the Bicep template sets the ones marked *infra*).

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `sqlite:///data/app.db` | *infra.* SQLAlchemy URL. Azure: `postgresql+psycopg://user:pass@host:5432/preplan?sslmode=require` |
| `SECRET_KEY` | dev value | *infra.* Signs the session cookie. Changing it logs everyone out. |
| `STORAGE_BACKEND` | `local` | *infra* `azure`. `local` stores photos in `LOCAL_UPLOAD_DIR`. |
| `LOCAL_UPLOAD_DIR` | `data/uploads` | Photo folder for the local backend. |
| `AZURE_STORAGE_CONNECTION_STRING` | | *infra.* Blob Storage connection string. |
| `AZURE_STORAGE_CONTAINER` | `meeting-images` | *infra.* Private blob container for photos. |
| `APP_TIMEZONE` | `Asia/Dhaka` | *infra.* Defines "today" for reports. |
| `ALLOW_BACKDATE_DAYS` | `1` | How many days back AMOs/TSOs may still edit (0 = today only). |
| `RETENTION_DAYS` | `3` | *infra.* Days that stay viewable; older photos are deleted. |
| `PURGE_INTERVAL_MINUTES` | `60` | How often the photo clean-up runs (0 disables it). |
| `MAX_UPLOAD_MB` | `15` | Maximum size of one uploaded photo. |
| `MAX_IMAGES_PER_SR` | `6` | Photo limit per SR per day. |
| `OLD_PHOTO_DAYS` | `2` | Flags photos whose camera timestamp is older than this. |
| `CAMERA_ONLY` | `true` | Reject photo uploads that did not come from the in-app camera (no gallery uploads). |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | `5` / `5` | *infra.* DB connections per worker process. |
| `WEB_CONCURRENCY` | `3` | *infra.* Gunicorn workers per instance (`startup.sh`). |
| `COOKIE_SECURE` | `false` | *infra* `true`. Send the session cookie over HTTPS only. |
| `SESSION_MAX_AGE` | `1209600` | Session lifetime in seconds (14 days). |
| `SEED_ON_STARTUP` | `true` | `startup.sh` runs `python -m app.seed` before starting; set `false` to skip. |

Connection budget: `MAX_INSTANCES x WEB_CONCURRENCY x (DB_POOL_SIZE + DB_MAX_OVERFLOW)` must stay below the
PostgreSQL `max_connections` (10 x 3 x 10 = 300 against about 859 on `Standard_D2ds_v5`; Burstable `B1ms`
allows only about 50, so use it only with a single instance).

## Live deployment

- URL: **https://preplan-4bab2d.azurewebsites.net** (resource group `rg-preplan-portal`, Southeast Asia).
- App Service plan **P0v3**, autoscale **2 to 10 instances** on CPU / HTTP queue. The subscription currently has zero
  quota for P1v3/S/B SKUs; request a quota increase (Portal > Quotas > App Service) to move to P1v3.
- PostgreSQL Flexible Server General Purpose `Standard_D2ds_v5`; Blob container `meeting-images` with a lifecycle delete rule.
- Load test on the live site: 150 AMOs uploading 450 photos (~0.9 MB each) at the same moment gave 0 errors, ~12 uploads/s on
  2 instances (p50 8 s, p95 12 s while saturated); autoscale adds instances under sustained load.
- Redeploy code only: `SKIP_INFRA=1 bash deploy/deploy.sh` (needs `deploy/.deploy-output.env`, which holds the secrets).

## Cost estimate (per month, approximate)

**Estimate only**, based on public pay-as-you-go Linux prices for Southeast Asia in USD; check the
[Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/) for your region and agreement.

| Resource | Default (production) | Cheap trial (`SKU=B2`, `PG_SKU=Standard_B1ms`) |
|---|---|---|
| App Service plan | P0v3 x 2 instances (autoscale to 10): ~$130 (each extra autoscaled instance ~$0.09/hour) | B2 x 1: ~$30 |
| PostgreSQL Flexible Server | General Purpose D2ds_v5 + 32 GB: ~$140 | Burstable B1ms + 32 GB: ~$17 |
| Blob Storage | ~30 GB photos (3-day window) + transactions: ~$5 | ~$5 |
| Bandwidth, logs | ~$5 | ~$2 |
| **Total** | **~$280** | **~$55** |

Stopping the PostgreSQL server and scaling the plan down outside working hours reduces the cost further.

## Operations

- **Backups**: PostgreSQL keeps automatic backups for 7 days (point-in-time restore from the portal:
  PostgreSQL server > *Backup and restore*). Photos are intentionally short-lived (3 days) and are not backed up.
- **Health**: `GET /healthz` (used by App Service health check). Logs: `az webapp log tail`.
- **Forgotten password**: log in as `admin` > *Admin* page > find the user > *Reset password*; the new password
  is shown once and the user's old sessions are signed out. Users can change their own password after login.
- **Deactivate a user** (e.g. an AMO who left): Admin page > toggle *Active*.
- **Regenerating credentials**: run `scripts/prepare_data.py` again (add `--keep` and point it at the existing
  credentials workbook to reuse its passwords; only new users get new ones), commit the updated `seed/` files and redeploy.
  The seed step only **adds** users that do not exist yet; it never overwrites passwords of existing accounts
  in the database, so for existing users either reset passwords in the admin portal or start from an empty database.
- **Hierarchy changes** (new territory, zone or SR): update the Excel, re-run `scripts/prepare_data.py`
  and redeploy. Note that the seed loads the hierarchy only into an empty database.
- **Manual photo clean-up**: `python -m app.purge` (in the App Service SSH console). The storage lifecycle rule
  deletes blobs older than `RETENTION_DAYS + 1` days as a second safety net.
