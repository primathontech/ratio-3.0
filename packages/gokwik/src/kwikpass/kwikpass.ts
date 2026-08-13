// GoKwik KwikPass: customer login (phone/OTP). The SDK runs in the browser — it renders the login
// modal and, on success, writes the customer token to the KWIKUSERTOKEN cookie the origin reads.
// This emits the two SDK scripts + merchantInfo, calls kpUpdateDOM once loaded, wires the account
// page's login/logout buttons, and reloads on `user-loggedin` so the server picks up the new cookie.
import { esc } from '@ratio/builder-core';
import { jsInline } from '../inline';
import { KWIKPASS_TOKEN_KEYS } from '../auth';

export interface KwikpassConfig {
  scriptUrl: string; // GoKwik SDK base; scripts are `${scriptUrl}/kwikpass/...`
  mid: string;
  environment: string; // 'production' | 'sandbox'
}

export function kwikpassTag(cfg: Partial<KwikpassConfig> | null | undefined): string {
  if (!cfg?.scriptUrl || !cfg.mid || !cfg.environment) return '';
  const base = cfg.scriptUrl.replace(/\/$/, '');
  const core = esc(`${base}/kwikpass/non-shopify-core-functions.min.js`);
  const merchant = esc(`${base}/kwikpass/plugin/build/kp-merchant-v2.js`);
  const merchantInfo = jsInline({
    mid: cfg.mid,
    environment: cfg.environment,
    type: 'merchantInfo',
    gkPlatform: 'CUSTOM',
    integrationType: 'CUSTOM',
  });
  const keys = jsInline(KWIKPASS_TOKEN_KEYS.concat(['customerDetails', 'GUESTUSERDATA'] as never));
  const authKeys = jsInline(KWIKPASS_TOKEN_KEYS as never);
  const glue =
    `window.merchantInfo=Object.assign({},window.merchantInfo,${merchantInfo});` +
    `(function(){if(window.__ratioKp)return;window.__ratioKp=1;` +
    // logged-in when a KwikPass token cookie is present (the SDK writes it on login/checkout-OTP).
    `function inAuth(){return document.cookie.split('; ').some(function(c){var k=c.split('=')[0];` +
    `return ${authKeys}.indexOf(k)>-1&&c.slice(k.length+1)})}` +
    `function wire(){var authed=inAuth();` +
    // header Account island: mark state; button toggles the dropdown when logged in, else opens login.
    `var acct=document.getElementById('rt-account');if(acct)acct.setAttribute('data-auth',authed?'in':'out');` +
    `var menu=document.getElementById('rt-account-menu');` +
    `var btn=document.getElementById('rt-account-btn');if(btn)btn.addEventListener('click',function(){` +
    `if(inAuth()){if(menu){var h=menu.hasAttribute('hidden');if(h)menu.removeAttribute('hidden');else menu.setAttribute('hidden','');` +
    `btn.setAttribute('aria-expanded',String(h))}}else if(window.handleCustomLogin)window.handleCustomLogin(false)});` +
    `if(menu)document.addEventListener('click',function(e){if(acct&&!acct.contains(e.target))menu.setAttribute('hidden','')});` +
    // the /account page's login CTA
    `var li=document.getElementById('rt-login');` +
    `if(li)li.addEventListener('click',function(){if(window.handleCustomLogin)window.handleCustomLogin(false)});` +
    // logout (header dropdown or account page): clear the KwikPass token storage, SDK logout, home.
    `var lo=document.getElementById('rt-logout');if(lo)lo.addEventListener('click',function(){` +
    `try{${keys}.forEach(function(k){try{localStorage.removeItem(k)}catch(_){}` +
    `document.cookie=k+'=; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'})}catch(_){}` +
    `if(window.handleLogout)window.handleLogout('/');location.replace('/')})}` +
    `if(document.readyState!=='loading')wire();else document.addEventListener('DOMContentLoaded',wire);` +
    // the SDK fires user-loggedin on login; reload so the server sees the KWIKUSERTOKEN cookie
    `window.addEventListener('user-loggedin',function(){location.reload()});})();`;
  return (
    `<script>${glue}</script>` +
    `<script src="${core}"></script>` +
    `<script src="${merchant}" async id="rt-kp-merchant"></script>` +
    `<script>var _kp=document.getElementById('rt-kp-merchant');` +
    `if(_kp)_kp.addEventListener('load',function(){if(window.kpUpdateDOM)window.kpUpdateDOM()});</script>`
  );
}
