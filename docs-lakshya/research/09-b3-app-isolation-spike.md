# 09 — B3 App-Isolation Spike

**Spine track:** B3 (third-party "app islands" on cached storefront pages)
**Prototype:** [`ratio-3.0/test/spine-b3-isolation.html`](../ratio-3.0/test/spine-b3-isolation.html) — open in a browser; the scoreboard must read `10/10 held`.
**Status:** spike / kill-criteria gate
**Date:** 2026-07-16

---

## 1. Problem statement

Storefront pages are **HTML-cached at the edge** and served to every shopper. We want to drop
third-party "app islands" (reviews widget, loyalty badge, upsell block, etc.) into those pages.
Those apps are **untrusted code we did not write** running inside a page that also holds:

- the shopper's **session cookies** and `localStorage`,
- the **cart / checkout** DOM and first-party JS,
- the **top-level navigation** context (an app that can retarget `top` can phish).

An app island must be able to do a few _negotiated_ things (read cart count, ask for more
height) and **nothing else** — no matter what its code tries.

---

## 2. Threat model

| #   | Actor                                       | Goal                                   | Vector                                                         |
| --- | ------------------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| T1  | Malicious/compromised app                   | Steal session                          | Read `document.cookie` / `localStorage` of host                |
| T2  | "                                           | Exfiltrate PII                         | Read host DOM (checkout fields, address)                       |
| T3  | "                                           | Phish                                  | Navigate the **top** frame to an attacker page                 |
| T4  | "                                           | Privilege escalation                   | Call host capabilities it was never granted                    |
| T5  | Malicious sibling frame / popup / other tab | Impersonate the app to the host bridge | `postMessage` a forged capability request                      |
| T6  | "                                           | Corrupt host runtime                   | **Prototype pollution** via a crafted message payload          |
| T7  | "                                           | Layout / clickjacking hijack           | Grow its frame to cover the page ("request a 999999px resize") |

**Trust boundary:** everything inside the app frame is hostile. The host trusts only
(a) messages whose `event.source` is the live app-frame window, and (b) its own code.

---

## 3. Why CSP is not sufficient

CSP is a **load-time** control. `script-src` decides _what source a script may be fetched from_
(nonce, hash, host allowlist). It says nothing about _what already-loaded script may do_.

- Our storefront CSP today is `script-src 'none'` — great, but the moment we allow an app to run
  **any** script (even nonce-blessed, even self-hosted), CSP stops helping with T1–T3. Loaded
  code shares the page's origin, so it can read `document.cookie`, walk the DOM, and set
  `top.location`. CSP never gated those DOM APIs.
- `connect-src` can limit exfiltration _destinations_, but a same-origin app can still read the
  secrets and stage them (e.g. write to a first-party endpoint, or a pixel on an allowed host).
- Nonces/hashes on a **cached** page are worse: a static nonce baked into cached HTML is
  effectively public and replayable.

> **CSP controls what LOADS. It does not control what loaded code can DO.**
> Isolation of _capability_ requires an **origin boundary**, not a source allowlist.

CSP stays in the stack (defense in depth: `frame-src` to pin where app frames may come from,
`sandbox` directive as backstop), but it is not the isolation mechanism.

---

## 4. Design: sandboxed cross-origin iframe + capability bridge

### 4.1 The frame

Serve each app island from a **separate origin** (e.g. `https://apps.gokwik.io`) inside an
iframe, and sandbox it:

```html
<iframe sandbox="allow-scripts" src="https://apps.gokwik.io/app/reviews"></iframe>
```

Token choices:

| Token                                                                  | Set?                           | Why                                      |
| ---------------------------------------------------------------------- | ------------------------------ | ---------------------------------------- |
| `allow-scripts`                                                        | **yes**                        | An app island is useless without JS.     |
| `allow-same-origin`                                                    | **NEVER (with allow-scripts)** | See below — this is the whole ballgame.  |
| `allow-top-navigation`                                                 | no                             | Blocks T3 (phishing via `top.location`). |
| `allow-popups`                                                         | no                             | No popups / no popup-escape of sandbox.  |
| `allow-forms`, `allow-modals`, `allow-downloads`, `allow-pointer-lock` | no                             | Not needed; each is attack surface.      |

**Why `allow-same-origin` must NEVER be combined with `allow-scripts`:**
without `allow-same-origin` the frame runs at an **opaque ("null") origin** — it is cross-origin
to the host by construction, so `parent.document`, `parent.document.cookie` and
`parent.localStorage` all throw `SecurityError`, and the frame has **no storage of its own**.
Adding `allow-same-origin` back would let the framed document adopt its server's real origin;
if that origin ever equals (or can script) the host's origin, the sandbox is neutralised and the
app regains same-origin DOM/cookie access. The two tokens together are a documented footgun —
the sandbox is only a boundary while they are **not** both present. In the prototype we get the
opaque origin "for free" by loading via `srcdoc` with `sandbox="allow-scripts"`.

