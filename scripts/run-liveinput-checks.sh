#!/usr/bin/env bash
# Runs the three v0.7 live-input PTY checks with a FRESH fake server each time
# (the server's turn counter decides which replies are slow).
set -u
cd "$(dirname "$0")/.."
fail=0
# Kill any leftover fake server (bracket trick avoids matching this script).
pkill -f "[f]ake-llm-server" 2>/dev/null
sleep 0.3
for mode in typing queue interrupt; do
  FAKE_LLM_SLOW=1 node scripts/fake-llm-server.mjs >/dev/null 2>&1 &
  srv=$!
  # wait until the server actually answers (fresh turn counter each mode)
  for i in $(seq 1 30); do
    curl -s -m 1 http://127.0.0.1:8931/v1/models >/dev/null 2>&1 && break
    sleep 0.2
  done
  python3 scripts/pty-liveinput.py --mode "$mode"
  rc=$?
  kill "$srv" 2>/dev/null
  wait "$srv" 2>/dev/null
  echo "mode=$mode exit=$rc"
  [ $rc -ne 0 ] && fail=1
done
exit $fail
