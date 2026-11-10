#!/usr/bin/env bash
# One-command deployment of the Pre-Plan Follow-Up Portal to Azure (works in Azure Cloud Shell).
#
#   bash deploy/deploy.sh
#
# Settings (environment variables, all optional):
#   RESOURCE_GROUP   resource group to create/use          (default: rg-preplan-portal)
#   LOCATION         Azure region                          (default: southeastasia)
#   APP_NAME         web app name, globally unique         (default: preplan-<random>, remembered)
#   PG_LOCATION      region for PostgreSQL                 (default: $LOCATION)
#   SKU              App Service plan SKU                  (default: P0v3; P1v3 once quota allows)
#   MIN_INSTANCES / MAX_INSTANCES   autoscale range        (default: 2 / 10)
#   PG_SKU / PG_TIER PostgreSQL compute                    (default: Standard_D2ds_v5 / GeneralPurpose)
#   SKIP_INFRA=1     only redeploy the code
#
# Generated values (app name, session secret, PostgreSQL password) are kept in
# deploy/.deploy-output.env (git-ignored, chmod 600), so re-running updates the same app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="$ROOT/deploy/.deploy-output.env"
cd "$ROOT"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    WARNING: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Values passed in the environment win over remembered ones.
ENV_RESOURCE_GROUP="${RESOURCE_GROUP:-}"
ENV_LOCATION="${LOCATION:-}"
ENV_APP_NAME="${APP_NAME:-}"
ENV_PG_LOCATION="${PG_LOCATION:-}"; ENV_SKU="${SKU:-}"; ENV_MIN_INSTANCES="${MIN_INSTANCES:-}"
ENV_MAX_INSTANCES="${MAX_INSTANCES:-}"; ENV_PG_SKU="${PG_SKU:-}"; ENV_PG_TIER="${PG_TIER:-}"
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  ok "Loaded previous deployment settings from deploy/.deploy-output.env"
fi
RESOURCE_GROUP="${ENV_RESOURCE_GROUP:-${RESOURCE_GROUP:-rg-preplan-portal}}"
LOCATION="${ENV_LOCATION:-${LOCATION:-southeastasia}}"
APP_NAME="${ENV_APP_NAME:-${APP_NAME:-preplan-$(openssl rand -hex 3)}}"
PG_LOCATION="${ENV_PG_LOCATION:-${PG_LOCATION:-$LOCATION}}"
SKU="${ENV_SKU:-${SKU:-P0v3}}"
MIN_INSTANCES="${ENV_MIN_INSTANCES:-${MIN_INSTANCES:-2}}"
MAX_INSTANCES="${ENV_MAX_INSTANCES:-${MAX_INSTANCES:-10}}"
PG_SKU="${ENV_PG_SKU:-${PG_SKU:-Standard_D2ds_v5}}"
PG_TIER="${ENV_PG_TIER:-${PG_TIER:-GeneralPurpose}}"
SECRET_KEY="${SECRET_KEY:-$(openssl rand -hex 32)}"
# Upper + lower + digits satisfies the PostgreSQL complexity rule and needs no URL escaping.
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-Pg$(openssl rand -hex 16)}"

save_state() {
  umask 077
  cat > "$STATE_FILE" <<EOF
# Written by deploy/deploy.sh. Contains secrets: do not commit or share.
RESOURCE_GROUP='$RESOURCE_GROUP'
LOCATION='$LOCATION'
APP_NAME='$APP_NAME'
PG_LOCATION='$PG_LOCATION'
SKU='$SKU'
MIN_INSTANCES='$MIN_INSTANCES'
MAX_INSTANCES='$MAX_INSTANCES'
PG_SKU='$PG_SKU'
PG_TIER='$PG_TIER'
SECRET_KEY='$SECRET_KEY'
POSTGRES_PASSWORD='$POSTGRES_PASSWORD'
${WEBAPP_URL:+WEBAPP_URL='$WEBAPP_URL'}
EOF
  chmod 600 "$STATE_FILE"
}

command -v az >/dev/null || die "Azure CLI (az) not found. Use Azure Cloud Shell or install it: https://aka.ms/installazurecli"
command -v openssl >/dev/null || die "openssl not found"
command -v curl >/dev/null || die "curl not found"

say "Checking Azure login"
if ! az account show >/dev/null 2>&1; then
  az login --use-device-code >/dev/null
fi
ok "Subscription: $(az account show --query '[name, id]' -o tsv | paste -sd ' ')"

say "Settings"
ok "Resource group : $RESOURCE_GROUP ($LOCATION)"
ok "Web app        : $APP_NAME  (plan $SKU, $MIN_INSTANCES-$MAX_INSTANCES instances)"
ok "PostgreSQL     : $PG_SKU ($PG_TIER) in $PG_LOCATION"
save_state   # remember generated names/secrets before anything can fail

