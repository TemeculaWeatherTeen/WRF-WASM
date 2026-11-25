// Turns raw WRF output (wrfout netCDF) into the fields shown on the map.
// All grids are Float32Array(nx*ny), row-major with j=0 at the southern edge, like WRF.
import { parseNetCDF } from "./netcdf.js";

const G = 9.81, RD = 287.04, CP = 1004.64, KAPPA = RD / CP, P0 = 1e5;

export const PRESSURE_LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100];

// ---------------------------------------------------------------- unit presets
const noconv = (label) => ({ si: { label, f: (v) => v }, us: { label, f: (v) => v } });
export const UNITS = {
  tempK: { si: { label: "°C", f: (v) => v - 273.15 }, us: { label: "°F", f: (v) => (v - 273.15) * 1.8 + 32 } },
  speed: { si: { label: "m/s", f: (v) => v }, us: { label: "mph", f: (v) => v * 2.236936 } },
  mm: { si: { label: "mm", f: (v) => v }, us: { label: "in", f: (v) => v / 25.4 } },
  snowmm: { si: { label: "cm", f: (v) => v / 10 }, us: { label: "in", f: (v) => v / 25.4 } },
  pa: { si: { label: "hPa", f: (v) => v / 100 }, us: { label: "inHg", f: (v) => v * 0.0002953 } },
  m: { si: { label: "m", f: (v) => v }, us: { label: "ft", f: (v) => v * 3.28084 } },
  gpm: { si: { label: "dam", f: (v) => v / 10 }, us: { label: "dam", f: (v) => v / 10 } },
  pct: noconv("%"),
  none: (label) => noconv(label),
};

// ---------------------------------------------------------------- Frame
export class Frame {
  constructor(bytes) {
    this.bytes = bytes;
    this.nc = parseNetCDF(bytes);
    const d = this.nc.dims;
    this.nx = d.west_east; this.ny = d.south_north; this.nz = d.bottom_top;
    this.n2 = this.nx * this.ny;
    this.cache = new Map();
    const t = this.nc.has("Times") ? this.nc.read("Times", 0) : "";
    this.timeStr = t;
    this.time = t ? new Date(t.replace("_", "T") + "Z") : null;
  }
  has(n) { return this.nc.has(n); }
  get(n) {
    if (!this.cache.has(n)) this.cache.set(n, this.nc.read(n, 0));
    return this.cache.get(n);
  }
  memo(key, fn) {
    if (!this.cache.has(key)) this.cache.set(key, fn());
    return this.cache.get(key);
  }
  // --- 3-D helpers on mass levels, index = k*n2 + j*nx + i
  get p3() { return this.memo("p3", () => { const P = this.get("P"), PB = this.get("PB"); return P.map((v, i) => v + PB[i]); }); }
  get tk3() {
    return this.memo("tk3", () => {
      const T = this.get("T"), p = this.p3;
      return T.map((th, i) => (th + 300) * Math.pow(p[i] / P0, KAPPA));
    });
  }
  get z3() { // geopotential height (m, MSL) at mass levels
    return this.memo("z3", () => {
      const PH = this.get("PH"), PHB = this.get("PHB"), n2 = this.n2, out = new Float32Array(n2 * this.nz);
      for (let k = 0; k < this.nz; k++) for (let a = 0; a < n2; a++)
        out[k * n2 + a] = 0.5 * (PH[k * n2 + a] + PHB[k * n2 + a] + PH[(k + 1) * n2 + a] + PHB[(k + 1) * n2 + a]) / G;
      return out;
    });
  }
  get qv3() { return this.get("QVAPOR"); }
  get rh3() {
    return this.memo("rh3", () => {
      const p = this.p3, t = this.tk3, q = this.qv3;
      return q.map((qv, i) => rhFrom(qv, p[i], t[i]));
    });
  }
  destag(name, axis) { // U: axis x (nx+1), V: axis y (ny+1), W: axis z (nz+1)
    return this.memo("d" + name, () => {
      const a = this.get(name), { nx, ny, nz, n2 } = this;
      const out = new Float32Array(n2 * nz);
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const o = k * n2 + j * nx + i;
        if (axis === "x") { const r = k * ny * (nx + 1) + j * (nx + 1) + i; out[o] = 0.5 * (a[r] + a[r + 1]); }
        else if (axis === "y") { const r = k * (ny + 1) * nx + j * nx + i; out[o] = 0.5 * (a[r] + a[r + nx]); }
        else { out[o] = 0.5 * (a[k * n2 + j * nx + i] + a[(k + 1) * n2 + j * nx + i]); }
      }
      return out;
    });
  }
  get u3() { return this.destag("U", "x"); }
  get v3() { return this.destag("V", "y"); }
  get w3() { return this.destag("W", "z"); }
  get lats() { return this.get("XLAT"); }
  get lons() { return this.get("XLONG"); }
  get dx() { return this.nc.attrs.DX || 12000; }
}

