// Colour maps and canvas rendering of one field onto a georeferenced image.

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const ramp = (list) => list.map(hex);

export const CMAPS = {
  temp: ramp(["#5b2a86", "#3b4cc0", "#3a9ad9", "#4fd1c5", "#9be564", "#f4e04d", "#f59e3b", "#e0412f", "#8c1d2f"]),
  viridis: ramp(["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"]),
  wind: ramp(["#eaf4ff", "#9ecae1", "#41b6c4", "#6bbf59", "#e6d33a", "#f28e2b", "#d7301f", "#7f0c4d"]),
  precip: ramp(["#cdeccb", "#7ccf8a", "#2fb5a0", "#2b8cbe", "#3a4fb5", "#6a3d9a", "#b8329d", "#e8466c"]),
  snow: ramp(["#dbe9ff", "#9cc3f5", "#5b8fe0", "#3a5bc4", "#6c3fb0", "#a22d9e"]),
  radar: ramp(["#04e9e7", "#019ff4", "#0300f4", "#02fd02", "#01c501", "#008e00", "#fdf802", "#e5bc00", "#fd9500", "#fd0000", "#d40000", "#bc0000", "#f800fd", "#9854c6", "#ffffff"]),
  rh: ramp(["#8c510a", "#d8b365", "#f6e8c3", "#c7eae5", "#5ab4ac", "#01665e"]),
  div: ramp(["#2166ac", "#67a9cf", "#d1e5f0", "#f7f7f7", "#fddbc7", "#ef8a62", "#b2182b"]),
  terrain: ramp(["#2e7d4f", "#8fbf6a", "#e9e29a", "#c49a5a", "#8a6a4d", "#f2f2f2"]),
  cloud: ramp(["#ffffff", "#c9ced6", "#8d96a3", "#4b5563"]), // alpha ramps with value, see colorAt()
};

export function colorAt(cmap, t) {
  const stops = CMAPS[cmap];
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function cmapCss(cmap) {
  const stops = CMAPS[cmap];
  return "linear-gradient(90deg," + stops.map((c, i) => `rgb(${c}) ${(100 * i) / (stops.length - 1)}%`).join(",") + ")";
}

// Geometry of the grid in lon/lat. WRF's Mercator grid is regular in lon and in Mercator-y.
const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unmerc = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * (180 / Math.PI);

export function gridGeometry(frame) {
  const { nx, ny } = frame, lats = frame.lats, lons = frame.lons;
  const lon0 = lons[0], lon1 = lons[nx - 1];
  const my0 = merc(lats[0]), my1 = merc(lats[(ny - 1) * nx]);
  const dlon = (lon1 - lon0) / (nx - 1), dmy = (my1 - my0) / (ny - 1);
  return {
    nx, ny, lon0, dlon, my0, dmy,
    bounds: { west: lon0 - dlon / 2, east: lon1 + dlon / 2, south: unmerc(my0 - dmy / 2), north: unmerc(my1 + dmy / 2) },
    // lon/lat -> fractional grid index
    locate(lon, lat) { return { i: (lon - lon0) / dlon, j: (merc(lat) - my0) / dmy }; },
    // grid index -> lon/lat
    lonlat(i, j) { return { lon: lon0 + i * dlon, lat: unmerc(my0 + j * dmy) }; },
  };
}

export function sample(grid, nx, ny, fi, fj) {
  const i0 = Math.max(0, Math.min(nx - 1, Math.floor(fi))), j0 = Math.max(0, Math.min(ny - 1, Math.floor(fj)));
  const i1 = Math.min(nx - 1, i0 + 1), j1 = Math.min(ny - 1, j0 + 1);
  const ax = Math.max(0, Math.min(1, fi - i0)), ay = Math.max(0, Math.min(1, fj - j0));
  const a = grid[j0 * nx + i0], b = grid[j0 * nx + i1], c = grid[j1 * nx + i0], d = grid[j1 * nx + i1];
  if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))) {
    const near = grid[Math.round(Math.max(0, Math.min(ny - 1, fj))) * nx + Math.round(Math.max(0, Math.min(nx - 1, fi)))];
    return near; // fall back to nearest at NaN edges (underground pressure levels)
  }
  return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
}

// Paint a field. `data` is in base units; `conv` maps to display units; `range` is in base units.
export function paintField(canvas, data, nx, ny, { cmap, range, transparentBelow, scale = 12 }) {
  const W = nx * scale, H = ny * scale;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  const [lo, hi] = range, span = hi - lo || 1;
  const isCloud = cmap === "cloud";
  for (let py = 0; py < H; py++) {
    const fj = (H - 1 - py + 0.5) / scale - 0.5; // image row 0 is the north edge
    for (let px = 0; px < W; px++) {
      const fi = (px + 0.5) / scale - 0.5;
      const v = sample(data, nx, ny, fi, fj);
      const o = (py * W + px) * 4;
      if (!Number.isFinite(v) || (transparentBelow !== undefined && v < transparentBelow)) { img.data[o + 3] = 0; continue; }
      const t = (v - lo) / span;
      const c = colorAt(cmap, t);
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
      img.data[o + 3] = isCloud ? Math.round(255 * Math.min(0.85, Math.max(0, t) * 0.9)) : 235;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Wind arrows on their own transparent canvas, same pixel grid as the field canvas.
export function paintVectors(canvas, u, v, nx, ny, { scale = 12, every = 2 }) {
  const W = nx * scale, H = ny * scale;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = "round";
  const len = scale * every * 0.9;
  for (let j = Math.floor(every / 2); j < ny; j += every) for (let i = Math.floor(every / 2); i < nx; i += every) {
    const uu = u[j * nx + i], vv = v[j * nx + i];
    if (!Number.isFinite(uu) || !Number.isFinite(vv)) continue;
    const sp = Math.hypot(uu, vv);
    if (sp < 0.3) continue;
    const cx = (i + 0.5) * scale, cy = H - (j + 0.5) * scale;
    const dx = (uu / sp) * len * Math.min(1, 0.35 + sp / 25), dy = -(vv / sp) * len * Math.min(1, 0.35 + sp / 25);
    const x0 = cx - dx / 2, y0 = cy - dy / 2, x1 = cx + dx / 2, y1 = cy + dy / 2;
    const ang = Math.atan2(dy, dx), h = scale * 0.45;
    for (const [w, col] of [[3.2, "rgba(255,255,255,.85)"], [1.5, "rgba(15,20,30,.95)"]]) {
      ctx.strokeStyle = col; ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.moveTo(x1, y1); ctx.lineTo(x1 - h * Math.cos(ang - 0.5), y1 - h * Math.sin(ang - 0.5));
      ctx.moveTo(x1, y1); ctx.lineTo(x1 - h * Math.cos(ang + 0.5), y1 - h * Math.sin(ang + 0.5));
      ctx.stroke();
    }
  }
}
