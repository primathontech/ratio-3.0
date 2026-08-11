import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, requestLog, type Logger } from '../index';

test('classifyError → closed taxonomy + type name, never the raw message', () => {
  assert.deepEqual(classifyError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), {
    code: 'network',
    errType: 'Error',
  });
  assert.equal(
    classifyError(Object.assign(new Error('x'), { name: 'AbortError' })).code,
    'timeout'
  );
  const leaky = classifyError(new Error('auth failed key sk_live_ABC at https://x?token=SEKRIT'));
  assert.equal(leaky.code, 'error');
  assert.ok(!JSON.stringify(leaky).includes('sk_live'), 'raw message never surfaces');
});

test('requestLog binds reqId onto a child', () => {
  const bound: Record<string, string>[] = [];
  const fake: Logger = {
    info() {},
    warn() {},
    error() {},
    child(b) {
      bound.push(b);
      return fake;
    },
  };
  requestLog(fake, 'req-1');
  assert.deepEqual(bound[0], { reqId: 'req-1' });
});
