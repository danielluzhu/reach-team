#!/usr/bin/env bash
# Ensures the checklist app is running in a tmux session named "checklist".
# Idempotent: does nothing if the session already exists. Safe to run from cron.
# Same shape as bin/crm-tmux.sh, which keeps the CRM on :3000 alive.
set -u

export PATH="/home/ubuntu/.bun/bin:/usr/local/bin:/usr/bin:/bin"
SESSION=checklist
APP_DIR=/workspace/checklist

tmux has-session -t "$SESSION" 2>/dev/null && exit 0

tmux new-session -d -s "$SESSION" -c "$APP_DIR" \
  'while true; do
     echo "[$(date -Is)] starting checklist app";
     bun run server.ts;
     echo "[$(date -Is)] exited (code $?), restarting in 2s";
     sleep 2;
   done'
