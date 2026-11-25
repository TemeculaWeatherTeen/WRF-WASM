#!/usr/bin/env python3
"""Domain geometry and namelist generation (stdlib only).

  domain.py params                          -> JSON describing the Mercator grid
  domain.py wps   --start S --hours H --geog DIR   -> namelist.wps
  domain.py template --nml N [--soil 4]     -> namelist.input with @@placeholders@@ (what the browser fills in)
  domain.py fill TEMPLATE --start S --hours H      -> namelist.input with concrete dates

S is YYYY-MM-DD_HH:00:00 (UTC).

Why Mercator: it is conformal and its grid axes are exactly east/north, so wind components need no
rotation and the grid is linear in Web-Mercator screen space, which makes the browser overlay trivial.
"""
import argparse
import datetime as dt
import json
import math
import os
import re
import sys

R_EARTH = 6370000.0  # WRF's sphere


def load_env(path):
    env = {}
    for line in open(path):
        line = line.split("#", 1)[0].strip()
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


HERE = os.path.dirname(os.path.abspath(__file__))
ENV = load_env(os.path.join(HERE, "..", "..", "config", "forecast.env"))


def merc_y(lat_deg, truelat):
    lat = math.radians(lat_deg)
    return R_EARTH * math.cos(math.radians(truelat)) * math.log(math.tan(math.pi / 4 + lat / 2))


def inv_merc_y(y, truelat):
    return math.degrees(2 * math.atan(math.exp(y / (R_EARTH * math.cos(math.radians(truelat))))) - math.pi / 2)


def params():
    n, s = float(ENV["BBOX_N"]), float(ENV["BBOX_S"])
    w, e = float(ENV["BBOX_W"]), float(ENV["BBOX_E"])
    tl = float(ENV["TRUELAT"])
    dx = float(ENV["DX"])
    width = math.radians(e - w) * R_EARTH * math.cos(math.radians(tl))
    y_n, y_s = merc_y(n, tl), merc_y(s, tl)
    cells_we = math.ceil(width / dx)
    cells_sn = math.ceil((y_n - y_s) / dx)
    return {
        "map_proj": "mercator",
        "dx": dx, "dy": dx,
        "e_we": cells_we + 1, "e_sn": cells_sn + 1,
        "e_vert": int(ENV["E_VERT"]),
        "ref_lat": round(inv_merc_y((y_n + y_s) / 2, tl), 5),
        "ref_lon": round((w + e) / 2, 5),
        "truelat1": tl,
        "time_step": int(6 * dx / 1000),
        "interval_seconds": int(ENV["BDY_INTERVAL_H"]) * 3600,
        "history_interval": int(ENV["HISTORY_INTERVAL_MIN"]),
        "max_hours": int(ENV["MAX_HOURS"]),
        "bbox": {"n": n, "s": s, "w": w, "e": e},
    }


def parse_start(s):
    return dt.datetime.strptime(s, "%Y-%m-%d_%H:%M:%S")


def fmt(d):
    return d.strftime("%Y-%m-%d_%H:%M:%S")


def namelist_wps(p, start, hours, geog):
    end = start + dt.timedelta(hours=hours)
    return f"""&share
 wrf_core = 'ARW',
 max_dom = 1,
 start_date = '{fmt(start)}',
 end_date   = '{fmt(end)}',
 interval_seconds = {p['interval_seconds']},
 io_form_geogrid = 2,
/
&geogrid
 parent_id = 1,
 parent_grid_ratio = 1,
 i_parent_start = 1,
 j_parent_start = 1,
 e_we = {p['e_we']},
 e_sn = {p['e_sn']},
 geog_data_res = 'default',
 dx = {p['dx']:.1f},
 dy = {p['dy']:.1f},
 map_proj = 'mercator',
 ref_lat = {p['ref_lat']},
 ref_lon = {p['ref_lon']},
 truelat1 = {p['truelat1']},
 stand_lon = {p['ref_lon']},
 geog_data_path = '{geog}',
/
&ungrib
 out_format = 'WPS',
 prefix = 'GFS',
/
&metgrid
 fg_name = 'GFS',
 io_form_metgrid = 2,
/
"""


