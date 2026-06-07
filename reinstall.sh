#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Chrome Controller — Reinstall / Check / Restart
#
# Checks the installed state of all three components:
#   1. Chrome extension  (unpacked, in Chrome)
#   2. Node server       (:8898 HTTP, :8899 WS)
#   3. Pi extension      (listed in ~/.pi/agent/settings.json)
#
# Acts accordingly: installs missing deps, kills & restarts the server,
# reports missing configuration.
###############################################################################

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$REPO_DIR/server"
PI_DEV_DIR="$REPO_DIR/PiDev Extension"
EXT_DIR="$REPO_DIR/Chrome Extension"
SETTINGS="$HOME/.pi/agent/settings.json"

HTTP_PORT="${HTTP_PORT:-8898}"
WS_PORT="${WS_PORT:-8899}"

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[1;33m'
BLU='\033[0;34m'
NC='\033[0m' # No Color

ok()      { echo -e "${GRN}[OK]${NC}   $*"; }
warn()    { echo -e "${YEL}[WARN]${NC} $*"; }
fail()    { echo -e "${RED}[FAIL]${NC} $*"; }
info()    { echo -e "${BLU}[INFO]${NC} $*"; }

###############################################################################
# 1. Chrome Extension files
###############################################################################
check_extension() {
    info "Checking Chrome Extension files ..."
    local missing=()
    for f in manifest.json background.js content.js content.css; do
        if [[ ! -f "$EXT_DIR/$f" ]]; then
            missing+=("$f")
        fi
    done
    if [[ ${#missing[@]} -eq 0 ]]; then
        ok "Chrome Extension files present ($EXT_DIR)"
    else
        fail "Missing files: ${missing[*]}"
        warn "Pull from git or re-clone the repo."
    fi
}

###############################################################################
# 2. Server — kill, install deps, restart, verify
###############################################################################
get_server_pid() {
    # returns the PID of the node process listening on $HTTP_PORT
    lsof -ti ":$HTTP_PORT" 2>/dev/null | head -1
}

kill_server() {
    local pid
    pid=$(get_server_pid) || true
    if [[ -n "$pid" ]]; then
        info "Killing existing server (PID $pid) ..."
        kill "$pid" 2>/dev/null || true
        # Wait for port to be freed
        local attempts=0
        while [[ -n "$(get_server_pid 2>/dev/null)" ]] && (( attempts < 10 )); do
            sleep 0.5
            (( attempts++ ))
        done
        ok "Server stopped."
    else
        info "No server currently running."
    fi
}

install_server_deps() {
    info "Installing server dependencies ..."
    pushd "$SERVER_DIR" >/dev/null 2>&1
    if [[ ! -f "package.json" ]]; then
        fail "server/package.json not found"
        return 1
    fi
    npm install --prefer-offline 2>&1 | tail -3
    popd >/dev/null 2>&1
    ok "Server dependencies installed."
}

start_server() {
    info "Starting server (HTTP:$HTTP_PORT WS:$WS_PORT) ..."
    pushd "$SERVER_DIR" >/dev/null 2>&1
    nohup npm start >/dev/null 2>&1 &
    local server_pid=$!
    popd >/dev/null 2>&1

    # Wait for the server to come up (up to 5 s)
    local attempts=0
    while ! curl -sf "http://127.0.0.1:$HTTP_PORT/health" >/dev/null 2>&1 && (( attempts < 20 )); do
        sleep 0.25
        (( attempts++ ))
    done

    if curl -sf "http://127.0.0.1:$HTTP_PORT/health" >/dev/null 2>&1; then
        ok "Server started — health check passed (PID $server_pid)."
    else
        fail "Server failed to start within 5 s."
        return 1
    fi
}

check_server() {
    info "Checking server ..."
    local pid
    pid=$(get_server_pid) || true

    if [[ -n "$pid" ]]; then
        # Server is running — check health
        if curl -sf "http://127.0.0.1:$HTTP_PORT/health" >/dev/null 2>&1; then
            local ext_connected
            ext_connected=$(curl -sf "http://127.0.0.1:$HTTP_PORT/health" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('extensionConnected', '?'))" 2>/dev/null || echo "?")
            ok "Server running (PID $pid) — extension connected: $ext_connected"
            return 0
        else
            fail "Server process exists (PID $pid) but health check failed."
            return 1
        fi
    else
        info "Server is NOT running."
        return 1
    fi
}

restart_server() {
    info "Restarting server ..."
    kill_server
    install_server_deps
    start_server
}

###############################################################################
# 3. Pi extension package
###############################################################################
check_pi_package() {
    info "Checking Pi extension configuration ..."

    if [[ ! -f "$SETTINGS" ]]; then
        fail "Pi settings not found at $SETTINGS"
        return 1
    fi

    # Check that the package path is listed
    local rel_path="../../dev/chrome-controller/PiDev Extension"
    if grep -q "$rel_path" "$SETTINGS" 2>/dev/null; then
        ok "Pi package configured in $SETTINGS"
    else
        fail "Pi package NOT listed in $SETTINGS"
        warn "Add the entry manually or run:"
        warn "  pi --add-package '$rel_path'"
        return 1
    fi

    # Check node_modules
    if [[ -d "$PI_DEV_DIR/node_modules" ]]; then
        ok "Pi extension dependencies installed."
    else
        fail "Pi extension node_modules missing."
        install_pi_deps
    fi
}

install_pi_deps() {
    info "Installing Pi extension dependencies ..."
    pushd "$PI_DEV_DIR" >/dev/null 2>&1
    if [[ ! -f "package.json" ]]; then
        fail "PiDev Extension/package.json not found"
        return 1
    fi
    npm install --prefer-offline 2>&1 | tail -3
    popd >/dev/null 2>&1
    ok "Pi extension dependencies installed."
}

###############################################################################
# 4. Full health check (server + extension connectivity)
###############################################################################
health_check() {
    info "Running full health check ..."

    # Extension has a 5-second reconnect loop built into background.js.
    # Wait up to 15 seconds for it to reconnect after a server restart.
    local attempts=0
    local max_attempts=30  # 30 * 1s = 30 seconds (MV3 service workers can take a while to wake)

    while (( attempts < max_attempts )); do
        local result
        result=$(curl -sf "http://127.0.0.1:$HTTP_PORT/health" 2>/dev/null) || {
            fail "Health check failed — server may not be running."
            return 1
        }

        local ext_connected
        ext_connected=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin)['extensionConnected'])" 2>/dev/null || echo "unknown")

        if [[ "$ext_connected" == "true" ]]; then
            ok "Full health check passed — server OK, extension connected."
            return 0
        fi

        (( attempts++ ))
        if (( attempts < max_attempts )); then
            info "Waiting for extension reconnect... (attempt $attempts/$max_attempts)"
            sleep 1
        fi
    done

    warn "Extension has not reconnected after $max_attempts seconds."
    warn "Reload the unpacked extension in Chrome → chrome://extensions"
    warn "Point to: $EXT_DIR"
    return 0
}

###############################################################################
# Main
###############################################################################
main() {
    local action="${1:-check}"

    echo "================================================"
    echo "  Chrome Controller — Reinstall / Check"
    echo "================================================"
    echo ""

    case "$action" in
        check)
            check_extension
            check_server
            check_pi_package
            echo ""
            health_check
            ;;
        restart)
            kill_server
            install_server_deps
            start_server
            install_pi_deps
            check_extension
            check_pi_package
            echo ""
            health_check
            ;;
        reinstall)
            info "Full reinstall ..."
            echo ""
            check_extension
            echo ""
            kill_server
            echo ""
            install_server_deps
            start_server
            echo ""
            install_pi_deps
            check_pi_package
            echo ""
            health_check
            ;;
        *)
            echo "Usage: $0 {check|restart|reinstall}"
            echo ""
            echo "  check     — Verify all components; report status."
            echo "  restart   — Kill server, reinstall deps, restart server."
            echo "  reinstall — Full check + kill + deps + restart + verify."
            exit 1
            ;;
    esac

    echo ""
    echo "Done."
}

main "$@"
