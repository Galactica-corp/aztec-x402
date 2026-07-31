#!/bin/sh
set -e

DATA_DIR="/app/packages/demo/src/aztec/data"

mkdir -p "$DATA_DIR"

# Setup is resumable — saves progress after each step.
# If minted != true in deploy.json, setup will pick up where it left off.
NODE_URL="${NODE_URL:-https://v5.testnet.rpc.aztec-labs.com}" \
AZTEC_NETWORK="${AZTEC_NETWORK:-aztec:testnet}" \
USE_SPONSORED_FPC="${USE_SPONSORED_FPC:-true}" \
DATA_DIR="$DATA_DIR" \
bun run ./packages/demo/src/aztec/setup.ts

DATA_DIR="$DATA_DIR" exec bun run ./packages/demo/src/aztec/real-server.ts
