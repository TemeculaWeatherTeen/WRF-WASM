// Checks the netCDF reader and every derived field against independently computed (numpy) expectations.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Frame, availableFields, computeField, computeVectors, autoRange } from "../site/js/derive.js";
import { gridGeometry, paintField, paintVectors } from "../site/js/render.js";

const dir = new URL("./fixtures/", import.meta.url).pathname;
const exp = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8"));
const files = fs.readdirSync(dir).filter((f) => f.startsWith("wrfout")).sort();
assert.equal(files.length, exp.frames);
const frames = files.map((f) => new Frame(new Uint8Array(fs.readFileSync(path.join(dir, f)))));

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };
const near = (a, b, tol, msg) => { assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} (tol ${tol})`); pass++; };

const f0 = frames[0], f3 = frames[3];
const at = ([i, j], nx = exp.nx) => j * nx + i;
const pt = (name) => exp.pts[name];
const fld = (id, frame = f0, level, prev) => computeField(frame, availableFields(frame).find((f) => f.id === id), level, prev);

// ---- reader
ok(frames[0].nc.version === 1 && frames[1].nc.version === 2, "both CDF-1 and CDF-2 parse");
ok(f0.nx === exp.nx && f0.ny === exp.ny && f0.nz === exp.nz, "dimensions");
ok(f0.timeStr === "2026-11-24_18:00:00" && f3.time.toISOString() === "2026-11-24T21:00:00.000Z", "Times parsed");
near(f0.dx, exp.dx, 0, "global attribute DX");

// ---- pressure-level interpolation
near(fld("t_p", f0, 850)[at(pt("ocean"))], exp.t850.ocean, 0.05, "T850 ocean");
near(fld("t_p", f0, 850)[at(pt("mid"))], exp.t850.mid, 0.05, "T850 mid");
ok(Number.isNaN(fld("t_p", f0, 850)[at(pt("mountain"))]) === exp.t850.mountain_is_nan, "T850 underground over the 1800 m mountain is NaN");
near(fld("wspd_p", f0, 500)[at(pt("ocean"))], exp.ws500.ocean, 0.05, "wind speed 500 hPa ocean");
near(fld("wspd_p", f0, 500)[at(pt("mid"))], exp.ws500.mid, 0.05, "wind speed 500 hPa mid");
near(fld("z_p", f0, 500)[at(pt("ocean"))], exp.z500.ocean, 0.5, "height 500 hPa (value is in m before display conversion)");

// ---- thermodynamics
near(fld("rh2")[at(pt("mid"))], exp.rh2, 3, "2 m RH (T2 is 0.5 K off the lowest level by design)");
near(fld("rh_p", f0, 850)[at(pt("ocean"))], exp.rh850_ocean, 1, "RH at 850 hPa");
near(fld("pw")[at(pt("ocean"))], exp.pw.ocean, exp.pw.ocean * 0.01, "precipitable water, sea level");
near(fld("pw")[at(pt("mountain"))], exp.pw.mountain, exp.pw.mountain * 0.01, "precipitable water, mountain");

// ---- dynamics
const vort = fld("vort_p", f0, 500);
near(vort[at(pt("mid"))], exp.vort500_mid, 0.2, "relative vorticity (1e-5 s-1)");
ok(Number.isNaN(vort[0]), "vorticity undefined on the boundary row");
const vec = computeVectors(f0, availableFields(f0).find((f) => f.id === "wspd_p"), 500);
ok(vec && vec.u.length === f0.n2 && Number.isFinite(vec.u[at(pt("mid"))]), "wind vectors at a level");

// ---- precipitation, accumulation difference, radar, clouds
const pcpTotal = fld("pcp_total", f3);
near(Math.max(...pcpTotal), exp.pcp_total_f3_peak, 0.05, "total precip peak");
near(Math.max(...fld("pcp_1h", f3, undefined, frames[2])), exp.pcp_1h_f3_peak, 0.05, "hourly precip peak = difference of accumulations");
ok(fld("pcp_1h", f0).every((v) => v === 0), "no previous frame gives zero hourly precip");
near(Math.max(...fld("refl_comp", f3)), exp.refl_comp_peak_f3, 0.05, "composite reflectivity takes the column maximum");
near(fld("cc_mid")[at(pt("ocean"))], exp.cc_mid, 0.5, "mid cloud cover");
near(fld("cc_low")[at(pt("ocean"))], exp.cc_low_surface_layer, 0.5, "low cloud cover");

// ---- field catalogue
const ids = availableFields(f0).map((f) => f.id);
for (const must of ["t2", "td2", "rh2", "feels", "wspd10", "slp", "hgt", "pw", "frzlvl", "pcp_total", "refl_comp", "cc_total", "t_p", "wspd_p", "vort_p", "swdown", "tslb1"])
  ok(ids.includes(must), `field ${must} offered`);
ok(ids.includes("raw:QFX"), "variables without a dedicated entry are still exposed (QFX)");
ok(!ids.includes("snowh") && !ids.includes("snow_total") === false, "fields needing missing variables are hidden (SNOWH) while SNOWNC is offered");
for (const f of availableFields(f0)) {
  const a = computeField(f0, f, f.level ? 700 : undefined, undefined);
  assert.equal(a.length, f0.n2, f.id); pass++;
  if (!f.level) assert.ok(a.some(Number.isFinite), `${f.id} has finite values`);
}

// ---- unit conversions
const tf = availableFields(f0).find((f) => f.id === "t2");
near(tf.units.us.f(273.15), 32, 1e-9, "K->°F"); near(tf.units.si.f(300), 26.85, 1e-9, "K->°C");

// ---- geometry
const g = gridGeometry(f0);
near(g.bounds.west, exp.lon_first - (exp.lon_last - exp.lon_first) / (exp.nx - 1) / 2, 1e-4, "bounds west");
const back = g.locate(g.lonlat(17, 9).lon, g.lonlat(17, 9).lat);
near(back.i, 17, 1e-6, "lon/lat -> i roundtrip"); near(back.j, 9, 1e-6, "lon/lat -> j roundtrip");
ok(g.bounds.north > g.bounds.south && g.bounds.east > g.bounds.west, "bounds ordered");

// ---- ranges + a smoke render with a fake canvas
const r = autoRange(frames.map((f) => fld("t2", f)));
ok(r[1] > r[0], "autoRange returns a span");
const fake = () => { let img; return { width: 0, height: 0, getContext() { return { createImageData: (w, h) => (img = { data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, set strokeStyle(_) {}, set lineWidth(_) {}, set lineCap(_) {} }; }, get img() { return img; } }; };
const c = fake();
paintField(c, fld("t2"), f0.nx, f0.ny, { cmap: "temp", range: r, scale: 4 });
let opaque = 0; for (let i = 3; i < c.img.data.length; i += 4) if (c.img.data[i] > 0) opaque++;
ok(opaque === f0.nx * 4 * f0.ny * 4, "every pixel of a complete field is painted");
const c2 = fake();
paintField(c2, fld("t_p", f0, 850), f0.nx, f0.ny, { cmap: "temp", range: [250, 300], scale: 4 });
ok(c2.width === f0.nx * 4, "canvas sized to grid*scale");
paintVectors(fake(), vec.u, vec.v, f0.nx, f0.ny, { scale: 4, every: 2 });

console.log(`all ${pass} checks passed`);