export function rhFrom(qv, p, tk) {
  const tc = tk - 273.15;
  const es = 611.2 * Math.exp((17.67 * tc) / (tc + 243.5));
  const e = (qv * p) / (0.622 + qv);
  return Math.max(0, Math.min(100, (100 * e) / es));
}
function dewpointK(q, psfc) {
  const e = Math.max((q * psfc) / (0.622 + q), 1e-3);
  const x = Math.log(e / 611.2);
  return (243.5 * x) / (17.67 - x) + 273.15;
}

// Interpolate a mass-level 3-D field to a pressure surface (log-p). NaN where the level is underground or above the top.
export function atPressure(frame, field3, hPa) {
  const { n2, nz } = frame, p = frame.p3, out = new Float32Array(n2), target = hPa * 100;
  for (let a = 0; a < n2; a++) {
    out[a] = NaN;
    if (p[a] < target) continue; // surface pressure lower than target: below ground
    for (let k = 0; k < nz - 1; k++) {
      const p1 = p[k * n2 + a], p2 = p[(k + 1) * n2 + a];
      if (p1 >= target && target >= p2) {
        const w = Math.log(target / p1) / Math.log(p2 / p1);
        out[a] = field3[k * n2 + a] * (1 - w) + field3[(k + 1) * n2 + a] * w;
        break;
      }
    }
  }
  return out;
}
const lowest = (frame, f3) => f3.slice(0, frame.n2);
const map2 = (n, fn) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = fn(i); return o; };

// ---------------------------------------------------------------- field registry
// A field: { id, label, group, units, cmap, range?, transparentBelow?, needs:[vars], level?:true, compute(frame, ctx) }
// ctx = { level, prev }  (prev = previous Frame, for accumulation differences)
const F = [];
const add = (f) => F.push(f);

