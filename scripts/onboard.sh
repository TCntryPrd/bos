#!/usr/bin/env bash
# IR Custom AIOS v2 — Onboarding Script
# Checks system health, prints access URLs, and guides the user through setup.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Colors & formatting
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

ok()   { printf "  ${GREEN}[OK]${RESET}   %s\n" "$1"; }
warn() { printf "  ${YELLOW}[WARN]${RESET} %s\n" "$1"; }
fail() { printf "  ${RED}[FAIL]${RESET} %s\n" "$1"; }
info() { printf "  ${CYAN}[INFO]${RESET} %s\n" "$1"; }

# ---------------------------------------------------------------------------
# 1. ASCII Banner
# ---------------------------------------------------------------------------
banner() {
  printf "${CYAN}"
  cat << 'BANNER'

 __     __                    _        _    ___ ___  ____          ____
 \ \   / /_ _ ___  __ _ _ __(_)      / \  |_ _/ _ \/ ___|  __   |___ \
  \ \ / / _` / __|/ _` | '__| |     / _ \  | | | | \___ \  \ \ / / __) |
   \ V / (_| \__ \ (_| | |  | |    / ___ \ | | |_| |___) |  \ V / / __/
    \_/ \__,_|___/\__,_|_|  |_|   /_/   \_\___\___/|____/    \_/ |_____|

BANNER
  printf "${RESET}"
  printf "${DIM}  Your AI Operating System — Single-tenant, self-hosted${RESET}\n"
  echo ""
}

# ---------------------------------------------------------------------------
# 2. API Health Check
# ---------------------------------------------------------------------------
check_api() {
  printf "\n${BOLD}--- API Health ---${RESET}\n"
  local response
  if response=$(curl -sf --max-time 5 http://localhost:8001/health 2>/dev/null); then
    ok "API is healthy at http://localhost:8001"
    # Try to pretty-print if jq is available
    if command -v jq &>/dev/null; then
      echo "$response" | jq -r '.' 2>/dev/null | sed 's/^/       /' || true
    fi
  else
    fail "API is not responding at http://localhost:8001"
    warn "Start the stack: cd $PROJECT_DIR && docker compose up -d"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# 3. Docker Container Health
# ---------------------------------------------------------------------------
check_containers() {
  printf "\n${BOLD}--- Docker Containers ---${RESET}\n"

  if ! command -v docker &>/dev/null; then
    fail "Docker not found on PATH"
    return 1
  fi

  local total=0 running=0 unhealthy=0

  while IFS='|' read -r name state health; do
    name=$(echo "$name" | xargs)
    state=$(echo "$state" | xargs)
    health=$(echo "$health" | xargs)
    ((total++)) || true

    if [[ "$state" == "running" ]]; then
      ((running++)) || true
      if [[ "$health" == "unhealthy" ]]; then
        ((unhealthy++)) || true
        warn "$name  running (unhealthy)"
      elif [[ "$health" == "healthy" ]]; then
        ok "$name"
      else
        ok "$name  ${DIM}(no healthcheck)${RESET}"
      fi
    else
      fail "$name  $state"
    fi
  done < <(docker compose -f "$PROJECT_DIR/docker-compose.yml" ps --format '{{.Name}}|{{.State}}|{{.Health}}' 2>/dev/null || true)

  if [[ $total -eq 0 ]]; then
    fail "No boss containers found. Run: cd $PROJECT_DIR && docker compose up -d"
    return 1
  fi

  echo ""
  info "$running/$total containers running${unhealthy:+, $unhealthy unhealthy}"
}

# ---------------------------------------------------------------------------
# 4. Access URLs + QR Code
# ---------------------------------------------------------------------------
LOCAL_URL="http://localhost:8005"
REMOTE_URL="https://last-castle.daggertooth-larch.ts.net/boss/ui/"

print_urls() {
  printf "\n${BOLD}--- Web Dashboard ---${RESET}\n"
  info "Local:  ${BOLD}${LOCAL_URL}${RESET}"
  info "Remote: ${BOLD}${REMOTE_URL}${RESET}"
}

print_qr() {
  echo ""
  if command -v qrencode &>/dev/null; then
    printf "${DIM}  Scan with your phone to open the dashboard:${RESET}\n\n"
    qrencode -t ANSIUTF8 "$REMOTE_URL" | sed 's/^/    /'
  else
    warn "Install qrencode for a scannable QR code: sudo apt install qrencode"
    info "Remote URL: $REMOTE_URL"
  fi
}

# ---------------------------------------------------------------------------
# 5. System Status Summary
# ---------------------------------------------------------------------------
system_status() {
  printf "\n${BOLD}--- System Status ---${RESET}\n"

  # Brain provider from .env
  local env_file="$PROJECT_DIR/.env"
  if [[ -f "$env_file" ]]; then
    local brain
    brain=$(grep -E '^BRAIN_PROVIDER=' "$env_file" 2>/dev/null | cut -d= -f2- | xargs)
    if [[ -n "$brain" ]]; then
      ok "Brain provider: ${BOLD}$brain${RESET}"
    else
      warn "Brain provider not configured in .env"
    fi

    local fallback
    fallback=$(grep -E '^BRAIN_FALLBACK_PROVIDER=' "$env_file" 2>/dev/null | cut -d= -f2- | xargs)
    if [[ -n "$fallback" ]]; then
      info "Fallback provider: $fallback"
    fi

    local tts
    tts=$(grep -E '^TTS_PROVIDER=' "$env_file" 2>/dev/null | cut -d= -f2- | xargs)
    if [[ -n "$tts" ]]; then
      info "TTS provider: $tts"
    fi
  else
    warn "No .env file found at $env_file"
  fi

  # Connected accounts — placeholder until the API exposes this
  info "Connected accounts: ${DIM}none yet${RESET}"
  info "Complete onboarding in the web UI to connect accounts."
}

# ---------------------------------------------------------------------------
# 6. Instructions
# ---------------------------------------------------------------------------
instructions() {
  printf "\n${BOLD}--- Next Steps ---${RESET}\n"
  echo ""
  printf "  1. ${BOLD}Open the web UI${RESET} to complete onboarding\n"
  printf "     ${CYAN}${LOCAL_URL}${RESET}\n"
  echo ""
  printf "  2. Or ${BOLD}scan the QR code${RESET} with your phone to begin mobile setup\n"
  echo ""
  printf "  3. Connect your first account (Google, Slack, etc.)\n"
  echo ""
  printf "  4. Run ${CYAN}boss status${RESET} at any time to check system health\n"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  banner
  check_api || true
  check_containers || true
  print_urls
  print_qr
  system_status
  instructions
}

main "$@"
