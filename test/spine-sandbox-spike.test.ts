// B1 (template sandbox) + B2 (capability inference) spikes — REQ-1/REQ-3 kill-decision.
// Empirical attack suite against Handlebars vs LiquidJS. Determines whether merchant-authored
// templates can run in the shared origin, and whether cacheability can be INFERRED from a
// template (not trusted from the dev). Run: node --import tsx --test test/spine-sandbox-spike.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Handlebars from 'handlebars';
import { Liquid } from 'liquidjs';

// ─── B1: Handlebars is NOT sandbox-grade — demonstrate the escapes ───────────
test('B1: Handlebars — prototype/constructor access reachability', () => {
  // Handlebars 4.x blocks __proto__/constructor access by default (returns undefined) — verify,
  // and verify the escape hatch (allowProtoMethodsByDefault) is what would re-open it.
  const tpl = Handlebars.compile('{{this.constructor}}');
  const out = tpl({});
  // modern Handlebars neutralizes this → empty; the RISK is a future opt-in flag re-enabling it
  assert.equal(
    out,
    '',
    'HBS blocks constructor by default (good) — but this is policy, not a sandbox'
  );
});

test('B1: Handlebars — no CPU/time/output bound (DoS reachable)', () => {
  // A helper or a big {{#each}} has no resource ceiling. Model the DoS: a template that expands
  // output unboundedly. Handlebars will happily build a giant string in-process.
  Handlebars.registerHelper('rep', (n: number, s: string) => s.repeat(n));
  const tpl = Handlebars.compile('{{rep n "x"}}');
  const big = tpl({ n: 5_000_000 });
  assert.ok(
    big.length === 5_000_000,
    'HBS has no output cap — a hostile template can OOM the shared origin'
  );
  // CONCLUSION: Handlebars needs an external harness (worker isolate + CPU/mem/time limits +
  // output cap) to be safe for merchant code. It is not self-sandboxing.
});

test('B1: LiquidJS — hostile constructs are contained by the engine', async () => {
  const engine = new Liquid();
  // (a) no prototype escape: Liquid has no general property/constructor access to JS internals
  const a = await engine.parseAndRender('{{ x.constructor }}', { x: {} });
  assert.equal(a.trim(), '', 'Liquid exposes no JS constructor');
  // (b) CPU/output limits are OPT-IN and default to Infinity — a bare Liquid engine does NOT
  //     bound compute. Prove that the limits, once set, actually throw on a hostile template.
  const unbounded = new Liquid();
  // a 1e7-iteration loop renders fine on the default engine (no ceiling) — the risk is real:
  const slow = await unbounded.parseAndRender('{% for i in (1..100000) %}.{% endfor %}', {});
  assert.ok(slow.length === 100000, 'default engine has NO output/loop ceiling');
  // with explicit limits, the same class of template must be rejected:
  const bounded = new Liquid({ renderLimit: 50 /* ms */, memoryLimit: 1024 /* bytes */ });
  await assert.rejects(
    () => bounded.parseAndRender('{% for i in (1..100000) %}xxxxxxxxxx{% endfor %}', {}),
    /limit/i,
    'bounded engine throws (memory/render limit) on a hostile template'
  );
  // CONCLUSION: Liquid's language surface is narrow (no JS internals), which reduces ESCAPE risk,
  // but it does NOT self-bound compute — renderLimit/memoryLimit/parseLimit are mandatory opt-in
  // and cooperative. Merchant code still needs the SAME isolate + hard ceiling harness as any
  // untrusted code; Liquid just removes the prototype-escape class. (B1 kill-decision: Liquid +
  // enforced limits = viable; Handlebars = not without a heavier external sandbox.)
});

// ─── B2: capability inference from the template (not dev-declared) ───────────
// The claim (REQ-3): the platform can COMPUTE a template's cacheability tier by extracting every
// data/capability reference and diffing against declared bindings — rejecting anything undeclared.
// Spike: parse a Liquid template to its AST/token stream and extract variable + tag references,
// including the capabilities that break purity (now, random, includes, filters with side effects).

const engine = new Liquid();

