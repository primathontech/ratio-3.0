// EdgeKV item-key encoding. EdgeKV item IDs permit ONLY [0-9a-zA-Z_-] (Akamai limit; max 512
// chars) — our logical keys ("host:acme.example") don't fit, and URL-encoding doesn't help
// because '%' itself is disallowed. Encode as base64url (no padding): its output alphabet is
// exactly a subset of the allowed set, it's injective (no collision risk a sanitizer would have),
// and a 253-char hostname encodes to ~340 chars, inside the 512 limit.
//
// Pure JS, zero imports — the SAME function is bundled into the EdgeWorker, so the control
// plane's writes and the worker's runtime reads can never disagree on the item name.

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function edgeKvItemKey(logical: string): string {
  // UTF-8 encode by hand (no Buffer — must run in the EdgeWorker)
  const bytes: number[] = [];
  for (const ch of logical) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += B64URL[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += B64URL[b2 & 63];
  }
  return out;
}
