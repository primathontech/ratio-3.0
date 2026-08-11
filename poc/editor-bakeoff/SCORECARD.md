# OFCE-492 · Editor bake-off — scorecard

Deciding evidence #3 for ADR-013 (§5, §7.3). Prototype the same flow (add/reorder/nest 3 primitives + edit props, **save our `PageDoc` AST**) across the candidates and score. The AI-authoring experience + the section registry are the **moat we own**; the drag-drop shell is **commodity**.

## Hard evidence produced here

`puck-adapter.ts` + 6 passing round-trip tests: **Puck's `Data` model (root/content/zones) round-trips our `PageDoc` losslessly** across every real shape — flat, data-backed (`dataSources` + `dataSourceKey` + `version` pins), recursive `blocks`→zones, and no-title. So Puck _can_ represent our AST cleanly, via a ~120-line adapter. (The custom editor emits `PageDoc` natively → zero adapter, perfect fit by construction.)

## Scorecard

| Dimension                           | Evolve-custom                                                            | **Puck (OSS, MIT)**                                                                                     | Buy (Builder.io/Plasmic)                                                   |
| ----------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Fit to recursive AST + registry** | ✅✅ native (already emits PageDoc, forms from registry `settings`)      | ✅ lossless round-trip **proven**; needs adapter + a registry→Puck-config generator                     | ❌ proprietary model; AST + dataSourceKey binding + version pins don't map |
| **AI-emits-AST ergonomics**         | ✅✅ AI emits PageDoc → consumed directly                                | ✅ one transform (adapter) either direction                                                             | 🟡 targets their model — rented AI                                         |
| **App blocks (RAP-MSG)**            | ✅ we own the iframe + bridge (apps-platform seam exists)                | 🟡 an app-block = a custom Puck component hosting our sandboxed iframe; needs field-system↔RAP-MSG glue | ❌ their extension model, not ours                                         |
| **Translations / i18n**             | ✅ owned                                                                 | 🟡 layer it on                                                                                          | 🟡 CMS-buy has it, but that's not the editor shell                         |
| **Maintenance burden**              | ❌ we own the whole drag-drop shell forever (bespoke-framework trap, R3) | ✅ Puck maintains the commodity shell (~13k★, active); we own only adapter + config-gen                 | ✅ not our code, but vendor-dependent                                      |
| **Cost / lock-in**                  | ✅ $0, fully owned                                                       | ✅ $0 (MIT), self-hosted, JSON out — no lock-in                                                         | ❌ per-seat/space pricing + lock-in (§3.2)                                 |

## Synthesis

**Buy is out** — fails AST-fit, cost, and lock-in (confirms §3.2). The real choice is **evolve-custom vs Puck**, and it hinges on ADR-013's own principle: _the shell is commodity; the moat is the registry + AST + AI + app-blocks._

- **Custom**: perfect fit + total control, but we maintain the commodity shell forever (R3 bus-factor).
- **Puck**: **proven lossless AST fit** + Puck maintains the shell (lower maintenance), keeping our moat intact (we keep the registry, the AST, the AI path, the app-blocks — Puck is just the canvas). Cost = the adapter (proven small) + a registry→Puck-config generator + app-block bridge glue.

**Lean: adopt Puck as the editor-shell base**, evolving our registry/AST/AI/apps on top — **gated** on a short running-editor spike (browser) that the main risks pass:

1. **Registry → Puck component configs** — generate Puck field configs from our section `settings`; confirm the editing UX matches.
2. **App-block bridge** — embed one RAP-MSG sandboxed app as a Puck component (the biggest unknown).
3. **Nested block drag-drop** UX via Puck zones.

If those are clean → Puck. If the app-block bridge is too gnarly → evolve-custom (fit is already perfect there).

## §5.1 (first-party Liquid vs TS) — orthogonal to this choice

Puck replaces only the editor **canvas**, not the **render**. Sections stay Liquid templates in the registry (D33, merchant-forkable) regardless of editor. So the Liquid-vs-TS question is decided on the render side (edge-render-core), not by the editor bake-off. Still worth measuring fork-vs-configure with real merchants.

## Honest boundary of this evidence

This proves the **data round-trip** (necessary condition) — not the running editor UX. The three gates above need a browser spike (a Vite app with `@measured/puck`) before committing. But if the data hadn't round-tripped cleanly, Puck would be out regardless of UX — and it did.