// ---- surface
add({ id: "t2", label: "2 m temperature", group: "Surface", units: UNITS.tempK, cmap: "temp", needs: ["T2"], compute: (f) => f.get("T2") });
add({ id: "td2", label: "2 m dew point", group: "Surface", units: UNITS.tempK, cmap: "temp", needs: ["Q2", "PSFC"], compute: (f) => { const q = f.get("Q2"), p = f.get("PSFC"); return map2(f.n2, (i) => dewpointK(q[i], p[i])); } });
add({ id: "rh2", label: "2 m relative humidity", group: "Surface", units: UNITS.pct, cmap: "rh", range: [0, 100], needs: ["T2", "Q2", "PSFC"], compute: (f) => { const t = f.get("T2"), q = f.get("Q2"), p = f.get("PSFC"); return map2(f.n2, (i) => rhFrom(q[i], p[i], t[i])); } });
add({ id: "feels", label: "Feels-like temperature", group: "Surface", units: UNITS.tempK, cmap: "temp", needs: ["T2", "Q2", "PSFC", "U10", "V10"], compute: (f) => {
  const t = f.get("T2"), q = f.get("Q2"), p = f.get("PSFC"), u = f.get("U10"), v = f.get("V10");
  return map2(f.n2, (i) => {
    const tF = (t[i] - 273.15) * 1.8 + 32, rh = rhFrom(q[i], p[i], t[i]), mph = Math.hypot(u[i], v[i]) * 2.236936;
    let r = tF;
    if (tF >= 80) r = -42.379 + 2.04901523 * tF + 10.14333127 * rh - 0.22475541 * tF * rh - 6.83783e-3 * tF * tF - 5.481717e-2 * rh * rh + 1.22874e-3 * tF * tF * rh + 8.5282e-4 * tF * rh * rh - 1.99e-6 * tF * tF * rh * rh;
    else if (tF <= 50 && mph > 3) r = 35.74 + 0.6215 * tF - 35.75 * Math.pow(mph, 0.16) + 0.4275 * tF * Math.pow(mph, 0.16);
    return (r - 32) / 1.8 + 273.15;
  });
} });
add({ id: "tsk", label: "Skin temperature", group: "Surface", units: UNITS.tempK, cmap: "temp", needs: ["TSK"], compute: (f) => f.get("TSK") });
add({ id: "wspd10", label: "10 m wind speed", group: "Surface", units: UNITS.speed, cmap: "wind", needs: ["U10", "V10"], vectors: (f) => ({ u: f.get("U10"), v: f.get("V10") }), compute: (f) => { const u = f.get("U10"), v = f.get("V10"); return map2(f.n2, (i) => Math.hypot(u[i], v[i])); } });
add({ id: "slp", label: "Sea-level pressure (approx.)", group: "Surface", units: UNITS.pa, cmap: "viridis", needs: ["PSFC", "T2", "HGT"], compute: (f) => { const p = f.get("PSFC"), t = f.get("T2"), z = f.get("HGT"); return map2(f.n2, (i) => p[i] * Math.exp((G * z[i]) / (RD * (t[i] + 0.0033 * z[i])))); } });
add({ id: "psfc", label: "Surface pressure", group: "Surface", units: UNITS.pa, cmap: "viridis", needs: ["PSFC"], compute: (f) => f.get("PSFC") });
add({ id: "hgt", label: "Terrain height", group: "Surface", units: UNITS.m, cmap: "terrain", needs: ["HGT"], compute: (f) => f.get("HGT") });
add({ id: "pblh", label: "Boundary-layer height", group: "Surface", units: UNITS.m, cmap: "viridis", needs: ["PBLH"], compute: (f) => f.get("PBLH") });
add({ id: "frzlvl", label: "Freezing level (MSL)", group: "Surface", units: UNITS.m, cmap: "viridis", needs: ["P", "PB", "T", "PH", "PHB"], compute: (f) => {
  const t = f.tk3, z = f.z3, n2 = f.n2, out = new Float32Array(n2);
  for (let a = 0; a < n2; a++) {
    out[a] = NaN;
    if (t[a] < 273.15) { out[a] = f.get("HGT")[a]; continue; } // already below freezing at the surface
    for (let k = 0; k < f.nz - 1; k++) {
      const t1 = t[k * n2 + a], t2 = t[(k + 1) * n2 + a];
      if (t1 >= 273.15 && t2 < 273.15) { const w = (t1 - 273.15) / (t1 - t2); out[a] = z[k * n2 + a] * (1 - w) + z[(k + 1) * n2 + a] * w; break; }
    }
  }
  return out;
} });

