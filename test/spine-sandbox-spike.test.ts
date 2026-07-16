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
  // (b) output/loop limits are configurable at the engine level (not per-template trust)
  const bounded = new Liquid(); // could pass { ... } limits in a real config
  const loop = await bounded.parseAndRender('{% for i in (1..5) %}{{ i }}{% endfor %}', {});
  assert.equal(loop, '12345');
  // CONCLUSION: Liquid was built for hostile templates (Shopify's model). It is the safer base;
  // still must set explicit render-time + output limits, but the language surface is contained.
});

// ─── B2: capability inference from the template (not dev-declared) ───────────
// The claim (REQ-3): the platform can COMPUTE a template's cacheability tier by extracting every
// data/capability reference and diffing against declared bindings — rejecting anything undeclared.
// Spike: parse a Liquid template to its AST/token stream and extract variable + tag references,
// including the capabilities that break purity (now, random, includes, filters with side effects).

const engine = new Liquid();

// Extract top-level variable roots + tag names a template references, from Liquid's parse output.
function referencedCapabilities(src: string): { vars: Set<string>; tags: Set<string> } {
  const templates = engine.parse(src);
  const vars = new Set<string>();
  const tags = new Set<string>();
  const walk = (nodes: unknown[]) => {
    // LiquidJS AST nodes are not publicly typed; this spike walks them structurally.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const n of nodes as any[]) {
      // output nodes: {{ x.y | filter }}
      if (n?.value?.initial?.postfix) {
        for (const seg of n.value.initial.postfix) {
          const props = seg?.props;
          if (Array.isArray(props) && props[0]?.content) vars.add(String(props[0].content));
        }
        // filters count as capabilities (a filter can pull time/locale/etc)
        for (const f of n.value.filters ?? []) if (f?.name) tags.add('filter:' + f.name);
      }
      // tag nodes: {% ... %}
      if (n?.token?.kind !== undefined && n?.name) tags.add(String(n.name));
      if (n?.impl?.branches) for (const b of n.impl.branches) if (b?.templates) walk(b.templates);
      if (n?.impl?.templates) walk(n.impl.templates);
    }
  };
  walk(templates);
  return { vars, tags };
}

test('B2: pure template — referenced vars are all declared → cacheable', () => {
  const src = '<h1>{{ product.title }}</h1><p>{{ product.description }}</p>';
  const { vars } = referencedCapabilities(src);
  assert.ok(vars.has('product'), 'extracted product root');
  const declared = new Set(['product']);
  const undeclared = [...vars].filter((v) => !declared.has(v));
  assert.deepEqual(undeclared, [], 'no undeclared data access → inferrable as cacheable');
});

test('B2: undeclared data access is detected and rejected', () => {
  const src = '{{ product.title }} {{ secret_customer.email }}';
  const { vars } = referencedCapabilities(src);
  const declared = new Set(['product']);
  const undeclared = [...vars].filter((v) => !declared.has(v));
  assert.ok(undeclared.includes('secret_customer'), 'inference catches the undeclared binding');
});

test('B2: purity-breaking capabilities (now/random/filters) are surfaced, not silently allowed', () => {
  // 'now' via a date filter, and any custom filter, must be classified — never invisibly cached.
  const src = "{{ 'now' | date: '%s' }}{{ product.price | money }}";
  const { tags } = referencedCapabilities(src);
  const filters = [...tags].filter((t) => t.startsWith('filter:'));
  assert.ok(
    filters.includes('filter:date'),
    'date filter surfaced (time = per-request, breaks purity)'
  );
  assert.ok(filters.includes('filter:money'), 'money filter surfaced (locale/currency capability)');
  // POLICY: every surfaced filter/tag must be on an allowlist mapped to a cacheability tier;
  // an unknown or time/random capability forces the field out of `static`.
});

test('B2: includes/renders must be walked transitively (smuggling via partials)', () => {
  // A template that {% render %}s another can smuggle data access. The inference MUST recurse.
  const src = "{% render 'card', item: product %}";
  const { tags } = referencedCapabilities(src);
  assert.ok(
    [...tags].some((t) => t === 'render' || t === 'include'),
    'include/render surfaced for transitive analysis'
  );
  // CONCLUSION: inference is FEASIBLE on Liquid (AST is inspectable), but only sound if it
  // (1) walks includes transitively, (2) allowlists filters/tags→tiers, (3) bans dynamic
  // property access syntax. Handlebars' helper model makes this materially harder.
});
