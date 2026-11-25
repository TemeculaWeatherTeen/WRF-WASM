#!/usr/bin/env python3
"""Write WRF-shaped netCDF-classic files (same dimension names, staggering, record layout as wrfout)
with analytically known contents, plus expected.json with independently computed answers."""
import datetime, json, math, os, sys
import numpy as np
from scipy.io import netcdf_file

out = sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures"
os.makedirs(out, exist_ok=True)
for f in os.listdir(out):
    os.remove(os.path.join(out, f))

nx, ny, nz, NF = 53, 28, 33, 6
DX = 12000.0
G, RD, CP = 9.81, 287.04, 1004.64
ptop = 5000.0
lon0, lat_mid = -121.0, 33.9

# Mercator geometry like the real grid: lon linear in i, merc-y linear in j
dlon = DX / (6370000 * math.cos(math.radians(34))) * 180 / math.pi
my_s = math.log(math.tan(math.pi / 4 + math.radians(32.5) / 2))
dmy = DX / (6370000 * math.cos(math.radians(34)))
lons1 = lon0 + dlon * np.arange(nx)
lats1 = np.degrees(2 * np.arctan(np.exp(my_s + dmy * np.arange(ny))) - math.pi / 2)
XLONG = np.tile(lons1, (ny, 1)).astype("f4")
XLAT = np.tile(lats1[:, None], (1, nx)).astype("f4")

I, J = np.meshgrid(np.arange(nx), np.arange(ny))
HGT = (1800 * np.exp(-(((I - 35) / 6) ** 2 + ((J - 15) / 5) ** 2))).astype("f4")  # a 1800 m mountain

psfc = 101325 * (1 - HGT / 44330.77) ** 5.255          # standard atmosphere
eta_stag = np.linspace(1, 0, nz + 1) ** 1.3             # 1 at surface -> 0 at top
eta_stag[0], eta_stag[-1] = 1, 0
p_stag = ptop + (psfc[None] - ptop) * eta_stag[:, None, None]   # (nz+1, ny, nx)
p_mass = 0.5 * (p_stag[:-1] + p_stag[1:])
def z_of_p(p): return 44330.77 * (1 - (p / 101325) ** 0.190263)
def t_of_z(z): return np.where(z < 11000, 288.15 - 0.0065 * z, 216.65)
z_stag = z_of_p(p_stag); z_mass = z_of_p(p_mass)
tk = t_of_z(z_mass) + 5.0 * (I / nx)[None]              # west-east gradient
theta = tk * (1e5 / p_mass) ** (RD / CP)

es = 611.2 * np.exp(17.67 * (tk - 273.15) / (tk - 273.15 + 243.5))
e = 0.5 * es                                            # 50 % RH everywhere
qv = 0.622 * e / (p_mass - e)

PB = p_mass.astype("f4")
P = (30 * np.sin(I / 7.0)[None] * np.ones((nz, 1, 1))).astype("f4")  # small non-zero perturbation
p_tot = PB.astype("f8") + P
# keep temperature consistent with the *total* pressure so expected values are exact
Tpert = (tk * (1e5 / p_tot) ** (RD / CP) - 300).astype("f4")
PHB = (G * z_stag).astype("f4"); PH = np.zeros_like(PHB)

# winds: u = 8 + z/1500, v = 1e-4 * x  (=> relative vorticity 1e-4 s^-1 everywhere)
xm = DX * np.arange(nx + 1)
U = (8 + z_stag[:-1][:, :, :1].repeat(nx + 1, 2) / 1500).astype("f4")           # (nz, ny, nx+1), uses lowest-z approx
U = np.empty((nz, ny, nx + 1), "f4")
zz = z_mass
for i in range(nx + 1):
    ii = min(max(i, 0), nx - 1)
    U[:, :, i] = 8 + zz[:, :, ii] / 1500
