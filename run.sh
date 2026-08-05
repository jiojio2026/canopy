#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONPATH="${PYTHONPATH:-}:$(pwd)"
exec python3 -m uvicorn app.main:app --host "${CAN_WEB_HOST:-127.0.0.1}" --port "${CAN_WEB_PORT:-8000}"
