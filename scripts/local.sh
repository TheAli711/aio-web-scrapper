#!/usr/bin/env bash
# Run the whole platform locally and use it.
#
#   ./scripts/local.sh up                 build + start everything, create a local user + API key
#   ./scripts/local.sh status             containers + readiness
#   ./scripts/local.sh creds              print base URLs, API key, sample calls
#   ./scripts/local.sh scrape <url> [markdown|html|text]    print one page (default markdown)
#   ./scripts/local.sh crawl <url> [max_pages] [max_depth]  crawl, show progress, save JSONL to ./output
#   ./scripts/local.sh new-key [name]     mint another API key for the local user
#   ./scripts/local.sh logs [service]     follow logs (default: app-api)
#   ./scripts/local.sh down               stop everything (data is kept)
#
# Credentials are written to .local/credentials.env (git-ignored, mode 600).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WEB_URL="${WS_WEB_URL:-http://localhost:3000}"
API_URL="${WS_API_URL:-http://localhost:4000}"
CREDS_DIR="$ROOT/.local"
CREDS="$CREDS_DIR/credentials.env"
LOCAL_EMAIL="${WS_LOCAL_EMAIL:-local@webscraper.dev}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  for bin in "$@"; do command -v "$bin" >/dev/null 2>&1 || die "'$bin' is required (macOS: brew install $bin)"; done
}

compose() { docker compose "$@"; }

load_creds() {
  [ -f "$CREDS" ] || die "no local credentials yet; run: ./scripts/local.sh up"
  # shellcheck disable=SC1090
  source "$CREDS"
}

RESPONSE=""
HTTP_STATUS=""
api() { # api METHOD PATH [JSON_BODY]  -> sets RESPONSE and HTTP_STATUS (call directly, not in $(...))
  local method=$1 path=$2 body=${3:-}
  local out
  out=$(curl -sS -X "$method" "$API_URL$path" \
    -H "Authorization: Bearer $WS_API_KEY" \
    ${body:+-H "Content-Type: application/json" --data "$body"} \
    -w $'\n%{http_code}') || die "cannot reach $API_URL (is the stack up? ./scripts/local.sh status)"
  HTTP_STATUS=${out##*$'\n'}
  RESPONSE=${out%$'\n'*}
}

# ---------------------------------------------------------------------------- up

preflight() {
  require docker curl jq openssl git
  docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop and retry."
  local v
  v=$(docker compose version --short 2>/dev/null | sed 's/^v//') || die "docker compose v2 is required"
  local major minor
  major=${v%%.*}; minor=${v#*.}; minor=${minor%%.*}
  if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 24 ]; }; then
    die "docker compose >= 2.24 required (found $v)"
  fi
  local mem_gb
  mem_gb=$(( $(docker info --format '{{.MemTotal}}') / 1024 / 1024 / 1024 ))
  [ "$mem_gb" -ge 6 ] || info "warning: Docker has ${mem_gb} GB RAM; 8 GB recommended (Docker Desktop > Settings > Resources)"
}

ensure_env() {
  if [ -f .env ]; then
    info ".env exists, keeping it"
    return
  fi
  info "creating .env from .env.example with a random egress proxy password"
  local pw
  pw=$(openssl rand -hex 24)
  sed -e "s/^EGRESS_PROXY_PASSWORD=.*/EGRESS_PROXY_PASSWORD=$pw/" .env.example > .env
  chmod 600 .env
}

wait_ready() {
  info "waiting for $API_URL/readyz (database + scraping engine)"
  local start=$SECONDS
  until curl -sf "$API_URL/readyz" >/dev/null 2>&1; do
    [ $((SECONDS - start)) -lt 600 ] || die "not ready after 10 minutes; see: ./scripts/local.sh logs api"
    sleep 3
  done
}

session_login() { # -> prints cookie header value
  local email=$1 password=$2 endpoint=$3
  local headers
  headers=$(curl -sS -o /dev/null -D - -X POST "$API_URL/api/auth/$endpoint" \
    -H "Content-Type: application/json" -H "Origin: $WEB_URL" \
    --data "$(jq -nc --arg e "$email" --arg p "$password" '{email:$e,password:$p}')")
  grep -i '^set-cookie: ws_session=' <<<"$headers" | head -1 | sed -E 's/^[Ss]et-[Cc]ookie: (ws_session=[^;]+).*/\1/' | tr -d '\r'
}

