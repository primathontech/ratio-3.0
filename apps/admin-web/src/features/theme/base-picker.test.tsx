import { describe, test, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BasePicker } from './base-picker';
import type { BaseThemeOption } from '../../common/api';

const opts: BaseThemeOption[] = [
  { id: 'library-default', name: 'Forma', description: 'Clean flagship' },
  { id: 'library-nova', name: 'Nova', description: 'Bold D2C' },
];
const api = { previewBaseById: async () => ({ html: '<!doctype html>' }) };
const render = (o: BaseThemeOption[] = opts, value = 'library-default') =>
  renderToStaticMarkup(<BasePicker options={o} value={value} onChange={() => {}} api={api} />);

describe('BasePicker', () => {
  test('renders a selectable card per base, each with a Preview action (OFCE-700)', () => {
    const html = render();
    expect(html).toContain('Forma');
    expect(html).toContain('Nova');
    expect(html).toContain('Bold D2C');
    expect((html.match(/base-opt-preview/g) ?? []).length).toBe(2); // a Preview button per card
    expect(html).toContain('aria-checked="true"'); // the current selection is marked
  });

  test('renders nothing when there is only one base to pick', () => {
    expect(render([opts[0]!], 'library-default')).toBe('');
  });
});
