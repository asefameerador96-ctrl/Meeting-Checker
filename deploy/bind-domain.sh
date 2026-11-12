#!/usr/bin/env bash
# Bind a custom domain (apex + www) to the web app with free App Service managed TLS certificates.
#
#   DOMAIN=meetingchecker.com bash deploy/bind-domain.sh
#
# Prerequisites: an Azure DNS zone for $DOMAIN in $RESOURCE_GROUP holding
#   A @ -> app inbound IP, TXT asuid -> verification id, CNAME www -> <app>.azurewebsites.net, TXT asuid.www
# and the registrar (GoDaddy) nameservers pointed at the zone's Azure name servers.
# Idempotent: safe to re-run. Exits 2 while DNS delegation has not propagated yet.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$ROOT/deploy/.deploy-output.env" ] && source "$ROOT/deploy/.deploy-output.env"
DOMAIN="${DOMAIN:-meetingchecker.com}"
RG="${RESOURCE_GROUP:-rg-preplan-portal}"
APP="${APP_NAME:?APP_NAME not set}"

say() { printf '\n==> %s\n' "$*"; }
resolve() { curl -s -H "accept: application/dns-json" "https://cloudflare-dns.com/dns-query?name=$1&type=$2" | python3 -c "import json,sys;print(' '.join(a['data'] for a in json.load(sys.stdin).get('Answer',[])))"; }

say "Checking DNS delegation of $DOMAIN"
ns="$(resolve "$DOMAIN" NS)"
echo "    nameservers: $ns"
if ! grep -q "azure-dns" <<<"$ns"; then
  echo "    Not delegated to Azure DNS yet. At GoDaddy set the nameservers to:"
  az network dns zone show -g "$RG" -n "$DOMAIN" --query nameServers -o tsv | sed 's/^/      /'
  exit 2
fi
txt="$(resolve "asuid.$DOMAIN" TXT)"
echo "    asuid TXT: ${txt:-<not visible yet>}"
[ -n "$txt" ] || exit 2

for host in "$DOMAIN" "www.$DOMAIN"; do
  say "Binding $host"
  if ! az webapp config hostname list -g "$RG" --webapp-name "$APP" --query "[].name" -o tsv | grep -qx "$host"; then
    az webapp config hostname add -g "$RG" --webapp-name "$APP" --hostname "$host" -o none
  fi
  thumb="$(az webapp config ssl list -g "$RG" --query "[?name=='$host' || subjectName=='$host'].thumbprint | [0]" -o tsv)"
  if [ -z "$thumb" ]; then
    echo "    creating free managed certificate (can take a few minutes)"
    az webapp config ssl create -g "$RG" -n "$APP" --hostname "$host" -o none 2>/dev/null || true
  fi
  # managed certificate issuance is asynchronous: wait for it (up to ~15 min)
  for i in $(seq 1 90); do
    [ -n "$thumb" ] && break
    sleep 10
    thumb="$(az webapp config ssl list -g "$RG" --query "[?name=='$host' || subjectName=='$host'].thumbprint | [0]" -o tsv)"
  done
  [ -n "$thumb" ] || { echo "    certificate for $host not issued yet; re-run this script later"; exit 3; }
  az webapp config ssl bind -g "$RG" -n "$APP" --certificate-thumbprint "$thumb" --ssl-type SNI -o none
  echo "    https://$host bound (cert $thumb)"
done

say "Redirecting all other hostnames to https://$DOMAIN"
az webapp config appsettings set -g "$RG" -n "$APP" --settings CANONICAL_HOST="$DOMAIN" -o none
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/healthz" || true)"
  [ "$code" = "200" ] && break; sleep 10
done
echo "    https://$DOMAIN/healthz -> $code"
echo "Done: https://$DOMAIN"
