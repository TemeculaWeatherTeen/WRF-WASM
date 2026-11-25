#!/usr/bin/env bash
# Native (gfortran) WRF + WPS. Only used for pre-processing: geogrid, ungrib, metgrid, real.
# The forecast itself (wrf.exe) runs in the browser as WebAssembly.
# Same WRF version as the wasm build, so wrfinput/wrfbdy are compatible.
# Needs apt: gfortran gcc g++ make m4 csh perl libnetcdf-dev libnetcdff-dev netcdf-bin libpng-dev zlib1g-dev
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../config/forecast.env"
NATIVE="${NATIVE:-$HOME/native}"
mkdir -p "$NATIVE" && cd "$NATIVE"

if [ -x WRF/main/real.exe ] && [ -x WPS/ungrib.exe ] && [ -x WPS/metgrid.exe ] && [ -x WPS/geogrid.exe ]; then
  echo "native build already present in $NATIVE"; exit 0
fi

# netCDF from apt, presented in the include/ + lib/ layout WRF's configure expects.
NC="$NATIVE/netcdf"; mkdir -p "$NC/include" "$NC/lib"
ln -sf /usr/include/netcdf* "$NC/include/"
ln -sf /usr/include/typesizes.mod "$NC/include/" 2>/dev/null || true
ln -sf /usr/lib/x86_64-linux-gnu/libnetcdf* "$NC/lib/"
export NETCDF="$NC" NETCDF_classic=1 WRF_EM_CORE=1 WRF_NMM_CORE=0

# JasPer 1.900.1 (what WPS's GRIB2 reader is written against)
if [ ! -d jasper-install ]; then
  curl -fL https://www2.mmm.ucar.edu/wrf/OnLineTutorial/compile_tutorial/tar_files/jasper-1.900.1.tar.gz | tar xz
  (cd jasper-1.900.1 && CFLAGS="-O2 -fPIC -Wno-error" ./configure --prefix="$NATIVE/jasper-install" && make -j"$(nproc)" && make install)
fi
export JASPERLIB="$NATIVE/jasper-install/lib" JASPERINC="$NATIVE/jasper-install/include"

pick() { # $1 = grep pattern on the configure menu; prints the option number
  local menu; menu="$(echo 1 | ./configure 2>&1 || true)"
  grep -E "$1" <<<"$menu" | head -1 | sed -E 's/^ *([0-9]+)\..*/\1/'
}

if [ ! -d WRF ]; then
  git clone --depth 1 --branch "$WRF_REF" --recurse-submodules --shallow-submodules https://github.com/wrf-model/WRF.git
fi
cd WRF
opt="$(pick 'GNU \(gfortran/gcc\)')"; [ -n "$opt" ] || { echo "no gfortran option in WRF configure" >&2; exit 1; }
printf '%s\n1\n' "$opt" | ./configure
./compile -j "$(nproc)" em_real > compile.log 2>&1 || ./compile em_real > compile2.log 2>&1
ls -l main/real.exe
cd ..

if [ ! -d WPS ]; then
  git clone --depth 1 --branch "$WPS_REF" https://github.com/wrf-model/WPS.git
fi
cd WPS
export WRF_DIR="$NATIVE/WRF"
opt="$(pick 'gfortran +\(serial\)')"; [ -n "$opt" ] || { echo "no gfortran serial option in WPS configure" >&2; exit 1; }
printf '%s\n' "$opt" | ./configure
./compile > compile.log 2>&1 || { tail -50 compile.log; exit 1; }
ls -l geogrid.exe ungrib.exe metgrid.exe
