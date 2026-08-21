import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solidIconPng } from '../theme/icon';

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('solidIconPng emits a valid PNG with the requested dimensions', () => {
  const png = solidIconPng('#2563eb', 192);
  const buf = Buffer.from(png);
  assert.ok(buf.subarray(0, 8).equals(PNG_SIG), 'PNG signature');
  // IHDR is the first chunk: bytes 16..24 hold width + height (big-endian).
  assert.equal(buf.readUInt32BE(16), 192, 'IHDR width');
  assert.equal(buf.readUInt32BE(20), 192, 'IHDR height');
  assert.equal(buf.readUInt8(24), 8, 'bit depth 8');
  assert.equal(buf.readUInt8(25), 6, 'colour type RGBA');
  // ends with IEND
  assert.equal(buf.subarray(-8, -4).toString('ascii'), 'IEND');
});

test('solidIconPng handles the 512 size and an invalid colour (falls back, still valid PNG)', () => {
  const big = Buffer.from(solidIconPng('not-a-colour', 512));
  assert.ok(big.subarray(0, 8).equals(PNG_SIG));
  assert.equal(big.readUInt32BE(16), 512);
  assert.ok(big.length > 100, 'non-trivial PNG body');
});
