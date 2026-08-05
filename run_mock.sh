#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export MOCK_CAN=1
exec ./run.sh
