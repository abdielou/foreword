// Generates icons/icon{16,48,128}.png: a rounded navy square with a lens ring.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Anti-aliased helpers
const clamp = (v) => Math.max(0, Math.min(1, v));
function roundedRectAlpha(x, y, size, radius) {
  const px = Math.max(Math.abs(x - size / 2) - (size / 2 - radius), 0);
  const py = Math.max(Math.abs(y - size / 2) - (size / 2 - radius), 0);
  const d = Math.hypot(px, py) - radius;
  return clamp(0.5 - d);
}
function ringAlpha(x, y, cx, cy, r, w) {
  const d = Math.abs(Math.hypot(x - cx, y - cy) - r) - w / 2;
  return clamp(0.5 - d);
}
function segAlpha(x, y, x1, y1, x2, y2, w) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = clamp(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy));
  const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) - w / 2;
  return clamp(0.5 - d);
}
function discAlpha(x, y, cx, cy, r) {
  return clamp(0.5 - (Math.hypot(x - cx, y - cy) - r));
}

function make(size) {
  const s = size;
  return png(size, (x, y) => {
    const bgA = roundedRectAlpha(x, y, s, s * 0.22);
    // magnifier: ring + handle; a small "person" dot inside the lens
    const cx = s * 0.44, cy = s * 0.44, r = s * 0.24, w = Math.max(1, s * 0.075);
    const ring = ringAlpha(x, y, cx, cy, r, w);
    const handle = segAlpha(x, y, cx + r * 0.72, cy + r * 0.72, s * 0.8, s * 0.8, w * 1.15);
    const head = discAlpha(x, y, cx, cy - r * 0.22, r * 0.22);
    const body = clamp(discAlpha(x, y, cx, cy + r * 0.45, r * 0.42) - clamp((cy + r * 0.05 - y) * 2));
    const fg = clamp(ring + handle + head + body);
    const bg = [31, 42, 55];
    const light = [124, 196, 255];
    const rgb = bg.map((c, i) => Math.round(c + (light[i] - c) * fg));
    return [rgb[0], rgb[1], rgb[2], Math.round(255 * bgA)];
  });
}

mkdirSync("icons", { recursive: true });
for (const size of [16, 48, 128]) writeFileSync(`icons/icon${size}.png`, make(size));
console.log("icons written");
