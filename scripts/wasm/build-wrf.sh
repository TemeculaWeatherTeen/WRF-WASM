#!/usr/bin/env bash
# Cross-compile WRF (em_real) to WebAssembly. Produces main/wrf.js + main/wrf.wasm.
# Expect to iterate on this: it is the hardest step in the whole project.
set -euo pipefail
: "${TOOLS:?}" "${PREFIX:?}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$TOOLS/env.sh"
source "$SCRIPT_DIR/../../config/forecast.env"

if [ ! -d WRF ]; then
  git clone --depth 1 --branch "$WRF_REF" --recurse-submodules --shallow-submodules \
    https://github.com/wrf-model/WRF.git
fi
cd WRF

# configure only checks that these files exist; it does not run them.
export NETCDF="$PREFIX" NETCDF_classic=1 WRF_EM_CORE=1 WRF_NMM_CORE=0

menu="$(echo 1 | ./configure 2>&1 || true)"
opt="$(grep 'GNU (gfortran/gcc)' <<<"$menu" | head -1 | sed -E 's/^ *([0-9]+)\..*/\1/' || true)"
if [ -z "$opt" ]; then
  echo "$menu" >&2
  echo "could not find the gfortran/gcc serial entry in ./configure's menu" >&2
  exit 1
fi
echo "using configure option $opt (gfortran serial)"
printf '%s\n1\n' "$opt" | ./configure

python3 "$SCRIPT_DIR/patch_configure_wrf.py" configure.wrf

# Final-link flags, applied by flang-wasm when it links *.exe
# - memory: grows to 4 GiB (wasm32 limit); WRF uses large stack arrays, hence the big stack
# - ES6 module so the same loader works in a module Web Worker and in Node (CI smoke test)
export WASM_LDFLAGS="-O2 \
 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=536870912 -sMAXIMUM_MEMORY=4294967296 -sSTACK_SIZE=134217728 \
 -sFORCE_FILESYSTEM=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createWRF \
 -sENVIRONMENT=web,worker,node -sEXPORTED_RUNTIME_METHODS=FS,ENV,callMain -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
 -sERROR_ON_UNDEFINED_SYMBOLS=0 -sWARN_ON_UNDEFINED_SYMBOLS=1"
export FLANG_EXTRA_FLAGS="${FLANG_EXTRA_FLAGS:-}"

# Parallel first; WRF's own docs recommend a serial retry when a parallel build errors.
if ! ./compile -j "${JOBS:-4}" em_real > compile.log 2>&1; then
  echo "parallel build failed, retrying serially (resumes where it stopped)"
  ./compile em_real > compile-serial.log 2>&1
fi

ls -l main/wrf.exe main/wrf.js main/wrf.wasm
mkdir -p "${OUT:-../out}"
cp main/wrf.js main/wrf.wasm "${OUT:-../out}/"
# Run-time tables and data wrf.exe reads from its working directory.
mkdir -p "${OUT:-../out}/run"
(cd run && cp -L *.TBL RRTM* RRTMG* ozone* CAM* CLM* co2* bulk* capacity.asc coeff* constants.asc kernels* masses.asc \
   tr*.TBL tr49t* termvels.asc "${OUT:-../out}/run/" 2>/dev/null || true)
ls "${OUT:-../out}/run" | head -80
