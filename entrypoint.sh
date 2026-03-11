#!/bin/sh
set -e

DATA_DIR="/app/packages/demo/src/aztec/data"
CONFIG="$DATA_DIR/deploy.json"

mkdir -p "$DATA_DIR"

if [ ! -f "$CONFIG" ]; then
  echo "No deploy.json found — running setup..."
  NODE_URL="${NODE_URL:-https://v4-devnet-2.aztec-labs.com}" \
  AZTEC_NETWORK="${AZTEC_NETWORK:-aztec:devnet}" \
  USE_SPONSORED_FPC="${USE_SPONSORED_FPC:-true}" \
  DATA_DIR="$DATA_DIR" \
  bun run ./packages/demo/src/aztec/setup.ts
fi

DATA_DIR="$DATA_DIR" exec bun run ./packages/demo/src/aztec/real-server.ts