def namelist_template(p, nml, soil):
    return f"""&time_control
 run_days = 0,
 run_hours = @@RUN_HOURS@@,
 run_minutes = 0,
 run_seconds = 0,
 start_year = @@SY@@, start_month = @@SM@@, start_day = @@SD@@, start_hour = @@SH@@, start_minute = 00, start_second = 00,
 end_year = @@EY@@, end_month = @@EM@@, end_day = @@ED@@, end_hour = @@EH@@, end_minute = 00, end_second = 00,
 interval_seconds = {p['interval_seconds']},
 input_from_file = .true.,
 history_interval = {p['history_interval']},
 frames_per_outfile = 1,
 restart = .false.,
 io_form_history = 2,
 io_form_restart = 2,
 io_form_input = 2,
 io_form_boundary = 2,
 debug_level = 0,
/
&domains
 time_step = {p['time_step']},
 time_step_fract_num = 0,
 time_step_fract_den = 1,
 max_dom = 1,
 e_we = {p['e_we']},
 e_sn = {p['e_sn']},
 e_vert = {p['e_vert']},
 dx = {p['dx']:.1f},
 dy = {p['dy']:.1f},
 p_top_requested = 5000,
 num_metgrid_levels = {nml},
 num_metgrid_soil_levels = {soil},
 grid_id = 1,
 parent_id = 0,
 i_parent_start = 1,
 j_parent_start = 1,
 parent_grid_ratio = 1,
 parent_time_step_ratio = 1,
 feedback = 1,
 smooth_option = 0,
/
&physics
 mp_physics = 6,
 do_radar_ref = 1,
 ra_lw_physics = 4,
 ra_sw_physics = 4,
 radt = {max(1, int(p['dx'] / 1000))},
 sf_sfclay_physics = 1,
 sf_surface_physics = 2,
 bl_pbl_physics = 1,
 bldt = 0,
 cu_physics = 1,
 cudt = 0,
 num_soil_layers = 4,
 sf_urban_physics = 0,
 icloud = 1,
/
&dynamics
 hybrid_opt = 2,
 w_damping = 0,
 diff_opt = 1,
 km_opt = 4,
 diff_6th_opt = 0,
 diff_6th_factor = 0.12,
 base_temp = 290.,
 damp_opt = 3,
 zdamp = 5000.,
 dampcoef = 0.2,
 khdif = 0,
 kvdif = 0,
 non_hydrostatic = .true.,
 moist_adv_opt = 1,
 scalar_adv_opt = 1,
 gwd_opt = 0,
/
&bdy_control
 spec_bdy_width = 5,
 spec_zone = 1,
 relax_zone = 4,
 specified = .true.,
 nested = .false.,
/
&namelist_quilt
 nio_tasks_per_group = 0,
 nio_groups = 1,
/
"""


def fill(template, start, hours):
    end = start + dt.timedelta(hours=hours)
    vals = {
        "RUN_HOURS": str(hours),
        "SY": f"{start.year:04d}", "SM": f"{start.month:02d}", "SD": f"{start.day:02d}", "SH": f"{start.hour:02d}",
        "EY": f"{end.year:04d}", "EM": f"{end.month:02d}", "ED": f"{end.day:02d}", "EH": f"{end.hour:02d}",
    }
    return re.sub(r"@@(\w+)@@", lambda m: vals[m.group(1)], template)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("params")
    w = sub.add_parser("wps")
    w.add_argument("--start", required=True)
    w.add_argument("--hours", type=int, required=True)
    w.add_argument("--geog", required=True)
    t = sub.add_parser("template")
    t.add_argument("--nml", type=int, required=True, help="num_metgrid_levels from the met_em files")
    t.add_argument("--soil", type=int, default=4)
    f = sub.add_parser("fill")
    f.add_argument("template")
    f.add_argument("--start", required=True)
    f.add_argument("--hours", type=int, required=True)
    a = ap.parse_args()

    p = params()
    if a.cmd == "params":
        json.dump(p, sys.stdout, indent=2)
        print()
    elif a.cmd == "wps":
        sys.stdout.write(namelist_wps(p, parse_start(a.start), a.hours, a.geog))
    elif a.cmd == "template":
        sys.stdout.write(namelist_template(p, a.nml, a.soil))
    elif a.cmd == "fill":
        sys.stdout.write(fill(open(a.template).read(), parse_start(a.start), a.hours))


if __name__ == "__main__":
    main()