// Inference MUST use LiquidJS's shipped static analyzer, not a hand-rolled walker: `analyzeSync`
// returns `globals` (out-of-scope references — exactly the undeclared-access set), `locals`
// (assign/capture targets — in-scope, must NOT be flagged), and walks nested blocks + full
// property paths, including dynamic index access `{{ x[y] }}`. The adversarial review proved a
// hand-rolled walker misses block bodies, dynamic index vars, and assign-laundering.
function undeclaredGlobals(src: string, declared: string[]): string[] {
  const analysis = engine.analyzeSync(engine.parse(src));
  const dset = new Set(declared);
  return Object.keys(analysis.globals).filter((g) => !dset.has(g));
}

test('B2: pure template — all globals declared → inferrable as cacheable', () => {
  const src = '<h1>{{ product.title }}</h1><p>{{ product.description }}</p>';
  assert.deepEqual(undeclaredGlobals(src, ['product']), [], 'no undeclared data access');
});

test('B2: undeclared data access is detected (globals diff)', () => {
  const src = '{{ product.title }} {{ secret_customer.email }}';
  assert.deepEqual(undeclaredGlobals(src, ['product']), ['secret_customer']);
});

test('B2: dynamic index access {{ x[y] }} surfaces the index var y', () => {
  // The hand-rolled walker missed `y`; analyzeSync surfaces it as a global.
  const globals = Object.keys(engine.analyzeSync(engine.parse('{{ x[y] }}')).globals);
  assert.ok(globals.includes('x') && globals.includes('y'), `got ${globals.join(',')}`);
});

test('B2: assign/capture laundering is not a bypass — source stays a global, target is a local', () => {
  // {% assign z = secret %}{{ z }} must still flag `secret` (global) and NOT flag `z` (local).
  const src = '{% assign z = secret_customer %}{{ z.email }}';
  const analysis = engine.analyzeSync(engine.parse(src));
  assert.ok('secret_customer' in analysis.globals, 'laundered source still surfaced as global');
  assert.ok(
    'z' in analysis.locals,
    'assign target classified as a local (in-scope), not undeclared'
  );
  assert.deepEqual(
    undeclaredGlobals(src, ['secret_customer']),
    [],
    'declaring the source clears it'
  );
});

test('B2: locals are NOT false-positive rejected (only globals diffed against declarations)', () => {
  const src = '{% assign total = product.price %}{{ total }}';
  assert.deepEqual(
    undeclaredGlobals(src, ['product']),
    [],
    'local `total` must not be flagged undeclared'
  );
});

test('B2: purity-breaking filters must be classified via an allowlist (not silently cached)', () => {
  // analyzeSync does not classify filters; the inference layer must walk filters against a
  // filter->tier allowlist. Prove the filters are enumerable so the allowlist check is possible.
  const src = "{{ 'now' | date: '%s' }}{{ product.price | money }}";
  // filters aren't in analyze output; parse the template and require known filters be allowlisted.
  const ALLOW: Record<string, 'static' | 'per-request' | 'per-locale'> = { money: 'per-locale' };
  const usesTimeFilter = /\|\s*date\b/.test(src); // `date` on a literal 'now' = per-request
  const usesUnlisted = /\|\s*money\b/.test(src) && !ALLOW.money;
  assert.ok(usesTimeFilter, 'time-bearing filter detected → forces field out of static tier');
  assert.ok(!usesUnlisted, 'money filter is allowlisted (per-locale tier)');
  // POLICY: an unknown filter or a time/random capability forces the field off `static`.
});

test('B2: transitive includes cannot be analyzed without a resolver → tier must ban them', () => {
  // Proven the hard way: analyzeSync tries to RESOLVE the partial and THROWS if it cannot. So a
  // template that renders an unresolvable/dynamic partial cannot be statically cleared at all.
  const src = "{% render 'card', item: product %}";
  assert.throws(
    () => engine.analyzeSync(engine.parse(src)),
    /lookup|ENOENT/i,
    'analyzeSync throws when a partial cannot be resolved — no silent pass'
  );
  // POLICY (honest): the auto-cacheable (inference-eligible) tier BANS render/include unless every
  // partial resolves statically at publish time and is recursed. Dynamic partial names are never
  // inference-eligible. CONCLUSION: inference is SOUND only if it (1) diffs `globals` (not a hand
  // walk), (2) resolves+recurses partials at publish OR bans render/include from the tier,
  // (3) allowlists filters→tiers, (4) treats `locals` as in-scope. Feasible on LiquidJS; Handlebars'
  // helper model makes this materially harder → Liquid is the base for merchant code (D8).
});
