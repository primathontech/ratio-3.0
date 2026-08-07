// GoKwik checkout: the payment SDK runs in the browser (window.gokwikSdk.initCheckout), so this is
// inherently a client script. The server does the createCheckout handshake (POST /checkout →
// merchantCheckoutId); this script hands that id to the SDK. The side-cart drawer's Checkout button
// calls window.triggerRatioSideCartCheckout, so defining it here wires the drawer to checkout.
import { esc } from '@ratio/builder-core';
import { jsInline } from '../inline';

export interface CheckoutConfig {
  scriptUrl: string; // GoKwik SDK base; the SDK is `${scriptUrl}/v4/build/gokwik.js`
  mid: string;
  environment: string; // 'production' | 'sandbox'
  type: string; // GoKwik checkout type
}

export function checkoutTag(cfg: Partial<CheckoutConfig> | null | undefined): string {
  if (!cfg?.scriptUrl || !cfg.mid || !cfg.environment || !cfg.type) return '';
  const sdk = esc(`${cfg.scriptUrl.replace(/\/$/, '')}/v4/build/gokwik.js`);
  const tokenKey = jsInline(`merchant_${cfg.mid}_cartToken`);
  // GoKwik signals order completion via window.postMessage (the SDK's `.on` callback is unreliable),
  // and the payload carries the order + line items — so we capture it there. The listener stashes the
  // order in sessionStorage, clears the client cart state, and redirects to our thank-you page. A
  // matching hydrate() fills the thank-you page's item list from that stash (it lives on /order).
  // Completion event (confirmed from the live payload): type 'analyticsEvent', eventName 'Purchase',
  // with cartData.{orderName, total, items[].{title,quantity,price}} — amounts in rupees. Read those
  // exact fields; the leading guard rejects any other message.
  const listener =
    `(function(){if(window.__ratioGkMsg)return;window.__ratioGkMsg=1;` +
    `function e(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}` +
    `function m(v){return '\\u20b9'+Number(v).toFixed(2)}` +
    `function hydrate(){var b=document.getElementById('rt-order-items');if(!b)return;` +
    `var o=JSON.parse(sessionStorage.getItem('rt_order')||'null');if(!o||!o.items)return;` +
    `b.innerHTML=o.items.map(function(it){` +
    `return '<div class="order-row"><span>'+e(it.title)+' \\u00d7 '+it.quantity+'</span><span>'+m(it.price*it.quantity)+'</span></div>'}).join('')}` +
    `if(document.readyState!=='loading')hydrate();else document.addEventListener('DOMContentLoaded',hydrate);` +
    `window.addEventListener('message',function(ev){var d=ev.data;` +
    `if(!d||d.type!=='analyticsEvent'||d.eventName!=='Purchase'||window.__ratioDone)return;` +
    `window.__ratioDone=1;var c=d.cartData;` +
    `var s={id:c.orderName,total:c.total,currency:c.currency,items:c.items};` +
    `sessionStorage.setItem('rt_order',JSON.stringify(s));` +
    `localStorage.removeItem(${tokenKey});document.cookie='X-Cart-Token=; Path=/; Max-Age=0';` +
    `setTimeout(function(){if(window.gokwikSdk&&window.gokwikSdk.close)window.gokwikSdk.close();` +
    `location.href='/order?id='+encodeURIComponent(s.id)+'&total='+encodeURIComponent(s.total)},1000)});})();`;
  const trigger =
    `window.triggerRatioSideCartCheckout=async function(){try{` +
    `var r=await fetch('/checkout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});` +
    `var d=await r.json();var id=d&&d.merchantCheckoutId;` +
    `if(!id||!window.gokwikSdk){console.error('checkout unavailable');return}` +
    `window.gokwikSdk.initCheckout({environment:${jsInline(cfg.environment)},type:${jsInline(cfg.type)},` +
    `mid:${jsInline(cfg.mid)},phoneNumber:"",merchantParams:{merchantCheckoutId:id,customerToken:"",` +
    `origReferrer:location.href,adSource:"",landingPage:location.origin}});` +
    `}catch(e){console.error('checkout failed',e)}};`;
  return `<script>${listener}${trigger}</script>` + `<script src="${sdk}" async></script>`;
}
