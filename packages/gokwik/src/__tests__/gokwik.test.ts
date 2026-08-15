import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sideCartTag, readableCartCookie, openCartCookie } from '../side-cart/side-cart';
import { sideCartIntegration } from '../side-cart';
import { checkoutTag } from '../checkout/checkout';
import { checkoutIntegration } from '../checkout';
import { composeGokwik, gokwikCartCookies } from '../compose';
import { mergeCsp, cspToString } from '../csp';
import type { IntegrationContext } from '../types';

const ctx = (over: Partial<IntegrationContext> = {}): IntegrationContext => ({
  env: {
    GOKWIK_SIDECART_SCRIPT_URL: 'https://kwikcart.gokwik.co/kwikcart/side-cart-os.js',
    GOKWIK_ENVIRONMENT: 'production',
    GOKWIK_CURRENCY: 'INR',
    GOKWIK_CURRENCY_FORMAT: 'en-IN',
  },
  merchantId: '195qow8rsryx',
  page: 'home',
  ...over,
});

const fullCfg = {
  scriptUrl: 'https://kwikcart.gokwik.co/kwikcart/side-cart-os.js',
  mid: '195qow8rsryx',
  environment: 'production',
  currency: 'INR',
  currencyFormat: 'en-IN',
};

test('sideCartTag: empty unless every field present; else emits merchantInfo + currency + store id + script', () => {
  assert.equal(sideCartTag(null), '');
  assert.equal(sideCartTag({ ...fullCfg, mid: '' }), ''); // no mid → widget can't resolve the merchant
  assert.equal(sideCartTag({ ...fullCfg, environment: '' }), ''); // no environment → don't guess
  const html = sideCartTag(fullCfg);
  assert.match(html, /window\.gk_cart_currency="INR"/);
  assert.match(html, /window\.gk_currency_format="en-IN"/);
  assert.match(html, /window\.gk_store_id="195qow8rsryx"/);
  assert.match(html, /"mid":"195qow8rsryx"/);
  assert.match(html, /"gkPlatform":"CUSTOM"/);
  assert.match(html, /"integrationType":"CUSTOM"/);
  assert.match(html, /"environment":"production"/);
  // mirrors the X-Cart-Token cookie into the merchant_<mid>_cartToken localStorage key the widget reads
  assert.match(html, /X-Cart-Token=\(\[\^;\]\+\)/);
  assert.match(html, /localStorage\.setItem\("merchant_195qow8rsryx_cartToken"/);
  assert.match(html, /<script src="https:\/\/kwikcart\.gokwik\.co\/kwikcart\/side-cart-os\.js"/);
});

test('sideCartTag: a `</script>` in the mid cannot break out of the inline script', () => {
  const html = sideCartTag({ ...fullCfg, mid: '</script><b>' });
  assert.doesNotMatch(html.split('<script src=')[0], /<\/script><b>/);
  assert.match(html, /\\u003c\/script>/);
});

test('sideCartTag ships the open-on-add trigger (reads rt_open_cart, opens the drawer)', () => {
  const html = sideCartTag(fullCfg);
  assert.match(html, /rt_open_cart=1/, 'the trigger checks the open-cart cookie');
  assert.match(html, /window\.openGokwikSideCart/, 'and opens the widget drawer');
});

test('openCartCookie: short-lived, JS-readable rt_open_cart (the client trigger reads it)', () => {
  const c = openCartCookie();
  assert.match(c, /^rt_open_cart=1;/);
  assert.doesNotMatch(c, /HttpOnly/i);
  assert.match(c, /Max-Age=\d+/);
});

test('readableCartCookie is NOT httpOnly (the browser widget reads it)', () => {
  const c = readableCartCookie('tok1');
  assert.match(c, /^X-Cart-Token=tok1;/);
  assert.doesNotMatch(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
});

test('sideCart integration is off unless every config field is present', () => {
  assert.equal(sideCartIntegration.enabled(ctx()), true);
  assert.equal(sideCartIntegration.enabled(ctx({ env: {} })), false); // no platform config
  assert.equal(sideCartIntegration.enabled(ctx({ merchantId: '' })), false); // no mid
  assert.equal(
    sideCartIntegration.enabled(
      ctx({
        env: {
          GOKWIK_SIDECART_SCRIPT_URL: 'x',
          GOKWIK_CURRENCY: 'INR',
          GOKWIK_CURRENCY_FORMAT: 'en-IN',
        },
      })
    ),
    false // no environment
  );
});

const checkoutEnv = {
  ...({
    GOKWIK_SIDECART_SCRIPT_URL: 'https://kwikcart.gokwik.co/kwikcart/side-cart-os.js',
    GOKWIK_ENVIRONMENT: 'production',
    GOKWIK_CURRENCY: 'INR',
    GOKWIK_CURRENCY_FORMAT: 'en-IN',
  } as Record<string, string>),
  GOKWIK_BASE_SCRIPT_URL: 'https://pdp.gokwik.co',
};

test('checkoutTag: empty unless every field present; else defines the trigger + loads gokwik.js', () => {
  assert.equal(checkoutTag(null), '');
  assert.equal(checkoutTag({ scriptUrl: 'x', mid: '', environment: 'production', type: 't' }), '');
  const html = checkoutTag({
    scriptUrl: 'https://pdp.gokwik.co',
    mid: '196jdfqy1aot',
    environment: 'production',
    type: 'merchantInfo',
  });
  assert.match(html, /window\.triggerRatioSideCartCheckout=async function/);
  assert.match(html, /fetch\('\/checkout'/); // server handshake
  assert.match(html, /gokwikSdk\.initCheckout\(\{/);
  assert.match(html, /environment:"production"/);
  assert.match(html, /type:"merchantInfo"/);
  assert.match(html, /mid:"196jdfqy1aot"/);
  assert.match(html, /<script src="https:\/\/pdp\.gokwik\.co\/v4\/build\/gokwik\.js"/);
  // completion via postMessage (the exact Purchase event) → stash order, clear cart, redirect + hydrate
  assert.match(html, /addEventListener\('message'/);
  assert.match(html, /d\.eventName!=='Purchase'/);
  assert.match(html, /sessionStorage\.setItem\('rt_order'/);
  assert.match(html, /id:c\.orderName,total:c\.total/); // exact GoKwik fields, no fallback chain
  assert.match(html, /getElementById\('rt-order-items'\)/);
  assert.match(html, /localStorage\.removeItem\("merchant_196jdfqy1aot_cartToken"\)/);
  assert.match(html, /location\.href='\/order\?id='/);
});

test('checkout integration is off without GOKWIK_BASE_SCRIPT_URL (type is the constant merchantInfo)', () => {
  assert.equal(checkoutIntegration.enabled(ctx()), false); // ctx() lacks GOKWIK_BASE_SCRIPT_URL → off
  assert.equal(checkoutIntegration.enabled(ctx({ env: checkoutEnv })), true);
});

test('composeGokwik: both integrations on → bodyEnd carries side-cart + checkout, csp merged once', () => {
  const out = composeGokwik(ctx({ env: checkoutEnv }));
  assert.match(out.bodyEnd, /side-cart-os\.js/); // side-cart
  assert.match(out.bodyEnd, /triggerRatioSideCartCheckout/); // checkout
  assert.match(out.bodyEnd, /v4\/build\/gokwik\.js/);
  // shared GOKWIK_CSP merged (deduped, not doubled)
  assert.deepEqual(out.csp['connect-src'], [
    "'self'",
    'https://*.gokwik.co',
    'https://*.gokwik.io',
  ]);
});

test('composeGokwik: nothing enabled → empty fragments + empty csp (strict default preserved)', () => {
  const out = composeGokwik(ctx({ env: {} }));
  assert.equal(out.head, '');
  assert.equal(out.bodyEnd, '');
  assert.deepEqual(out.csp, {});
  assert.deepEqual(gokwikCartCookies('t1', ctx({ env: {} })), []);
});

test('composeGokwik: side-cart enabled → bodyEnd script, gokwik csp, X-Cart-Token cookie', () => {
  const out = composeGokwik(ctx());
  assert.match(out.bodyEnd, /side-cart-os\.js/);
  assert.match(out.bodyEnd, /"mid":"195qow8rsryx"/);
  assert.ok(out.csp['connect-src']?.includes('https://*.gokwik.io'));
  assert.deepEqual(gokwikCartCookies('t1', ctx()), [readableCartCookie('t1')]);
});

test('mergeCsp drops none when a real source is added; keeps none when alone', () => {
  const base = { 'script-src': ["'none'"], 'img-src': ['https:', 'data:'] };
  const merged = mergeCsp(base, { 'script-src': ["'self'", 'https://*.gokwik.io'] });
  assert.deepEqual(merged['script-src'], ["'self'", 'https://*.gokwik.io']); // 'none' dropped
  assert.deepEqual(merged['img-src'], ['https:', 'data:']); // untouched
  // nothing added → 'none' stays (the strict no-JS default)
  assert.deepEqual(mergeCsp(base, {})['script-src'], ["'none'"]);
});

test('cspToString serializes directives in `key v1 v2; …` form', () => {
  const s = cspToString({ 'default-src': ["'none'"], 'script-src': ["'self'"] });
  assert.equal(s, "default-src 'none'; script-src 'self'");
});
