import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretCollectionsEnvelope } from '../commerce-verify';

test('a successful envelope with collections verifies with the count', () => {
  assert.deepEqual(
    interpretCollectionsEnvelope({ success: true, data: { collections: [{}, {}, {}] } }),
    { configured: true, verified: true, collectionCount: 3 }
  );
  // A bare array of collections is also accepted (the envelope varies by adapter).
  assert.deepEqual(interpretCollectionsEnvelope({ success: true, data: [{}, {}] }), {
    configured: true,
    verified: true,
    collectionCount: 2,
  });
});

test('a successful-but-empty envelope verifies with count 0 (reachable, no collections)', () => {
  assert.deepEqual(interpretCollectionsEnvelope({ success: true, data: { collections: [] } }), {
    configured: true,
    verified: true,
    collectionCount: 0,
  });
});

test('a failed envelope is NOT verified — the client resolves {success:false} instead of throwing', () => {
  // Regression: an unknown/invalid merchant id or a down backend comes back as { success:false,
  // data:null }. Reading data alone would falsely verify with count 0; gating on success is the fix.
  assert.deepEqual(interpretCollectionsEnvelope({ success: false, data: null }), {
    configured: true,
    verified: false,
  });
  assert.deepEqual(interpretCollectionsEnvelope(null), { configured: true, verified: false });
  assert.deepEqual(interpretCollectionsEnvelope(undefined), { configured: true, verified: false });
  assert.deepEqual(interpretCollectionsEnvelope({ data: { collections: [{}] } }), {
    configured: true,
    verified: false,
  });
});