// ---- precipitation, clouds, radar
const accum = (f) => { const a = f.get("RAINC"), b = f.get("RAINNC"); return map2(f.n2, (i) => a[i] + b[i]); };
add({ id: "pcp_total", label: "Precipitation, total since start", group: "Precipitation, clouds, radar", units: UNITS.mm, cmap: "precip", transparentBelow: 0.05, needs: ["RAINC", "RAINNC"], compute: accum });
add({ id: "pcp_1h", label: "Precipitation, last hour", group: "Precipitation, clouds, radar", units: UNITS.mm, cmap: "precip", transparentBelow: 0.02, needs: ["RAINC", "RAINNC"], compute: (f, c) => {
  const now = accum(f); if (!c.prev) return now.map(() => 0);
  const before = accum(c.prev); return map2(f.n2, (i) => Math.max(0, now[i] - before[i]));
} });
add({ id: "snow_total", label: "Snowfall, total since start (10:1)", group: "Precipitation, clouds, radar", units: UNITS.snowmm, cmap: "snow", transparentBelow: 0.2, needs: ["SNOWNC"], compute: (f) => f.get("SNOWNC").map((v) => v * 10) });
add({ id: "snowh", label: "Snow depth", group: "Precipitation, clouds, radar", units: UNITS.snowmm, cmap: "snow", transparentBelow: 0.001, needs: ["SNOWH"], compute: (f) => f.get("SNOWH").map((v) => v * 1000) });
add({ id: "refl_comp", label: "Composite radar reflectivity", group: "Precipitation, clouds, radar", units: UNITS.none("dBZ"), cmap: "radar", range: [5, 75], transparentBelow: 5, needs: ["REFL_10CM"], compute: (f) => {
  const r = f.get("REFL_10CM"), n2 = f.n2, out = new Float32Array(n2).fill(-30);
  for (let k = 0; k < f.nz; k++) for (let a = 0; a < n2; a++) if (r[k * n2 + a] > out[a]) out[a] = r[k * n2 + a];
  return out;
} });
add({ id: "refl_low", label: "Lowest-level radar reflectivity", group: "Precipitation, clouds, radar", units: UNITS.none("dBZ"), cmap: "radar", range: [5, 75], transparentBelow: 5, needs: ["REFL_10CM"], compute: (f) => lowest(f, f.get("REFL_10CM")) });
const cloudCover = (f, pTop, pBot) => { // max-overlap cloud fraction between two pressures (hPa)
  const c = f.get("CLDFRA"), p = f.p3, n2 = f.n2, out = new Float32Array(n2);
  for (let k = 0; k < f.nz; k++) for (let a = 0; a < n2; a++) { const hp = p[k * n2 + a] / 100; if (hp <= pBot && hp > pTop && c[k * n2 + a] > out[a]) out[a] = c[k * n2 + a]; }
  return out.map((v) => v * 100);
};
add({ id: "cc_total", label: "Cloud cover, total", group: "Precipitation, clouds, radar", units: UNITS.pct, cmap: "cloud", range: [0, 100], needs: ["CLDFRA", "P", "PB"], compute: (f) => cloudCover(f, 0, 2000) });
add({ id: "cc_low", label: "Cloud cover, low (>680 hPa)", group: "Precipitation, clouds, radar", units: UNITS.pct, cmap: "cloud", range: [0, 100], needs: ["CLDFRA", "P", "PB"], compute: (f) => cloudCover(f, 680, 2000) });
add({ id: "cc_mid", label: "Cloud cover, mid (440–680 hPa)", group: "Precipitation, clouds, radar", units: UNITS.pct, cmap: "cloud", range: [0, 100], needs: ["CLDFRA", "P", "PB"], compute: (f) => cloudCover(f, 440, 680) });
add({ id: "cc_high", label: "Cloud cover, high (<440 hPa)", group: "Precipitation, clouds, radar", units: UNITS.pct, cmap: "cloud", range: [0, 100], needs: ["CLDFRA", "P", "PB"], compute: (f) => cloudCover(f, 0, 440) });
add({ id: "pw", label: "Precipitable water", group: "Precipitation, clouds, radar", units: UNITS.mm, cmap: "viridis", needs: ["QVAPOR", "MU", "MUB", "DNW"], compute: (f) => {
  const q = f.qv3, n2 = f.n2, out = new Float32Array(n2);
  const mu = f.get("MU"), mub = f.get("MUB"), dn = f.get("DNW"); // dn: eta thickness (negative)
  for (let k = 0; k < f.nz; k++) for (let a = 0; a < n2; a++) out[a] += (q[k * n2 + a] * (mu[a] + mub[a]) * -dn[k]) / G;
  return out;
} });
add({ id: "cwp", label: "Cloud water + ice path", group: "Precipitation, clouds, radar", units: UNITS.none("mm"), cmap: "cloud", transparentBelow: 0.01, needs: ["QCLOUD", "MU", "MUB", "DNW"], compute: (f) => {
  const names = ["QCLOUD", "QICE", "QSNOW"].filter((n) => f.has(n)), n2 = f.n2, out = new Float32Array(n2);
  const mu = f.get("MU"), mub = f.get("MUB"), dn = f.get("DNW");
  for (const nme of names) { const q = f.get(nme); for (let k = 0; k < f.nz; k++) for (let a = 0; a < n2; a++) out[a] += (q[k * n2 + a] * (mu[a] + mub[a]) * -dn[k]) / G; }
  return out;
} });