if [ "${SKIP_INFRA:-0}" != "1" ]; then
  say "Registering resource providers (first run on a subscription only)"
  for ns in Microsoft.Web Microsoft.Storage Microsoft.DBforPostgreSQL Microsoft.Insights; do
    state="$(az provider show --namespace "$ns" --query registrationState -o tsv 2>/dev/null || echo NotRegistered)"
    if [ "$state" != "Registered" ]; then
      ok "registering $ns"
      az provider register --namespace "$ns" --wait >/dev/null
    fi
  done

  say "Creating resource group"
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --tags app=preplan-portal -o none
  ok "done"

  say "Provisioning infrastructure (first run takes ~10-15 minutes, PostgreSQL is the slow part)"
  PARAMS_FILE="$(mktemp)"
  trap 'rm -f "$PARAMS_FILE"' EXIT
  chmod 600 "$PARAMS_FILE"
  cat > "$PARAMS_FILE" <<EOF
{
  "\$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "appName": {"value": "$APP_NAME"},
    "location": {"value": "$LOCATION"},
    "postgresLocation": {"value": "$PG_LOCATION"},
    "sku": {"value": "$SKU"},
    "minInstances": {"value": $MIN_INSTANCES},
    "maxInstances": {"value": $MAX_INSTANCES},
    "postgresSkuName": {"value": "$PG_SKU"},
    "postgresTier": {"value": "$PG_TIER"},
    "postgresAdminPassword": {"value": "$POSTGRES_PASSWORD"},
    "secretKey": {"value": "$SECRET_KEY"}
  }
}
EOF
  WEBAPP_URL="$(az deployment group create \
    --resource-group "$RESOURCE_GROUP" \
    --name "preplan-$(date +%Y%m%d%H%M%S)" \
    --template-file "$ROOT/infra/main.bicep" \
    --parameters "@$PARAMS_FILE" \
    --query properties.outputs.webAppUrl.value -o tsv)"
  rm -f "$PARAMS_FILE"
  [ -n "$WEBAPP_URL" ] || die "Deployment finished without a web app URL"
  save_state
  ok "Infrastructure ready: $WEBAPP_URL"
else
  WEBAPP_URL="$(az webapp show -g "$RESOURCE_GROUP" -n "$APP_NAME" --query defaultHostName -o tsv)"
  WEBAPP_URL="https://$WEBAPP_URL"
fi

say "Packaging the application"
ZIP="$(mktemp -d)/preplan-app.zip"
EXCLUDES=(':(exclude)tests' ':(exclude)data' ':(exclude)deploy' ':(exclude)infra' ':(exclude).github'
          ':(exclude).claude' ':(exclude)docs' ':(exclude)scripts' ':(exclude)requirements-dev.txt')
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # git archive packages HEAD only, so uncommitted or untracked app files would silently be left out
  # (e.g. a new template -> TemplateNotFound in production). Refuse unless explicitly overridden.
  DIRTY="$(git -C "$ROOT" status --porcelain -- app seed requirements.txt startup.sh)"
  if [ -n "$DIRTY" ]; then
    printf '%s\n' "$DIRTY" >&2
    if [ "${ALLOW_DIRTY:-0}" = "1" ]; then
      warn "uncommitted/untracked app files above are NOT deployed (ALLOW_DIRTY=1); deploying HEAD only"
    else
      die "commit the app files listed above first (git archive deploys HEAD only), or set ALLOW_DIRTY=1"
    fi
  fi
  git -C "$ROOT" archive --format=zip -o "$ZIP" HEAD -- . "${EXCLUDES[@]}"
else
  command -v zip >/dev/null || die "zip not found"
  (cd "$ROOT" && zip -qr "$ZIP" app seed requirements.txt startup.sh \
     -x '*/__pycache__/*' '*.pyc' '*.db' '*Credentials*')
fi
python3 "$ROOT/deploy/check_package.py" "$ZIP" || die "package is incomplete"
ok "$(du -h "$ZIP" | cut -f1) package: $ZIP"

say "Deploying code (remote build installs requirements.txt; takes a few minutes)"
az webapp deploy --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" \
  --src-path "$ZIP" --type zip --track-status false --timeout 1800000 -o none
rm -rf "$(dirname "$ZIP")"
ok "package uploaded"

say "Waiting for the app to answer on $WEBAPP_URL/healthz"
for i in $(seq 1 60); do
  if curl -fsS --max-time 20 "$WEBAPP_URL/healthz" >/dev/null 2>&1; then
    ok "healthy after ~$((i * 15))s"
    printf '\n\033[1;32mDone. Portal URL: %s\033[0m\n' "$WEBAPP_URL"
    printf '    Log in with the accounts from Meeting_Checker_Credentials.xlsx.\n'
    printf '    Logs:   az webapp log tail -g %s -n %s\n' "$RESOURCE_GROUP" "$APP_NAME"
    printf '    Redeploy code only:  SKIP_INFRA=1 bash deploy/deploy.sh\n'
    exit 0
  fi
  sleep 15
done
die "App did not become healthy in 15 minutes. Check: az webapp log tail -g $RESOURCE_GROUP -n $APP_NAME"