xmv = DX * (np.arange(nx) + 0.5)
V = np.empty((nz, ny + 1, nx), "f4")
V[:] = (1e-4 * xmv)[None, None, :]
W = np.zeros((nz + 1, ny, nx), "f4")

mu = (psfc - ptop).astype("f4")
DNW = np.diff(eta_stag).astype("f4")                    # negative
CLD = np.zeros((nz, ny, nx), "f4"); CLD[(p_mass > 50000) & (p_mass < 70000)] = 0.6
cldlow = (p_mass > 68000)  # for the low-cloud test, add 0.3 right at the surface layer only
CLD[0] = 0.3

def blob(f):
    return (20 * np.exp(-(((I - (10 + 5 * f)) / 5) ** 2 + ((J - 12) / 4) ** 2))).astype("f4")

def write(path, f, version):
    nc = netcdf_file(path, "w", version=version)
    nc.DX = DX; nc.DY = DX; nc.TITLE = "synthetic"
    nc.createDimension("Time", None); nc.createDimension("DateStrLen", 19)
    nc.createDimension("west_east", nx); nc.createDimension("south_north", ny); nc.createDimension("bottom_top", nz)
    nc.createDimension("west_east_stag", nx + 1); nc.createDimension("south_north_stag", ny + 1); nc.createDimension("bottom_top_stag", nz + 1)
    nc.createDimension("soil_layers_stag", 4)
    def var(name, typ, dims, data, desc="", units=""):
        v = nc.createVariable(name, typ, dims)
        v[0] = data
        v.description = desc; v.units = units
        return v
    t = nc.createVariable("Times", "c", ("Time", "DateStrLen"))
    ts = (datetime.datetime(2026, 11, 24, 18) + datetime.timedelta(hours=f)).strftime("%Y-%m-%d_%H:%M:%S")
    t[0] = np.frombuffer(ts.encode(), dtype="S1")
    S2 = ("Time", "south_north", "west_east"); S3 = ("Time", "bottom_top", "south_north", "west_east")
    var("XLAT", "f", S2, XLAT); var("XLONG", "f", S2, XLONG); var("HGT", "f", S2, HGT, "Terrain Height", "m")
    var("T2", "f", S2, (tk[0] - 0.5).astype("f4") + 2 * f, "2m T", "K")
    var("Q2", "f", S2, qv[0].astype("f4"), "QV at 2 M", "kg kg-1")
    var("PSFC", "f", S2, psfc.astype("f4"), "SFC PRESSURE", "Pa")
    var("U10", "f", S2, np.full((ny, nx), 3.0, "f4")); var("V10", "f", S2, np.full((ny, nx), 4.0, "f4"))
    var("RAINC", "f", S2, np.zeros((ny, nx), "f4")); var("RAINNC", "f", S2, blob(f) * f, "ACCUMULATED GRID SCALE PRECIPITATION", "mm")
    var("SNOWNC", "f", S2, np.zeros((ny, nx), "f4"))
    var("TSK", "f", S2, tk[0].astype("f4") + 1, "SURFACE SKIN TEMPERATURE", "K")
    var("PBLH", "f", S2, np.full((ny, nx), 800.0, "f4"), "PBL HEIGHT", "m")
    var("SWDOWN", "f", S2, np.full((ny, nx), 400.0, "f4"), "DOWNWARD SHORT WAVE FLUX AT GROUND SURFACE", "W m-2")
    var("MU", "f", S2, mu); var("MUB", "f", S2, np.zeros((ny, nx), "f4"))
    var("QFX", "f", S2, np.full((ny, nx), 1e-5, "f4"), "UPWARD MOISTURE FLUX AT THE SURFACE", "kg m-2 s-1")
    var("P", "f", S3, P); var("PB", "f", S3, PB)
    var("T", "f", S3, Tpert); var("QVAPOR", "f", S3, qv.astype("f4"), "Water vapor mixing ratio", "kg kg-1")
    var("QCLOUD", "f", S3, np.zeros((nz, ny, nx), "f4")); var("CLDFRA", "f", S3, CLD)
    r = np.full((nz, ny, nx), -30.0, "f4"); r[3] = blob(f) * 3; r[8] = blob(f) * 2
    var("REFL_10CM", "f", S3, r, "Radar reflectivity", "dBZ")
    var("U", "f", ("Time", "bottom_top", "south_north", "west_east_stag"), U)
    var("V", "f", ("Time", "bottom_top", "south_north_stag", "west_east"), V)
    var("W", "f", ("Time", "bottom_top_stag", "south_north", "west_east"), W)
    var("PH", "f", ("Time", "bottom_top_stag", "south_north", "west_east"), PH)
    var("PHB", "f", ("Time", "bottom_top_stag", "south_north", "west_east"), PHB)
    var("DNW", "f", ("Time", "bottom_top"), DNW)
    var("TSLB", "f", ("Time", "soil_layers_stag", "south_north", "west_east"), np.full((4, ny, nx), 290.0, "f4"))
    nc.close()

