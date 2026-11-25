#!/usr/bin/env bash
# Installs the two things needed to turn WRF's Fortran into WebAssembly:
#   1. emsdk (emcc = C compiler + final linker)
#   2. a Fortran compiler that can target wasm32 (LLVM flang)
#
# FLANG_SOURCE=micromamba (default): prebuilt flang from the emscripten-forge conda channel.
#                                     Takes minutes. This is the path described in the Jupyter/emscripten-forge blog post.
# FLANG_SOURCE=docker:               build r-wasm/flang-wasm from source. Compiles LLVM; takes hours.
#
# Result: $TOOLS/env.sh  (source it in later steps).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="${TOOLS:-$PWD/tools}"
mkdir -p "$TOOLS/wrappers"
cd "$TOOLS"

EMSDK_VERSION="${EMSDK_VERSION:-latest}"
if [ ! -d emsdk ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git
fi
./emsdk/emsdk install "$EMSDK_VERSION"
./emsdk/emsdk activate "$EMSDK_VERSION"

case "${FLANG_SOURCE:-micromamba}" in
  micromamba)
    if [ ! -x bin/micromamba ]; then
      curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj bin/micromamba
    fi
    export MAMBA_ROOT_PREFIX="$TOOLS/mamba"
    ./bin/micromamba create -y -n flang \
      -c conda-forge/label/emscripten -c conda-forge --no-channel-priority \
      flang libllvm19
    FLANG_PREFIX="$MAMBA_ROOT_PREFIX/envs/flang"
    FLANG_BIN="$(ls "$FLANG_PREFIX"/bin/flang-new "$FLANG_PREFIX"/bin/flang 2>/dev/null | head -1 || true)"
    # Prefer a runtime archive whose path says wasm/emscripten; fall back to any.
    RUNTIME_LIB="$(find "$FLANG_PREFIX" -name 'libFortranRuntime*.a' | grep -Ei 'wasm|emscripten' | head -1 || true)"
    [ -n "$RUNTIME_LIB" ] || RUNTIME_LIB="$(find "$FLANG_PREFIX" -name 'libFortranRuntime*.a' | head -1 || true)"
    ;;
  docker)
    [ -d flang-wasm ] || git clone --depth 1 https://github.com/r-wasm/flang-wasm.git
    docker build -t flang-wasm:local flang-wasm
    id="$(docker create flang-wasm:local)"
    mkdir -p flang-opt
    docker cp "$id:/opt/flang/." flang-opt/
    docker rm "$id" >/dev/null
    FLANG_PREFIX="$TOOLS/flang-opt"
    FLANG_BIN="$FLANG_PREFIX/host/bin/flang-new"
    RUNTIME_LIB="$FLANG_PREFIX/wasm/lib/libFortranRuntime.a"
    ;;
  *) echo "unknown FLANG_SOURCE" >&2; exit 2 ;;
esac

[ -x "${FLANG_BIN:-}" ]    || { echo "flang binary not found under $FLANG_PREFIX" >&2; find "$FLANG_PREFIX" -maxdepth 3 -name 'flang*' >&2; exit 1; }
[ -f "${RUNTIME_LIB:-}" ]  || { echo "libFortranRuntime.a not found under $FLANG_PREFIX" >&2; exit 1; }

install -m 0755 "$SCRIPT_DIR/flang-wasm" "$TOOLS/wrappers/flang-wasm"

cat > env.sh <<EOF
source "$TOOLS/emsdk/emsdk_env.sh" >/dev/null 2>&1
export FLANG_BIN="$FLANG_BIN"
export FLANG_RUNTIME_DIR="$(dirname "$RUNTIME_LIB")"
export PATH="$TOOLS/wrappers:\$PATH"
EOF

echo "== toolchain =="
# shellcheck disable=SC1091
source env.sh
"$FLANG_BIN" --version | head -2
emcc --version | head -1
echo "runtime: $RUNTIME_LIB"
ls "$FLANG_RUNTIME_DIR"/libFortran*.a
