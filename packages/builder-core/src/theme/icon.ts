// A solid-colour square PNG, used as a store's DEFAULT maskable PWA icon (tinted with its brand colour)
// so a fresh store is installable without the merchant uploading anything. Pure + dependency-free
// (node:zlib only) — no committed binary assets, and the current text-only theme codegen never sees it.
// A merchant-uploaded icon set supersedes this later (OFCE-727).
import { deflateSync } from 'node:zlib';

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A PNG chunk: length + type + data + CRC(type+data).
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

// Encode a `size`×`size` solid-colour RGBA PNG. Invalid colour → black.
export function solidIconPng(hex: string, size: number): Uint8Array {
  const [r, g, b] = HEX.test(hex) ? hexToRgb(hex) : [0, 0, 0];
  const rowLen = 1 + size * 4; // 1 filter byte + RGBA per pixel
  const raw = new Uint8Array(rowLen * size);
  for (let y = 0; y < size; y++) {
    const o = y * rowLen;
    raw[o] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = o + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // bytes 10..12 stay 0: compression / filter / interlace
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// The two default icon paths the synthesized manifest points at (served by the origin, tinted per store).
export const ICON_SIZES = [192, 512] as const;
export const iconPath = (size: number) => `/icon-${size}.png`;
