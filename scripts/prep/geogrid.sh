#!/usr/bin/env bash
# One-off: build the static geography file (terrain, land use, soil...) for our fixed domain.
# Output: $OUT/geo_em.d01.nc  (about a megabyte; reused by every forecast run)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NATIVE="${NATIVE:-$HOME/native}"
GEOG="${GEOG:-$HOME/geog}"
OUT="${OUT:-$PWD/out}"
mkdir -p "$GEOG/WPS_GEOG" "$OUT"

BASE=https://www2.mmm.ucar.edu/wrf/src/wps_files
for f in topo_gmted2010_30s modis_landuse_20class_30s_with_lakes soiltype_top_30s soiltype_bot_30s \
         albedo_modis greenfrac_fpar_modis lai_modis_10m maxsnowalb_modis soiltemp_1deg; do
  if [ ! -d "$GEOG/WPS_GEOG/$f" ]; then
    echo "downloading $f"
    curl -fL --retry 3 "$BASE/$f.tar.bz2" | tar xj -C "$GEOG/WPS_GEOG"
    # some tarballs wrap everything in a WPS_GEOG/ folder
    if [ -d "$GEOG/WPS_GEOG/WPS_GEOG" ]; then cp -a "$GEOG/WPS_GEOG/WPS_GEOG/." "$GEOG/WPS_GEOG/"; rm -rf "$GEOG/WPS_GEOG/WPS_GEOG"; fi
  fi
done
echo "static data present:"; ls "$GEOG/WPS_GEOG"

cd "$NATIVE/WPS"
python3 "$REPO/scripts/prep/patch_geogrid_tbl.py" geogrid/GEOGRID.TBL
python3 "$REPO/scripts/prep/domain.py" wps --start 2000-01-01_00:00:00 --hours 0 --geog "$GEOG/WPS_GEOG" > namelist.wps
./geogrid.exe > geogrid.out 2>&1 || { tail -60 geogrid.out; cat geogrid.log 2>/dev/null | tail -40; exit 1; }
tail -3 geogrid.out
cp geo_em.d01.nc "$OUT/"
python3 "$REPO/scripts/prep/domain.py" params > "$OUT/domain.json"
ls -l "$OUT"
