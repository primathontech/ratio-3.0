import { describe, test, expect } from 'vitest';
import { tokensFromFiles, filesWithTokens, TOKENS_PATH } from './tokens-file';

describe('tokensFromFiles', () => {
  test('parses the tokens file, keeping only known string keys', () => {
    const files = {
      [TOKENS_PATH]: JSON.stringify({
        color: '#0ea5e9',
        radius: 'rounded',
        baseSize: 42,
        junk: 'x',
      }),
      'sections/hero.liquid': '<section></section>',
    };
    expect(tokensFromFiles(files)).toEqual({ color: '#0ea5e9', radius: 'rounded' });
  });

  test('returns {} when the file is absent, malformed, or not an object', () => {
    expect(tokensFromFiles({})).toEqual({});
    expect(tokensFromFiles({ [TOKENS_PATH]: '{not json' })).toEqual({});
    expect(tokensFromFiles({ [TOKENS_PATH]: '"a string"' })).toEqual({});
    expect(tokensFromFiles({ [TOKENS_PATH]: '[1,2,3]' })).toEqual({});
  });
});

describe('filesWithTokens', () => {
  test('writes tokens into config/tokens.json without touching other files', () => {
    const files = { 'sections/hero.liquid': '<section>keep me</section>' };
    const out = filesWithTokens(files, { color: '#111827', radius: 'square' });
    expect(out['sections/hero.liquid']).toBe('<section>keep me</section>');
    expect(JSON.parse(out[TOKENS_PATH])).toEqual({ color: '#111827', radius: 'square' });
  });

  test('round-trips through tokensFromFiles', () => {
    const tokens = { color: '#3F53FE', bodyFont: 'serif', baseSize: 'l' };
    expect(tokensFromFiles(filesWithTokens({}, tokens))).toEqual(tokens);
  });

  test('persists only known token keys (an unexpected key never reaches the bundle)', () => {
    const out = filesWithTokens({}, { color: '#111827', bogusKey: 'x' } as never);
    expect(JSON.parse(out[TOKENS_PATH])).toEqual({ color: '#111827' });
  });
});
