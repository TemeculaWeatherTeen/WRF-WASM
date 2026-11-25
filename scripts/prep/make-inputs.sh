#!/usr/bin/env bash
# Latest GFS -> ungrib -> metgrid -> real.exe  =>  wrfinput_d01 + wrfbdy_d01 + namelist template.
# Inputs : $GEO (geo_em.d01.nc from geogrid.sh)
# Outputs: $OUT/data/{wrfinput_d01,wrfbdy_d01,namelist.input.template,domain.json,cycle.json}
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$REPO/config/forecast.env"
NATIVE="${NATIVE:-$HOME/native}"
GEO="${GEO:?path to geo_em.d01.nc}"
OUT="${OUT:-$PWD/public}"
WORK="${WORK:-$PWD/work}"
mkdir -p "$OUT/data" "$WORK/gfs"

python3 "$REPO/scripts/prep/fetch_gfs.py" --hours "$MAX_HOURS" --step "$BDY_INTERVAL_H" --out "$WORK/gfs" ${CYCLE:+--cycle "$CYCLE"}
START="$(python3 -c "import json;print(json.load(open('$WORK/gfs/cycle.json'))['start'])")"
echo "initialising from $START"

# ---- WPS ------------------------------------------------------------------
cd "$NATIVE/WPS"
rm -f GRIBFILE.* FILE:* met_em.* PFILE:* geo_em.d01.nc
cp "$GEO" geo_em.d01.nc
python3 "$REPO/scripts/prep/domain.py" wps --start "$START" --hours "$MAX_HOURS" --geog /unused > namelist.wps
ln -sf ungrib/Variable_Tables/Vtable.GFS Vtable
python3 - "$WORK/gfs" <<'PY'
import glob, itertools, os, string, sys
files = sorted(glob.glob(os.path.join(sys.argv[1], "GFS_*.grib2")))
names = ("".join(t) for t in itertools.product(string.ascii_uppercase, repeat=3))
for f, n in zip(files, names):
    link = f"GRIBFILE.{n}"
    if os.path.lexists(link): os.remove(link)
    os.symlink(os.path.abspath(f), link)
print(len(files), "GRIB files linked")
PY
./ungrib.exe  > ungrib.out  2>&1 || { tail -40 ungrib.out;  exit 1; }
./metgrid.exe > metgrid.out 2>&1 || { tail -40 metgrid.out; exit 1; }
ls met_em.d01.* | wc -l

NML="$(ncdump -h "$(ls met_em.d01.* | head -1)" | grep -oE 'num_metgrid_levels = [0-9]+' | grep -oE '[0-9]+$')"
SOIL="$(ncdump -h "$(ls met_em.d01.* | head -1)" | grep -oE ':NUM_METGRID_SOIL_LEVELS = [0-9]+' | grep -oE '[0-9]+$' || echo 4)"
echo "num_metgrid_levels=$NML soil_levels=$SOIL"

# ---- real.exe ---------------------------------------------------------------
python3 "$REPO/scripts/prep/domain.py" template --nml "$NML" --soil "$SOIL" > "$OUT/data/namelist.input.template"
cd "$NATIVE/WRF/run"
rm -f met_em.* wrfinput_d01 wrfbdy_d01
ln -sf "$NATIVE"/WPS/met_em.d01.* .
python3 "$REPO/scripts/prep/domain.py" fill "$OUT/data/namelist.input.template" --start "$START" --hours "$MAX_HOURS" > namelist.input
./real.exe > real.out 2>&1 || { tail -60 real.out; cat rsl.error.0000 2>/dev/null | tail -40; exit 1; }
tail -2 real.out
cp wrfinput_d01 wrfbdy_d01 "$OUT/data/"

cp "$WORK/gfs/cycle.json" "$OUT/data/cycle.json"
python3 "$REPO/scripts/prep/domain.py" params > "$OUT/data/domain.json"
ls -l "$OUT/data"
