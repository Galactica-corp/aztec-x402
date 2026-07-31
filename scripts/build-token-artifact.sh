#!/usr/bin/env bash
#
# Rebuilds the vendored AIP-20 Token artifact from Wonderland's Noir source
# against a released Aztec version, and regenerates its TypeScript wrapper.
#
# Why this exists
# ---------------
# @defi-wonderland/aztec-standards is published built against Aztec
# 5.0.0-rc.2 (see its package.json "config.aztecVersion"). Aztec changed the
# circuits between that release candidate and the 5.0.0 release, growing the
# verification key from 4576 to 5216 bytes, and the package has not been
# rebuilt. Loading the published artifact on a released SDK therefore fails:
#
#   BBApiException: verification key has wrong size: expected 5216, got 4576
#
# Downgrading the SDK to the RC does not help: the RC prover's output is
# rejected by the live network with "proof_compression: BN254 scalar out of
# range". So the artifact has to be rebuilt against the released toolchain.
#
# The Noir sources compile against released aztec-nr unchanged — only the
# built verification keys differed.
#
# Usage:  ./scripts/build-token-artifact.sh [AZTEC_VERSION] [WONDERLAND_REF]
#
# Requires Docker. Output lands in packages/demo/src/contracts/token/ and is
# committed, so this only needs re-running when bumping Aztec or the contract.
set -euo pipefail

AZTEC_VERSION="${1:-5.0.0}"
WONDERLAND_REF="${2:-a3859e5}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/packages/demo/src/contracts/token"
IMAGE="aztecprotocol/aztec:$AZTEC_VERSION"

# The aztec-nargo wrapper insists on a working directory under $HOME and
# hardcodes the :latest image tag, so we drive Docker ourselves.
BUILD_DIR="$HOME/.aztec-build/token-$AZTEC_VERSION"

echo "==> Aztec $AZTEC_VERSION | Wonderland $WONDERLAND_REF"

# Pin the platform: the amd64 image runs under emulation on Apple Silicon and
# gets OOM-killed mid-compile ("unexpected EOF").
ARCH="$(uname -m)"
PLATFORM="linux/amd64"
[ "$ARCH" = "arm64" ] && PLATFORM="linux/arm64"
echo "==> Pulling $IMAGE ($PLATFORM)"
docker pull --platform "$PLATFORM" "$IMAGE"

echo "==> Fetching Wonderland source"
rm -rf "$BUILD_DIR"
mkdir -p "$(dirname "$BUILD_DIR")"
git clone -q https://github.com/defi-wonderland/aztec-standards.git "$BUILD_DIR"
git -C "$BUILD_DIR" checkout -q "$WONDERLAND_REF"

echo "==> Retargeting aztec-nr to v$AZTEC_VERSION"
find "$BUILD_DIR" -name Nargo.toml -not -path "*/node_modules/*" -print0 |
  xargs -0 sed -i.bak -E "s|tag = \"v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?\"|tag = \"v$AZTEC_VERSION\"|g"
find "$BUILD_DIR" -name "Nargo.toml.bak" -delete

# `aztec compile` shells out to a bare `nargo`, which v5 dropped from PATH.
in_container() {
  docker run --rm --platform "$PLATFORM" --user "$(id -u):$(id -g)" \
    -v "$HOME":"$HOME" -e HOME="$HOME" -w "$1" \
    --entrypoint /bin/bash "$IMAGE" -c "export PATH=/usr/src/noir/noir-repo/target/release:\$PATH; $2"
}

echo "==> Compiling token_contract"
in_container "$BUILD_DIR/src/token_contract" \
  "node --no-warnings /usr/src/yarn-project/aztec/dest/bin/index.js compile"

# nargo emits to the workspace-root target/, but `aztec compile` only
# postprocesses artifacts under the target/ of its own working directory — so
# the transpile + VK step is invoked explicitly here.
echo "==> Transpiling public bytecode and deriving verification keys"
in_container "$BUILD_DIR" \
  "/usr/src/barretenberg/ts/build/*-linux/bb aztec_process -i target/token_contract-Token.json"

echo "==> Stamping aztec_version"
python3 - "$BUILD_DIR/target/token_contract-Token.json" "$AZTEC_VERSION" <<'PY'
import json, sys
path, version = sys.argv[1], sys.argv[2]
artifact = json.load(open(path))
assert artifact.get("transpiled") is True, "artifact was not transpiled"
artifact["aztec_version"] = version
json.dump(artifact, open(path, "w"), indent=2)
PY

echo "==> Generating TypeScript wrapper"
in_container "$BUILD_DIR" \
  "node --no-warnings /usr/src/yarn-project/aztec/dest/bin/index.js codegen target --outdir src/artifacts -f"

echo "==> Vendoring into $OUT_DIR"
mkdir -p "$OUT_DIR"
cp "$BUILD_DIR/target/token_contract-Token.json" "$OUT_DIR/"
sed "s#'../../target/token_contract-Token.json'#'./token_contract-Token.json'#" \
  "$BUILD_DIR/src/artifacts/Token.ts" > "$OUT_DIR/Token.ts"

echo "==> Done. Rebuilt against Aztec $AZTEC_VERSION:"
ls -la "$OUT_DIR"
