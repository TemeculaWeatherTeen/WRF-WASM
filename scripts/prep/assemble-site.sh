#!/usr/bin/env bash
# Combine UI + wasm build + forecast inputs into the directory GitHub Pages will serve.
# Usage: assemble-site.sh <wasm-dir with wrf.js wrf.wasm run/> <public-dir that already has data/>
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WASM="${1:?wasm dir}"; PUB="${2:?public dir}"
source "$REPO/config/forecast.env"

cp -r "$REPO/site/." "$PUB/"
mkdir -p "$PUB/wasm" "$PUB/data/run"
cp "$WASM/wrf.js" "$WASM/wrf.wasm" "$PUB/wasm/"
cp -L "$WASM/run/"* "$PUB/data/run/"

python3 - "$PUB" "$MAX_HOURS" <<'PY'
import datetime as dt, json, os, sys
pub, max_hours = sys.argv[1], int(sys.argv[2])
cycle = json.load(open(f"{pub}/data/cycle.json"))
domain = json.load(open(f"{pub}/data/domain.json"))
manifest = {
    "cycle": cycle["cycle"],
    "start": cycle["start"],
    "maxHours": max_hours,
    "intervalSeconds": domain["interval_seconds"],
    "historyMinutes": domain["history_interval"],
    "domain": domain,
    "input": "data/wrfinput_d01",
    "bdy": "data/wrfbdy_d01",
    "namelist": "data/namelist.input.template",
    "run": sorted(os.listdir(f"{pub}/data/run")),
    "builtAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
}
json.dump(manifest, open(f"{pub}/data/manifest.json", "w"), indent=1)
print("manifest:", manifest["cycle"], len(manifest["run"]), "run-time files")
PY
touch "$PUB/.nojekyll"
du -sh "$PUB"; du -h "$PUB/wasm"/* "$PUB/data"/wrf* | sort -h | tail
