#!/usr/bin/env bash
# Launcher for Chrome Controller Native Host
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export NODE_ENV=production
exec node "$DIR/dist/native-host.js" "$@"
