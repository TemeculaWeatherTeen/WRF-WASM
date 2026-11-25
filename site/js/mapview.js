// Map abstraction: Leaflet when it loaded from the CDN, otherwise a plain canvas with a lon/lat graticule.
// Both draw two georeferenced images (field colours, wind arrows) and report the pointer position.

const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const CITIES = [
  ["San Luis Obispo", 35.28, -120.66], ["Santa Barbara", 34.42, -119.70], ["Los Angeles", 34.05, -118.24],
  ["San Diego", 32.72, -117.16], ["Palm Springs", 33.83, -116.55], ["El Centro", 32.79, -115.56],
  ["Yuma", 32.69, -114.63], ["Bakersfield", 35.37, -119.02],
];

export function createMap(el, bounds) {
  return window.L ? new LeafletMap(el, bounds) : new FallbackMap(el, bounds);
}

class LeafletMap {
  constructor(el, b) {
    const L = window.L;
    this.L = L;
    this.kind = "leaflet";
    this.map = L.map(el, { zoomControl: false, zoomSnap: 0.25, minZoom: 5, maxZoom: 11 });
    L.control.zoom({ position: "topright" }).addTo(this.map);
    this.bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
    this.map.fitBounds(this.bounds, { paddingBottomRight: [0, 30] });
    const attr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · WRF output computed in your browser';
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png", { attribution: attr, subdomains: "abcd", maxZoom: 19 }).addTo(this.map);
    this.map.createPane("field"); this.map.getPane("field").style.zIndex = 300;
    this.map.createPane("arrows"); this.map.getPane("arrows").style.zIndex = 320;
    this.map.createPane("labels"); this.map.getPane("labels").style.zIndex = 450; this.map.getPane("labels").classList.add("leaflet-labels-pane");
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png", { subdomains: "abcd", pane: "labels", maxZoom: 19 }).addTo(this.map);
    L.rectangle(this.bounds, { color: "#1f6feb", weight: 1, fill: false, dashArray: "4 4", interactive: false }).addTo(this.map);
    this.layers = {};
    this.opacity = 0.8;
  }
  setImage(which, url) {
    const L = this.L;
    if (!this.layers[which]) {
      this.layers[which] = L.imageOverlay(url, this.bounds, { pane: which === "field" ? "field" : "arrows", opacity: which === "field" ? this.opacity : 1, interactive: false }).addTo(this.map);
    } else this.layers[which].setUrl(url);
  }
  setOpacity(o) { this.opacity = o; this.layers.field?.setOpacity(o); }
  onMove(cb) {
    this.map.on("mousemove", (e) => cb(e.latlng.lat, e.latlng.lng));
    this.map.on("mouseout", () => cb(null, null));
  }
}

class FallbackMap {
  constructor(el, b) {
    this.kind = "fallback";
    this.b = b;
    el.classList.add("fallbackMap");
    this.canvas = document.createElement("canvas");
    el.appendChild(this.canvas);
    this.imgs = {}; this.opacity = 0.8; this.cb = () => {};
    new ResizeObserver(() => this.draw()).observe(el);
    this.canvas.addEventListener("mousemove", (e) => { const p = this.unproject(e.offsetX, e.offsetY); this.cb(p.lat, p.lng); });
    this.canvas.addEventListener("mouseleave", () => this.cb(null, null));
  }
  layout() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, b = this.b;
    const x0 = b.west, x1 = b.east, y0 = merc(b.south), y1 = merc(b.north);
    const k = Math.min((w - 40) / (x1 - x0), (h - 40) / ((y1 - y0) * (180 / Math.PI)));
    const ky = k * (180 / Math.PI);
    return { w, h, k, ky, ox: (w - (x1 - x0) * k) / 2, oy: (h - (y1 - y0) * ky) / 2, x0, y1 };
  }
  project(lng, lat) { const g = this.layout(); return [g.ox + (lng - g.x0) * g.k, g.oy + (g.y1 - merc(lat)) * g.ky]; }
  unproject(px, py) {
    const g = this.layout(), m = g.y1 - (py - g.oy) / g.ky;
    return { lng: g.x0 + (px - g.ox) / g.k, lat: (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * (180 / Math.PI) };
  }
  setImage(which, url) {
    const im = new Image();
    im.onload = () => { this.imgs[which] = im; this.draw(); };
    im.src = url;
  }
  setOpacity(o) { this.opacity = o; this.draw(); }
  onMove(cb) { this.cb = cb; }
  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
    const ctx = c.getContext("2d"); ctx.scale(dpr, dpr);
    const b = this.b, [x0, y0] = this.project(b.west, b.north), [x1, y1] = this.project(b.east, b.south);
    ctx.fillStyle = "#e8eef3"; ctx.fillRect(0, 0, c.clientWidth, c.clientHeight);
    ctx.strokeStyle = "rgba(60,80,100,.25)"; ctx.fillStyle = "rgba(60,80,100,.7)"; ctx.font = "11px system-ui"; ctx.lineWidth = 1;
    for (let lon = Math.ceil(b.west); lon <= b.east; lon++) { const [x] = this.project(lon, b.south); ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); ctx.fillText(`${Math.abs(lon)}°W`, x + 2, y1 - 3); }
    for (let lat = Math.ceil(b.south); lat <= b.north; lat++) { const [, y] = this.project(b.west, lat); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.fillText(`${lat}°N`, x0 + 3, y - 2); }
    if (this.imgs.field) { ctx.globalAlpha = this.opacity; ctx.drawImage(this.imgs.field, x0, y0, x1 - x0, y1 - y0); ctx.globalAlpha = 1; }
    if (this.imgs.arrows) ctx.drawImage(this.imgs.arrows, x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = "#1f6feb"; ctx.setLineDash([4, 4]); ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
    ctx.fillStyle = "#16202b";
    for (const [n, la, lo] of CITIES) { const [x, y] = this.project(lo, la); ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill(); ctx.fillText(n, x + 5, y - 4); }
  }
}