// ---- radiation & fluxes
const raw2d = (id, label, units, cmap, extra = {}) => add({ id, label, group: "Radiation, fluxes, soil", units, cmap, needs: [id.toUpperCase()], compute: (f) => f.get(id.toUpperCase()), ...extra });
raw2d("swdown", "Downward shortwave at ground", UNITS.none("W/m²"), "viridis");
raw2d("glw", "Downward longwave at ground", UNITS.none("W/m²"), "viridis");
raw2d("olr", "Outgoing longwave radiation", UNITS.none("W/m²"), "viridis");
raw2d("hfx", "Sensible heat flux", UNITS.none("W/m²"), "div");
raw2d("lh", "Latent heat flux", UNITS.none("W/m²"), "div");
raw2d("ust", "Friction velocity", UNITS.none("m/s"), "viridis");
add({ id: "tslb1", label: "Soil temperature, top layer", group: "Radiation, fluxes, soil", units: UNITS.tempK, cmap: "temp", needs: ["TSLB"], compute: (f) => f.get("TSLB").slice(0, f.n2) });
add({ id: "smois1", label: "Soil moisture, top layer", group: "Radiation, fluxes, soil", units: UNITS.none("m³/m³"), cmap: "rh", needs: ["SMOIS"], compute: (f) => f.get("SMOIS").slice(0, f.n2) });

// ---- pressure-level fields
const lv = (id, label, units, cmap, needs, field, extra = {}) => add({ id, label, group: "Upper air (choose a level)", level: true, units, cmap, needs, compute: (f, c) => atPressure(f, field(f), c.level), ...extra });
lv("t_p", "Temperature", UNITS.tempK, "temp", ["T", "P", "PB"], (f) => f.tk3);
lv("rh_p", "Relative humidity", UNITS.pct, "rh", ["QVAPOR", "T", "P", "PB"], (f) => f.rh3, { range: [0, 100] });
lv("wspd_p", "Wind speed", UNITS.speed, "wind", ["U", "V", "P", "PB"], (f) => { const u = f.u3, v = f.v3; return u.map((x, i) => Math.hypot(x, v[i])); }, {
  vectors: (f, c) => ({ u: atPressure(f, f.u3, c.level), v: atPressure(f, f.v3, c.level) }) });