for f in range(NF):
    t = datetime.datetime(2026, 11, 24, 18) + datetime.timedelta(hours=f)
    write(os.path.join(out, f"wrfout_d01_{t:%Y-%m-%d_%H:%M:%S}.nc"), f, 1 if f % 2 == 0 else 2)

# ---- independent expectations (numpy only, no JS logic)
def interp_logp(field, target):
    res = np.full((ny, nx), np.nan)
    ptot = p_tot
    for j in range(ny):
        for i in range(nx):
            col_p = ptot[:, j, i]
            if col_p[0] < target: continue
            for k in range(nz - 1):
                if col_p[k] >= target >= col_p[k + 1]:
                    w = math.log(target / col_p[k]) / math.log(col_p[k + 1] / col_p[k])
                    res[j, i] = field[k, j, i] * (1 - w) + field[k + 1, j, i] * w
                    break
    return res
tk_tot = (Tpert + 300) * (p_tot / 1e5) ** (RD / CP)
t850 = interp_logp(tk_tot, 85000.0)
u3 = 0.5 * (U[:, :, :-1] + U[:, :, 1:]); v3 = 0.5 * (V[:, :-1, :] + V[:, 1:, :])
ws500 = interp_logp(np.hypot(u3, v3), 50000.0)
z500 = interp_logp(0.5 * (z_stag[:-1] + z_stag[1:]), 50000.0)  # WRF convention: mean of the two staggered heights
dp = -np.diff(p_stag, axis=0)
pw = (qv * dp / G).sum(0)
exp = {
    "nx": nx, "ny": ny, "nz": nz, "frames": NF, "dx": DX,
    "pts": {"ocean": [5, 20], "mountain": [35, 15], "mid": [20, 10]},
    "t850": {"ocean": float(t850[20, 5]), "mid": float(t850[10, 20]), "mountain_is_nan": bool(np.isnan(t850[15, 35]))},
    "ws500": {"ocean": float(ws500[20, 5]), "mid": float(ws500[10, 20])},
    "z500": {"ocean": float(z500[20, 5])},
    "rh2": 50.0, "rh850_ocean": 50.0,
    "pw": {"ocean": float(pw[20, 5]), "mountain": float(pw[15, 35])},
    "vort500_mid": 10.0,
    "pcp_total_f3_peak": float(blob(3).max() * 3),
    "pcp_1h_f3_peak": float((blob(3) * 3 - blob(2) * 2).max()),
    "refl_comp_peak_f3": float(blob(3).max() * 3),
    "cc_mid": 60.0, "cc_low_surface_layer": 30.0,
    "lat_first": float(XLAT[0, 0]), "lon_first": float(XLONG[0, 0]),
    "lat_last": float(XLAT[ny - 1, 0]), "lon_last": float(XLONG[0, nx - 1]),
}
json.dump(exp, open(os.path.join(out, "expected.json"), "w"), indent=1)
print("wrote", NF, "frames +", "expected.json", "to", out)
