// themeId guard (S3-key safety): validation throws before any object-store call, so this needs no
// infra. A stub store whose methods must never be reached proves the short-circuit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ObjectStore } from '@ratio/data-objects';
import { ThemeStore } from '../theme-store';

const unreachable: ObjectStore = {
  put: async () => {
    throw new Error('unreachable');
  },
  get: async () => {
    throw new Error('unreachable');
  },
  head: async () => {
    throw new Error('unreachable');
  },
  delete: async () => {
    throw new Error('unreachable');
  },
};

const store = new ThemeStore(unreachable);

test('rejects a themeId with a path separator or traversal (before any S3 call)', async () => {
  await assert.rejects(() => store.readDraft({ themeId: '../evil' }), /invalid theme id/);
  await assert.rejects(() => store.saveDraft({ themeId: 'a/b' }, {}), /invalid theme id/);
  await assert.rejects(
    () => store.freezeBundles({ themeId: 'x/../y' }, { compile: (s) => s }),
    /invalid theme id/
  );
});

test('a normal slug themeId passes the guard (store then reached)', async () => {
  await assert.rejects(() => store.readDraft({ themeId: 'store_main' }), /unreachable/);
});
