#!/usr/bin/env bash
# Installs what's needed to turn WRF's Fortran into WebAssembly:
#   1. emsdk (emcc = C compiler + final linker)
#   2. a Fortran compiler that can target wasm32 (patched LLVM flang) + its wasm32 Fortran runtime
#
# conda-forge's flang is a host x86-64 compiler with no wasm32 runtime (and since LLVM 20 the
# runtime is a separate flang-rt project), so we use r-wasm/flang-wasm, the toolchain webR uses.
#
# FLANG_SOURCE=prebuilt (default): pull ghcr.io/r-wasm/flang-wasm:main (~1-2 min).
#                                  "micromamba" and "docker" are accepted as aliases.
# FLANG_SOURCE=build:              build flang-wasm from source with docker (hours).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="${TOOLS:-$PWD/tools}"
mkdir -p "$TOOLS/wrappers"
cd "$TOOLS"

# The prebuilt runtime is built against this Emscripten version; keep them in step.
EMSDK_VERSION="${EMSDK_VERSION:-5.0.7}"
[ -d emsdk ] || git clone --depth 1 https://github.com/emscripten-core/emsdk.git
./emsdk/emsdk install "$EMSDK_VERSION"
./emsdk/emsdk activate "$EMSDK_VERSION"

FLANG_IMAGE="${FLANG_IMAGE:-ghcr.io/r-wasm/flang-wasm:main}"

case "${FLANG_SOURCE:-prebuilt}" in
  prebuilt|docker|micromamba)
    docker pull "$FLANG_IMAGE"
    image="$FLANG_IMAGE"
    ;;
  build)
    [ -d flang-wasm ] || git clone --depth 1 https://github.com/r-wasm/flang-wasm.git
    docker build -t flang-wasm:local flang-wasm
    image="flang-wasm:local"
    ;;
  *) echo "unknown FLANG_SOURCE (use: prebuilt | build)" >&2; exit 2 ;;
esac

id="$(docker create "$image")"
rm -rf flang-opt && mkdir -p flang-opt
docker cp "$id:/opt/flang/." flang-opt/
docker rm "$id" >/dev/null

FLANG_PREFIX="$TOOLS/flang-opt"
FLANG_BIN=""
for c in "$FLANG_PREFIX/host/bin/flang" "$FLANG_PREFIX/host/bin/flang-new"; do
  [ -x "$c" ] && { FLANG_BIN="$c"; break; }
done
RUNTIME_LIB="$FLANG_PREFIX/wasm/lib/libFortranRuntime.a"

[ -n "$FLANG_BIN" ]   || { echo "flang binary not found under $FLANG_PREFIX" >&2; find "$FLANG_PREFIX" -maxdepth 3 -name 'flang*' >&2; exit 1; }
[ -f "$RUNTIME_LIB" ] || { echo "wasm Fortran runtime not found under $FLANG_PREFIX" >&2; find "$FLANG_PREFIX" -name '*.a' >&2; exit 1; }

install -m 0755 "$SCRIPT_DIR/flang-wasm" "$TOOLS/wrappers/flang-wasm"

cat > env.sh <<EOF
source "$TOOLS/emsdk/emsdk_env.sh" >/dev/null 2>&1
export FLANG_BIN="$FLANG_BIN"
export FLANG_RUNTIME_DIR="$(dirname "$RUNTIME_LIB")"
export PATH="$TOOLS/wrappers:\$PATH"
EOF

echo "== toolchain =="
source env.sh
"$FLANG_BIN" --version | head -2
emcc --version | head -1
echo "runtime: $RUNTIME_LIB"
ls "$FLANG_RUNTIME_DIR"/libFortran*.a

# Smoke test through the same wrapper WRF will use
cat > /tmp/hello.f90 <<'F90'
program hello
  print *, "Hello, Fortran!"
end program hello
F90
( cd /tmp && flang-wasm -c hello.f90 -o hello.o && flang-wasm hello.o -o hello.js && node hello.js )
