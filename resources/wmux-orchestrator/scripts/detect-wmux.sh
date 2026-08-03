#!/usr/bin/env bash
# Detect wmux via TCP transport (devcontainer) or native pipe (Windows/WSL)
# Exit 0 + print "available" if wmux responds to ping.
# Exit 1 + print "unavailable" if not.

# 1. TCP transport detection (for devcontainers)
#    When WMUX_REMOTE is set, test TCP connectivity to the bridge
if [ -n "${WMUX_REMOTE}" ] && [ -n "${WMUX_REMOTE_TOKEN}" ]; then
  # Extract host and port from WMUX_REMOTE (format: host:port)
  IFS=':' read -r host port <<< "$WMUX_REMOTE"
  port=${port:-9787}  # Default to 9787 if not specified

  # Test TCP connectivity using /dev/tcp (built into bash)
  if timeout 2 bash -c "echo > /dev/tcp/$host/$port" 2>/dev/null; then
    echo "available"
    exit 0
  fi
fi

# 2. Native detection (existing logic for Windows/WSL)
# Make bare `wmux` resolvable when it isn't on PATH (falls back to $WMUX_CLI),
# so detection succeeds via the injected CLI even on an un-patched wmux.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wmux-resolve.sh"

if command -v wmux &>/dev/null; then
  result=$(wmux ping 2>/dev/null)
  if [ "$result" = "pong" ]; then
    echo "available"
    exit 0
  fi
fi

# 3. Fallback: try connecting to the pipe directly
if [ -e "//./pipe/wmux" ] 2>/dev/null; then
  echo "available"
  exit 0
fi

echo "unavailable"
exit 1
