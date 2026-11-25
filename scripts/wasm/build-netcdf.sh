#!/usr/bin/env bash
# netCDF-C and netCDF-Fortran for wasm32, classic (netCDF-3) format only: no HDF5, no DAP, no plugins.
# WRF's wrfinput/wrfbdy/wrfout use classic format, and a classic file is trivial to parse in the browser.
set -euo pipefail
: "${TOOLS:?}" "${PREFIX:?}"
# shellcheck disable=SC1091
source "$TOOLS/env.sh"
source "$(dirname "$0")/../../config/forecast.env"

mkdir -p "$PREFIX" src && cd src

[ -d "netcdf-c-$NETCDF_C_VERSION" ] || curl -L "https://github.com/Unidata/netcdf-c/archive/refs/tags/v$NETCDF_C_VERSION.tar.gz" | tar xz
[ -d "netcdf-fortran-$NETCDF_F_VERSION" ] || curl -L "https://github.com/Unidata/netcdf-fortran/archive/refs/tags/v$NETCDF_F_VERSION.tar.gz" | tar xz

echo "== netcdf-c =="
emcmake cmake -S "netcdf-c-$NETCDF_C_VERSION" -B build-nc \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DBUILD_SHARED_LIBS=OFF \
  -DENABLE_NETCDF_4=OFF -DENABLE_HDF5=OFF -DENABLE_DAP=OFF -DENABLE_BYTERANGE=OFF \
  -DENABLE_NCZARR=OFF -DENABLE_PLUGINS=OFF -DENABLE_FILTER_TESTING=OFF \
  -DENABLE_TESTS=OFF -DBUILD_UTILITIES=OFF -DENABLE_EXAMPLES=OFF -DENABLE_DOXYGEN=OFF
cmake --build build-nc -j"$(nproc)"
cmake --install build-nc

echo "== netcdf-fortran =="
emcmake cmake -S "netcdf-fortran-$NETCDF_F_VERSION" -B build-ncf \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DCMAKE_PREFIX_PATH="$PREFIX" -DnetCDF_DIR="$PREFIX/lib/cmake/netCDF" \
  -DCMAKE_Fortran_COMPILER="$(command -v flang-wasm)" \
  -DCMAKE_Fortran_COMPILER_WORKS=ON \
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
  -DBUILD_SHARED_LIBS=OFF -DENABLE_TESTS=OFF -DBUILD_EXAMPLES=OFF -DENABLE_DOXYGEN=OFF
cmake --build build-ncf -j"$(nproc)"
cmake --install build-ncf

# WRF's configure looks for these exact files.
ls -l "$PREFIX/lib"/libnetcdf.a "$PREFIX/lib"/libnetcdff.a "$PREFIX/include"/netcdf.inc
