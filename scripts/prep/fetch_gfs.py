#!/usr/bin/env python3
"""Download the latest available GFS 0.25-degree cycle from the NOAA open-data bucket on AWS.

GFS is what WRF is normally initialised from. For every forecast hour we read the .idx sidecar,
pick only the GRIB2 messages WPS needs (pressure-level HGT/TMP/RH/UGRD/VGRD, a short list of
surface/2 m/10 m/soil fields), fetch just those byte ranges, concatenate them (concatenated GRIB2
messages are a valid GRIB2 file) and, if wgrib2 is installed, crop to the region of interest.

  fetch_gfs.py --hours 72 --step 3 --out gfs/
Writes gfs/GFS_<YYYYMMDDHH>_f<FFF>.grib2 and gfs/cycle.json.
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
PRESSURE_VARS = {"HGT", "TMP", "RH", "UGRD", "VGRD"}
SURFACE_VARS = {"PRMSL", "PRES", "HGT", "TMP", "RH", "SPFH", "UGRD", "VGRD",
                "LAND", "ICEC", "WEASD", "SNOD", "SOILW", "TSOIL"}
SURFACE_LEVELS = {"surface", "2 m above ground", "10 m above ground", "mean sea level"}


def url(cycle, fhr, ext=""):
    d, h = cycle.strftime("%Y%m%d"), cycle.strftime("%H")
    return f"{BASE}/gfs.{d}/{h}/atmos/gfs.t{h}z.pgrb2.0p25.f{fhr:03d}{ext}"


def http(u, method="GET", headers=None, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(u, method=method, headers=headers or {})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read() if method == "GET" else b""
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                raise
            last = e
        except Exception as e:  # network hiccup
            last = e
        time.sleep(2 * (i + 1))
    raise last


def exists(u):
    try:
        http(u, "HEAD", tries=1)
        return True
    except Exception:
        return False


def wanted(var, level):
    if re.fullmatch(r"[\d.]+ mb", level):
        return var in PRESSURE_VARS
    if level in SURFACE_LEVELS or "m below ground" in level:
        return var in SURFACE_VARS
    return False


def select_ranges(idx_text):
    """Parse a wgrib2-style .idx into merged (start, end_or_None) byte ranges of the wanted messages."""
    rows = []
    for line in idx_text.splitlines():
        f = line.split(":")
        if len(f) < 6:
            continue
        rows.append((int(f[1]), f[3], f[4]))
    ranges = []
    for i, (off, var, level) in enumerate(rows):
        if not wanted(var, level):
            continue
        end = rows[i + 1][0] - 1 if i + 1 < len(rows) else None
        if ranges and ranges[-1][1] is not None and ranges[-1][1] + 1 == off:
            ranges[-1] = (ranges[-1][0], end)
        else:
            ranges.append((off, end))
    return ranges


def fetch_range(u, start, end):
    rng = f"bytes={start}-{'' if end is None else end}"
    return http(u, headers={"Range": rng})


def download_hour(cycle, fhr, out_dir, bbox):
    u = url(cycle, fhr)
    idx = http(u + ".idx").decode()
    ranges = select_ranges(idx)
    if not ranges:
        raise RuntimeError(f"no wanted messages found in {u}.idx")
    with cf.ThreadPoolExecutor(8) as ex:
        parts = list(ex.map(lambda r: fetch_range(u, *r), ranges))
    name = f"GFS_{cycle:%Y%m%d%H}_f{fhr:03d}.grib2"
    raw = os.path.join(out_dir, name + ".raw")
    with open(raw, "wb") as fh:
        for p in parts:
            fh.write(p)
    final = os.path.join(out_dir, name)
    if shutil.which("wgrib2") and bbox:
        w, e, s, n = bbox
        subprocess.run(["wgrib2", raw, "-small_grib", f"{w}:{e}", f"{s}:{n}", final],
                       check=True, stdout=subprocess.DEVNULL)
        os.remove(raw)
    else:
        os.replace(raw, final)
    return name, os.path.getsize(final)


def pick_cycle(now, last_fhr, forced=None):
    if forced:
        return dt.datetime.strptime(forced, "%Y%m%d%H")
    base = now.replace(minute=0, second=0, microsecond=0)
    base -= dt.timedelta(hours=base.hour % 6)
    for k in range(10):
        c = base - dt.timedelta(hours=6 * k)
        if exists(url(c, last_fhr, ".idx")):
            return c
    raise RuntimeError("no complete GFS cycle found in the last 60 hours")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=72)
    ap.add_argument("--step", type=int, default=3)
    ap.add_argument("--out", default="gfs")
    ap.add_argument("--cycle", help="force a cycle, YYYYMMDDHH")
    ap.add_argument("--bbox", default="235:247:28:40", help="lonW:lonE:latS:latN in 0-360 lon; empty = no crop")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    cycle = pick_cycle(dt.datetime.now(dt.timezone.utc).replace(tzinfo=None), a.hours, a.cycle)
    print(f"cycle {cycle:%Y-%m-%d %HZ}", flush=True)
    bbox = None
    if a.bbox:
        w, e, s, n = (float(x) for x in a.bbox.split(":"))
        bbox = (w, e, s, n)
    if bbox and not shutil.which("wgrib2"):
        print("warning: wgrib2 not found; files will be global and large", file=sys.stderr)

    total = 0
    for fhr in range(0, a.hours + 1, a.step):
        name, size = download_hour(cycle, fhr, a.out, bbox)
        total += size
        print(f"  f{fhr:03d} {name} {size/1e6:.1f} MB", flush=True)
    json.dump({"cycle": f"{cycle:%Y%m%d%H}", "start": f"{cycle:%Y-%m-%d_%H}:00:00",
               "hours": a.hours, "step": a.step, "bytes": total},
              open(os.path.join(a.out, "cycle.json"), "w"))


if __name__ == "__main__":
    main()
