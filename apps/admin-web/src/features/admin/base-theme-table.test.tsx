import { describe, test, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BaseRebaseTarget, BaseRebaseOutcome } from '../../common/api';
import { BaseThemeTable } from './base-theme-table';

const target = (over: Partial<BaseRebaseTarget> = {}): BaseRebaseTarget => ({
  tenantId: 't_shop',
  themeId: 't_shop_main',
  name: 'Shop',
  fromVersion: 1,
  toVersion: 2,
  isLive: true,
  overrideCount: 2,
  shadowedFiles: [],
  blocked: null,
  ...over,
});

const render = (
  targets: BaseRebaseTarget[],
  selected = new Set<string>(),
  outcomes: Record<string, BaseRebaseOutcome> | null = null
) =>
  renderToStaticMarkup(
    <BaseThemeTable targets={targets} selected={selected} outcomes={outcomes} onToggle={() => {}} />
  );

describe('BaseThemeTable (presentational)', () => {
  test('renders a ready store with its version bump and live badge', () => {
    const html = render([target()]);
    expect(html).toContain('Shop');
    expect(html).toContain('v1 → v2');
    expect(html).toContain('ready');
    expect(html).toContain('live');
  });

  test('an empty plan shows the all-up-to-date state', () => {
    expect(render([])).toContain('Every store is on the latest base');
  });

  test('a blocked store shows its reason and a disabled checkbox', () => {
    const html = render([target({ blocked: 'dirty-draft' })]);
    expect(html).toContain('unpublished draft');
    expect(html).toContain('disabled');
    expect(html).not.toContain('ready');
  });

  test('a broken-layout store is flagged', () => {
    expect(render([target({ blocked: 'broken-layout' })])).toContain('broken layout');
  });

  test('shadowed-file count surfaces (with the files in a title)', () => {
    const html = render([target({ shadowedFiles: ['sections/hero.liquid'] })]);
    expect(html).toContain('sections/hero.liquid'); // in the title attribute
  });

  test('a checked, selectable row reflects the selection', () => {
    const html = render([target()], new Set(['t_shop_main']));
    expect(html).toContain('checked');
  });

  test('after apply, the result column shows the per-store outcome', () => {
    const html = render([target()], new Set(), {
      t_shop_main: {
        tenantId: 't_shop',
        themeId: 't_shop_main',
        ok: true,
        madeLive: true,
        version: 3,
      },
    });
    expect(html).toContain('Result');
    expect(html).toContain('live · v3');
  });

  test('a failed outcome is shown as failed', () => {
    const html = render([target()], new Set(), {
      t_shop_main: { tenantId: 't_shop', themeId: 't_shop_main', ok: false, error: 'boom' },
    });
    expect(html).toContain('failed');
  });
});
