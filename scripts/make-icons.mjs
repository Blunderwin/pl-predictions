#!/usr/bin/env node
/**
 * Generate the home-screen icons.
 *
 * There's no image library here, so this writes PNGs directly: a
 * single IDAT of unfiltered RGBA scanlines, deflated with node's zlib.
 * Kept in the repo rather than committing three opaque binaries with
 * no source — change the colours below and re-run.
 *
 * The mark is three bars in the app's own H / D / A colours, which is
 * what the pick buttons and the calling-style chart already use.
 *
 * Usage: node scripts/make-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const INK   = [0x0b, 0x0d, 0x10];
const BARS  = [[0x4c, 0x9e, 0x69],    // H, green
               [0xd9, 0xa5, 0x36],    // D, amber
               [0x5b, 0x8c, 0xb8]];   // A, blue
const HEIGHTS = [0.62, 0.86, 0.46];   // uneven, so it reads as a scoreboard not a logo

const crcTable = (() => {
  const t = new Int32Array(256);
  for(let n = 0; n < 256; n++){
    let c = n;
    for(let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf){
  let c = -1;
  for(const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba){
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // truecolour with alpha
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for(let y = 0; y < height; y++){
    raw[y * (width * 4 + 1)] = 0;                                  // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function draw(size, { padded = false } = {}){
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b]) => {
    if(x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i+1] = g; px[i+2] = b; px[i+3] = 255;
  };
  for(let y = 0; y < size; y++) for(let x = 0; x < size; x++) set(x, y, INK);

  // iOS puts no rounding of its own on an apple-touch-icon and crops
  // maskable icons hard, so the artwork sits well inside the square.
  const inset  = Math.round(size * (padded ? 0.26 : 0.20));
  const usable = size - inset * 2;
  const gap    = Math.round(usable * 0.10);
  const barW   = Math.round((usable - gap * 2) / 3);
  const baseY  = size - inset;

  BARS.forEach((colour, i) => {
    const x0 = inset + i * (barW + gap);
    const h  = Math.round(usable * HEIGHTS[i]);
    for(let y = baseY - h; y < baseY; y++)
      for(let x = x0; x < x0 + barW; x++) set(x, y, colour);
  });
  return png(size, size, px);
}

for(const [file, size, opts] of [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["icon-maskable-512.png", 512, { padded: true }],
  ["apple-touch-icon.png", 180, {}]
]){
  writeFileSync(file, draw(size, opts));
  console.log(`${file}  ${size}x${size}`);
}