### 4.2 The capability bridge (postMessage)

The frame can't touch the host directly, so all interaction is **explicit, host-mediated
message passing**. Every inbound message runs a fixed gauntlet; first failure = silent drop
(don't hand untrusted senders an error oracle):

1. **Sender identity** — `event.source === appFrame.contentWindow`. The browser sets
   `event.source`; it is unforgeable. This alone defeats **T5** (siblings/popups/other tabs).
2. **Origin allowlist** — `event.origin === EXPECTED_ORIGIN` (the pinned app origin in prod;
   `"null"` for the opaque srcdoc frame locally). Belt-and-braces with (1).
3. **Schema** — message must be a plain object `{ type:string, id:string, payload:object }`.
   Reject arrays, primitives, missing fields.
4. **Prototype-pollution guard** — recursively refuse any payload carrying an own key of
   `__proto__` / `prototype` / `constructor`. `JSON.parse('{"__proto__":…}')` produces a real
   own key that survives structured clone, so a downstream naive merge could be poisoned; we
   drop the whole message (**T6**).
5. **Capability allowlist** — `type ∈ { 'get-cart-count', 'request-resize' }`. Anything else is
   denied (**T4**). The app may be told "denied" but no host data leaks.
6. **Dispatch + budget** — run the one whitelisted handler. `request-resize` is **clamped** by
   the host to `[MIN, MAX]`; the app _asks_, the host _decides_ (**T7**).

Responses are correlated by `id` so the app can `await` a capability call.

---

## 5. What the HTML harness proves — locally vs. real-browser matrix

### Proven locally (single file, no deps)

The harness drives all seven threats plus two positive controls and prints a scoreboard:

- T1/T2 — reading host DOM, cookies, `localStorage` → `SecurityError`, blocked.
- T3 — `top.location` navigation → suppressed by sandbox.
- T4 — non-allowlisted `purge-database` → dropped at gate 5.
- T5 — a forged `postMessage` from the top window → dropped at gate 1 (`event.source` mismatch).
- T6 — `{"__proto__":{polluted:true}}` payload → dropped at gate 4; `Object.prototype` clean.
- T7 — `request-resize height:999999` → clamped to the budget.
- Controls — valid `get-cart-count` returns a value and in-budget resize is applied, proving the
  bridge is actually alive (so "all blocked" isn't just a dead channel).

### NOT proven locally — needs a real cross-origin + browser matrix

- **Real cross-origin serving.** The prototype uses `srcdoc`/opaque origin. Production must load
  from a genuinely different origin and verify `EXPECTED_ORIGIN` pins correctly (and that
  `event.origin` is the app origin, not `"null"`).
- **Safari quirks.** ITP / storage partitioning behaviour, `srcdoc` + sandbox origin reporting,
  and whether sandboxed frames get third-party storage at all. Test on real Safari (iOS + macOS).
- **Firefox quirks.** Historically stricter/earlier on sandbox top-navigation and opaque-origin
  storage exceptions; confirm the thrown exception names/behaviour match our assumptions.
- **Sandbox escape regressions** across Chromium/WebKit/Gecko versions — needs a CI matrix, not a
  one-shot manual open.
- **CSP interaction** on the _real_ cached page (`frame-src`, `sandbox` directive as backstop,
  `frame-ancestors` on the app origin).
- **Performance / UX** of many islands (message throughput, resize thrash, load cost) — out of
  scope for the security spike.

---

## 6. B3 kill-criteria verdict

> **B3 is viable iff:** an untrusted app island can be given exactly its granted capabilities and
> **cannot** (a) read host cookies/storage/DOM, (b) navigate the top frame, (c) invoke any
> non-allowlisted capability, (d) impersonate the app to the bridge, (e) pollute host runtime, or
> (f) exceed its resize budget — **on every browser in the support matrix**.

**Verdict template — fill after the browser-matrix run:**

```
B3 ISOLATION VERDICT
  Local harness (this file) ........ PASS (10/10 held) / FAIL: ____
  Chromium (real cross-origin) ..... PASS / FAIL: ____
  Safari macOS ..................... PASS / FAIL: ____
  Safari iOS ....................... PASS / FAIL: ____
  Firefox .......................... PASS / FAIL: ____
  CSP backstop on cached page ...... PASS / FAIL: ____

  DECISION:  [ ] GREENLIGHT — sandbox+bridge holds across matrix; proceed to B3 build.
             [ ] CONDITIONAL — holds except: ____ ; mitigate then re-gate.
             [ ] KILL — a boundary failed with no mitigation: ____
```

**Current standing:** local harness passes; decision is **pending the real-browser matrix**.
No greenlight on the strength of `srcdoc` alone — the opaque-origin shortcut must be reproduced
with true cross-origin serving before B3 exits the spike.