bootstrap_creds() {
  mkdir -p "$CREDS_DIR"
  chmod 700 "$CREDS_DIR"

  if [ -f "$CREDS" ]; then
    # shellcheck disable=SC1090
    source "$CREDS"
    api GET /api/v1/projects
    if [ "$HTTP_STATUS" = 200 ]; then
      info "reusing credentials in .local/credentials.env"
      return
    fi
    info "stored API key no longer works; creating a new one"
  fi

  local email=${WS_EMAIL:-$LOCAL_EMAIL} password=${WS_PASSWORD:-} cookie=""
  if [ -n "$password" ]; then
    cookie=$(session_login "$email" "$password" login)
  fi
  if [ -z "$cookie" ]; then
    password=$(openssl rand -base64 18 | tr -d '/+=')
    cookie=$(session_login "$email" "$password" signup)
    if [ -z "$cookie" ]; then
      # Email taken with an unknown password, or sign-up disabled: create a fresh user via the CLI.
      email="local+$(openssl rand -hex 3)@webscraper.dev"
      compose exec -T app-api node dist/scripts/create-user.js --email "$email" --password "$password" >/dev/null \
        || die "could not create a local user"
      cookie=$(session_login "$email" "$password" login)
    fi
  fi
  [ -n "$cookie" ] || die "could not sign in the local user"

  local key_json
  key_json=$(curl -sS -X POST "$API_URL/api/keys" -H "Cookie: $cookie" -H "Origin: $WEB_URL" \
    -H "Content-Type: application/json" --data "{\"name\":\"local-$(date +%Y%m%d-%H%M%S)\"}")
  local key
  key=$(jq -r '.key // empty' <<<"$key_json")
  [ -n "$key" ] || die "API key creation failed: $key_json"

  WS_API_KEY=$key
  local project
  api GET /api/v1/projects
  project=$(jq -r '.data[-1].id' <<<"$RESPONSE")

  umask 077
  cat > "$CREDS" <<EOF
# Local credentials created by scripts/local.sh. Keep private.
WS_WEB_URL=$WEB_URL
WS_API_URL=$API_URL
WS_EMAIL=$email
WS_PASSWORD=$password
WS_API_KEY=$key
WS_PROJECT_ID=$project
EOF
  info "wrote .local/credentials.env"
}

print_summary() {
  load_creds
  bold ""
  bold "Web scraper is running"
  cat <<EOF

  Dashboard      $WS_WEB_URL          (email: $WS_EMAIL, password in .local/credentials.env)
  API            $WS_API_URL/api/v1
  API reference  $WS_API_URL/api/v1/docs         (interactive)
  OpenAPI spec   $WS_API_URL/api/v1/openapi.json
  Agent guide    $WS_API_URL/api/v1/llms.txt     (give this URL to your agent)
  API key        $WS_API_KEY

  Try it:
    ./scripts/local.sh scrape https://example.com
    ./scripts/local.sh crawl https://quotes.toscrape.com 10

    curl -s -X POST "$WS_API_URL/api/v1/scrape?wait=true" \\
      -H "Authorization: Bearer $WS_API_KEY" -H "Content-Type: application/json" \\
      -d '{"url":"https://example.com"}' | jq -r .result.content.markdown

  For an agent:  export WS_API_KEY=... and point it at $WS_API_URL/api/v1/llms.txt
  Load in shell: set -a; source .local/credentials.env; set +a

EOF
}

cmd_up() {
  bold "Starting web scraper (first run builds Firecrawl from source: ~10-15 min)"
  preflight
  bash scripts/fetch-firecrawl.sh
  ensure_env
  info "building and starting containers"
  compose up -d --build --wait --wait-timeout 1200 \
    || die "containers did not become healthy; see: docker compose ps / ./scripts/local.sh logs <service>"
  wait_ready
  bootstrap_creds
  print_summary
}

# ---------------------------------------------------------------------------- use