lv("z_p", "Geopotential height", UNITS.gpm, "viridis", ["PH", "PHB", "P", "PB"], (f) => f.z3);
lv("w_p", "Vertical velocity", UNITS.none("m/s"), "div", ["W", "P", "PB"], (f) => f.w3, { symmetric: true });
lv("theta_p", "Potential temperature", UNITS.none("K"), "temp", ["T", "P", "PB"], (f) => f.get("T").map((v) => v + 300));
lv("qv_p", "Water-vapor mixing ratio", UNITS.none("g/kg"), "rh", ["QVAPOR", "P", "PB"], (f) => f.qv3.map((v) => v * 1000));
add({ id: "vort_p", label: "Relative vorticity", group: "Upper air (choose a level)", level: true, units: UNITS.none("10⁻⁵ s⁻¹"), cmap: "div", symmetric: true, needs: ["U", "V", "P", "PB"], compute: (f, c) => {
  const u = atPressure(f, f.u3, c.level), v = atPressure(f, f.v3, c.level), { nx, ny } = f, d = f.dx, mf = f.has("MAPFAC_M") ? f.get("MAPFAC_M") : null;
  const out = new Float32Array(f.n2).fill(NaN);
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const a = j * nx + i, dv = v[a + 1] - v[a - 1], du = u[a + nx] - u[a - nx];
    out[a] = ((dv - du) / (2 * d)) * (mf ? mf[a] : 1) * 1e5;
  }
  return out;
} });

export const SKIP_RAW = new Set(["XLAT", "XLONG", "XLAT_U", "XLONG_U", "XLAT_V", "XLONG_V", "MAPFAC_M", "MAPFAC_U", "MAPFAC_V", "MAPFAC_MX", "MAPFAC_MY", "MAPFAC_UX", "MAPFAC_UY", "MAPFAC_VX", "MAPFAC_VY", "SINALPHA", "COSALPHA", "E", "F", "LU_INDEX", "ZNU", "ZNW", "DNW", "DN", "RDNW", "RDN", "FNM", "FNP", "CFN", "CFN1", "RDX", "RDY", "MUB", "MUT", "MU", "P_TOP", "P_HYD", "Times", "ISLTYP", "IVGTYP", "SEAICE", "XICEM", "ZS", "DZS", "SH2O"]);

export function availableFields(frame) {
  const have = (f) => f.needs.every((n) => frame.has(n));
  const list = F.filter(have);
  // Any other 2-D or 3-D mass-grid variable in the file is exposed generically so nothing the model wrote is hidden.
  const known = new Set(F.flatMap((f) => f.needs));
  for (const [name, v] of Object.entries(frame.nc.vars)) {
    if (known.has(name) || SKIP_RAW.has(name) || v.type === 2) continue;
    const dims = v.dims.join(",");
    const desc = v.attrs.description || name, unit = v.attrs.units || "";
    if (dims === "Time,south_north,west_east") {
      list.push({ id: "raw:" + name, label: `${desc} [${name}]`, group: "Other model output (raw)", units: UNITS.none(unit), cmap: "viridis", needs: [name], compute: (f) => f.get(name) });
    } else if (dims === "Time,bottom_top,south_north,west_east" && frame.has("P")) {
      list.push({ id: "raw3:" + name, label: `${desc} [${name}]`, group: "Other model output (raw)", level: true, units: UNITS.none(unit), cmap: "viridis", needs: [name], compute: (f, c) => atPressure(f, f.get(name), c.level) });
    }
  }
  return list;
}

// Compute (and memoise) a field for one frame.
export function computeField(frame, field, level, prev) {
  const key = `fld:${field.id}:${level || ""}`;
  return frame.memo(key, () => field.compute(frame, { level, prev }));
}
export function computeVectors(frame, field, level) {
  return field.vectors ? field.vectors(frame, { level }) : null;
}

// Range over a whole run, robust to a few extreme cells.
export function autoRange(arrays) {
  const vals = [];
  for (const a of arrays) for (let i = 0; i < a.length; i += 3) if (Number.isFinite(a[i])) vals.push(a[i]);
  if (!vals.length) return [0, 1];
  vals.sort((x, y) => x - y);
  let lo = vals[Math.floor(vals.length * 0.01)], hi = vals[Math.floor(vals.length * 0.99)];
  if (hi - lo < 1e-6) { hi = lo + 1; }
  const step = Math.pow(10, Math.floor(Math.log10(hi - lo))) / 2;
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}
