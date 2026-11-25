// Minimal reader for netCDF classic files (CDF-1 and CDF-2 / 64-bit offset), which is what WRF writes
// with io_form_*=2. Everything is big-endian. No dependencies.

const TYPES = {
  1: { name: "byte", size: 1 },
  2: { name: "char", size: 1 },
  3: { name: "short", size: 2 },
  4: { name: "int", size: 4 },
  5: { name: "float", size: 4 },
  6: { name: "double", size: 8 },
};

const pad4 = (n) => (n + 3) & ~3;

export function parseNetCDF(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const text = new TextDecoder("utf-8");
  if (u8[0] !== 0x43 || u8[1] !== 0x44 || u8[2] !== 0x46) throw new Error("not a netCDF classic file");
  const version = u8[3];
  if (version !== 1 && version !== 2) {
    throw new Error(`netCDF version ${version} is not supported (WRF should be writing classic, io_form=2)`);
  }
  let p = 4;
  const u32 = () => { const v = dv.getUint32(p); p += 4; return v; };
  const u64 = () => { const hi = dv.getUint32(p), lo = dv.getUint32(p + 4); p += 8; return hi * 4294967296 + lo; };
  const name = () => { const n = u32(); const s = text.decode(u8.subarray(p, p + n)); p += pad4(n); return s; };

  const numrecs = u32();

  // ---- dimensions
  const dims = {};
  const dimList = [];
  let tag = u32(), n = u32();
  if (tag === 0x0a) {
    for (let i = 0; i < n; i++) {
      const dn = name(), len = u32();
      dimList.push({ name: dn, length: len, unlimited: len === 0 });
      dims[dn] = len === 0 ? numrecs : len;
    }
  }

  const readAttrs = () => {
    const out = {};
    const t = u32(), cnt = u32();
    if (t !== 0x0c) return out;
    for (let i = 0; i < cnt; i++) {
      const an = name(), type = u32(), nel = u32();
      const sz = TYPES[type].size;
      let value;
      if (type === 2) {
        value = text.decode(u8.subarray(p, p + nel)).replace(/\0+$/, "");
      } else {
        value = [];
        for (let k = 0; k < nel; k++) value.push(readScalar(dv, p + k * sz, type));
        if (nel === 1) value = value[0];
      }
      p += pad4(nel * sz);
      out[an] = value;
    }
    return out;
  };

  const attrs = readAttrs();

  // ---- variables
  const vars = {};
  tag = u32(); n = u32();
  if (tag === 0x0b) {
    for (let i = 0; i < n; i++) {
      const vn = name(), nd = u32();
      const dimids = [];
      for (let k = 0; k < nd; k++) dimids.push(u32());
      const vattrs = readAttrs();
      const type = u32(), vsize = u32();
      const begin = version === 2 ? u64() : u32();
      const vdims = dimids.map((d) => dimList[d].name);
      vars[vn] = {
        name: vn, dims: vdims, type, vsize, begin, attrs: vattrs,
        isRecord: nd > 0 && dimList[dimids[0]].unlimited,
        shape: dimids.map((d) => (dimList[d].unlimited ? numrecs : dimList[d].length)),
      };
    }
  }
  let recsize = 0;
  for (const v of Object.values(vars)) if (v.isRecord) recsize += v.vsize;

  function read(vn, rec = 0) {
    const v = vars[vn];
    if (!v) throw new Error(`no variable ${vn}`);
    const inner = v.isRecord ? v.shape.slice(1) : v.shape;
    const count = inner.reduce((a, b) => a * b, 1);
    const start = v.isRecord ? v.begin + rec * recsize : v.begin;
    const T = TYPES[v.type];
    if (v.type === 2) return text.decode(u8.subarray(start, start + count)).replace(/\0+$/, "");
    const out = v.type === 4 ? new Int32Array(count)
      : v.type === 3 ? new Int16Array(count)
      : v.type === 1 ? new Int8Array(count)
      : v.type === 6 ? new Float64Array(count)
      : new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = readScalar(dv, start + i * T.size, v.type);
    return out;
  }

  return { version, numrecs, dims, attrs, vars, read, has: (v) => v in vars };
}

function readScalar(dv, off, type) {
  switch (type) {
    case 1: return dv.getInt8(off);
    case 2: return dv.getUint8(off);
    case 3: return dv.getInt16(off);
    case 4: return dv.getInt32(off);
    case 5: return dv.getFloat32(off);
    case 6: return dv.getFloat64(off);
    default: throw new Error("bad netCDF type " + type);
  }
}
