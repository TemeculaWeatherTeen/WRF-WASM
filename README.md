# WRF in the browser — Southern California

The real WRF-ARW model (`wrf-model/WRF`), compiled to WebAssembly, running in a Web Worker on the visitor's machine.
Domain: a rectangle from San Luis Obispo (35.4°N, 121.0°W) to Yuma, AZ (32.5°N, 114.3°W), 12 km grid, 33 levels.
GitHub Actions builds everything and hosts it on GitHub Pages.

## Status — read this first

| Piece | State |
|---|---|
| Browser app (map, value picker, playback, frame slider, hover readout, units, run/cancel, IndexedDB cache) | **Tested** (headless Chrome, 84+10 unit checks, synthetic wrfout) |
| netCDF reader, 40+ derived fields, pressure-level interpolation | **Tested** against independent numpy answers |
| Worker/runner that feeds `wrf.wasm` and streams `wrfout` frames | **Tested** against a mock Emscripten module only |
| Preprocessing scripts (domain math, GFS fetch + byte-range subsetting, namelists, GEOGRID.TBL patch) | Unit-tested where possible; **never run against the real servers** (the authoring sandbox had no network) |
| **WRF → wasm compile** (`scripts/wasm/*`) | **Untested. Expect to iterate.** |
| GitHub workflows | Written, never executed |

Nobody has built WRF for wasm before as far as I could find. Fortran→wasm works (webR, emscripten-forge, r-wasm/flang-wasm
compile LAPACK, R, etc.), but WRF is ~1M lines, and LLVM `flang` has open bugs on WRF-sized code. Likely first-run trouble:

* `flang` crashes or rejects some WRF source file → patch/exclude it, or try `FLANG_SOURCE=docker` (r-wasm's patched LLVM) in workflow 1.
* WRF's build runs generated programs on the build machine (registry etc.); they use `CC_TOOLS=gcc`. If something else tries to run a wasm binary, make it use gcc.
* Big-endian RRTMG data files: handled with `-fconvert=big-endian` and `FORT_CONVERT=BIG_ENDIAN` set in `wrf-runner.js`. If radiation reads garbage, this is the place.
* Memory/stack: link flags are in `scripts/wasm/build-wrf.sh` (`WASM_LDFLAGS`).
* Every failure uploads its logs as a workflow artifact.

## Data: where WRF gets its initial/boundary conditions

Real WRF is driven by a global model. This project uses **NOAA GFS 0.25°** from the NOAA open-data bucket on AWS
(`noaa-gfs-bdp-pds`), exactly what WPS's `Vtable.GFS` expects. Open-Meteo was not used: it serves point/grid
*forecast outputs*, not the 3-D model-level GRIB fields WRF needs.

## How it works

```
every 6 h (GitHub Actions, native gfortran)        in the visitor's browser (wasm)
GFS GRIB2 ─ ungrib ─ metgrid ─ real.exe ──────►   wrfinput + wrfbdy  ─►  wrf.wasm  ─►  wrfout frames ─► map
        (geo_em.d01.nc built once)                 (static files on Pages)   (Web Worker)
```

`real.exe` runs in CI because WPS needs ~2 GB of static data and GRIB2 decoding; its output is a few MB. The *forecast*
(`wrf.exe`, the expensive part) is the wasm. Both builds use the same WRF version so the files are compatible.

## Set-up

1. Create a repo from this folder; push to `main`.
2. Settings → Pages → Source: **GitHub Actions**.
3. Actions → run **1 - Build WRF to WebAssembly** (hours; fix and re-run until green).
4. Actions → run **2 - Build static geography** once (re-run only if you change the domain).
5. Actions → run **3 - Forecast inputs and deploy site**. After that it refreshes itself every 6 h.
6. Open the Pages URL. The model starts automatically (`?autorun=0` disables that).

Change the domain, resolution, forecast length or WRF version in `config/forecast.env`. Cost scales roughly with
`1/DX³`: 12 km ≈ minutes per forecast day; 6 km ≈ 8× that.

## The popup (bottom-left)

Value picker (grouped; also exposes any other variable WRF wrote), level picker for upper-air fields, legend,
timeline with slider + play/pause/step/first/last + speed, wind arrows, units, opacity, model run controls and log.
Keys: Space = play/pause, ←/→ = step. Hover the map for a value and terrain height.

Fields: 2 m temp/dew point/RH/feels-like, skin temp, 10 m wind, SLP, terrain, PBL height, freezing level, precip
(total / hourly), snow, composite + lowest-level radar, cloud cover (total/low/mid/high), precipitable water, cloud
water path, radiation and heat fluxes, soil temp/moisture, and at 12 pressure levels: temperature, RH, wind, height,
vertical velocity, θ, vapor, vorticity. SLP is a simple reduction, not WRF-post's.

## Tests

```
python3 tests/make_synthetic.py tests/fixtures
node tests/test-derive.mjs && node tests/test-runner.mjs
```
`tests/browser-test.mjs` drives the page in Chrome (needs Playwright; serve `site/` plus `tests/fixtures` as `fx/`).
Run the real thing under Node with `node scripts/wasm/node-smoke.mjs public 1` (also done in workflow 3).

## Caveats

* Downloads: ~35 MB (boundary file for 72 h) + the wasm binary. Single-threaded; runs in a worker so the page stays responsive.
* Simulated browser memory can exceed phones' limits; desktop recommended.
* A 12 km model initialised from 25 km GFS is a real forecast, not an official one. Don't use it for decisions that matter.
* Basemap tiles: © OpenStreetMap, © CARTO. WRF is public domain (NCAR); GFS is NOAA open data.