cmd_scrape() {
  local url=${1:-} format=${2:-markdown}
  [ -n "$url" ] || die "usage: ./scripts/local.sh scrape <url> [markdown|html|text]"
  case $format in markdown|html|text) ;; *) die "format must be markdown, html or text" ;; esac
  load_creds
  local body res
  body=$(jq -nc --arg u "$url" --arg f "$format" '{url:$u, formats:[$f]}')
  api POST "/api/v1/scrape?wait=true" "$body"
  res=$RESPONSE
  if [ "$HTTP_STATUS" != 200 ] && [ "$HTTP_STATUS" != 202 ]; then
    die "$(jq -r '"\(.error.code): \(.error.message)"' <<<"$res" 2>/dev/null || echo "$res")"
  fi
  if [ "$HTTP_STATUS" = 202 ]; then
    info "still running; poll: curl -H 'Authorization: Bearer \$WS_API_KEY' $API_URL/api/v1/jobs/$(jq -r .id <<<"$res")"
    return
  fi
  local status
  status=$(jq -r .job.status <<<"$res")
  info "$(jq -r '"job \(.job.id): \(.job.status) in \(.job.duration_ms)ms, HTTP \(.result.status_code // "-"), \(.result.title // "")"' <<<"$res")"
  if [ "$status" != completed ]; then
    info "$(jq -r '"\(.job.error.code): \(.job.error.message)"' <<<"$res")"
  fi
  jq -r --arg f "$format" '.result.content[$f] // empty' <<<"$res"
  [ "$status" = completed ]
}

cmd_crawl() {
  local url=${1:-} pages=${2:-20} depth=${3:-3}
  [ -n "$url" ] || die "usage: ./scripts/local.sh crawl <url> [max_pages=20] [max_depth=3]"
  load_creds
  local res id
  api POST /api/v1/crawl "$(jq -nc --arg u "$url" --argjson p "$pages" --argjson d "$depth" '{url:$u, max_pages:$p, max_depth:$d, formats:["markdown"]}')"
  res=$RESPONSE
  [ "$HTTP_STATUS" = 202 ] || die "$(jq -r '"\(.error.code): \(.error.message)"' <<<"$res")"
  id=$(jq -r .id <<<"$res")
  info "crawl $id started"
  local job status
  while :; do
    api GET "/api/v1/jobs/$id"
    job=$RESPONSE
    status=$(jq -r .status <<<"$job")
    info "$(jq -r '"\(.status): discovered \(.progress.pages_discovered), processed \(.progress.pages_processed), ok \(.progress.pages_succeeded), failed \(.progress.pages_failed)"' <<<"$job")"
    case $status in completed|failed|cancelled) break ;; esac
    sleep 3
  done
  mkdir -p output
  local out="output/crawl-$id.jsonl"
  curl -sS "$API_URL/api/v1/jobs/$id/export" -H "Authorization: Bearer $WS_API_KEY" > "$out"
  info "saved $(wc -l < "$out" | tr -d ' ') pages to $out"
  jq -r '"  \(if .success then "ok  " else "FAIL" end) \(.status_code // "-") \(.url)\(if .error then "  [\(.error.code)]" else "" end)"' "$out" >&2
  [ "$status" = completed ]
}

cmd_new_key() {
  load_creds
  local name=${1:-"local-$(date +%Y%m%d-%H%M%S)"} cookie
  cookie=$(session_login "$WS_EMAIL" "$WS_PASSWORD" login)
  [ -n "$cookie" ] || die "login failed for $WS_EMAIL"
  curl -sS -X POST "$API_URL/api/keys" -H "Cookie: $cookie" -H "Origin: $WEB_URL" \
    -H "Content-Type: application/json" --data "$(jq -nc --arg n "$name" '{name:$n}')" | jq '{name, prefix, key}'
  info "the key is shown only once; it is NOT saved to .local/credentials.env"
}

cmd_status() {
  compose ps --format 'table {{.Service}}\t{{.Status}}'
  echo
  curl -s "$API_URL/readyz" 2>/dev/null | jq -c . 2>/dev/null || echo "API not reachable at $API_URL"
}

case ${1:-help} in
  up) cmd_up ;;
  down) compose down ;;
  status) cmd_status ;;
  logs) compose logs -f --tail 100 "${2:-app-api}" ;;
  creds) print_summary ;;
  scrape) shift; cmd_scrape "$@" ;;
  crawl) shift; cmd_crawl "$@" ;;
  new-key) shift; cmd_new_key "$@" ;;
  help|-h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command '$1' (see ./scripts/local.sh help)" ;;
esac
