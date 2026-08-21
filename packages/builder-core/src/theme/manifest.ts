// Web App Manifest (PWA). A store gets one automatically, SYNTHESIZED from what the merchant already
// configures in admin — the store name + brand colour — so there's no separate PWA form to fill in. A
// theme that ships its own manifest.json in the bundle overrides this (author control). Served at
// /manifest.json by the origin's well-known handler.
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export interface WebManifestInput {
  name: string; // the store's display name
  themeColor?: string; // brand colour (hex); falls back when absent/invalid
  iconUrl?: string; // an icon URL; defaults to the well-known /favicon.ico
}

// A minimal, valid installable manifest. short_name is capped at 12 chars (the home-screen label
// budget). theme_color only takes a validated hex — an untrusted value can't inject into the JSON.
function baseManifest({ name, themeColor, iconUrl }: WebManifestInput): Record<string, unknown> {
  return {
    name,
    short_name: name.slice(0, 12),
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: themeColor && HEX.test(themeColor) ? themeColor : '#000000',
    icons: [{ src: iconUrl ?? '/favicon.ico', sizes: 'any', type: 'image/x-icon' }],
  };
}

// The manifest served at /manifest.json. The synthesized defaults (store name + brand colour, from
// admin) are the BASE; a theme's own manifest.json — a real file the merchant sees + edits in the code
// editor — overrides any key. So a store is a valid PWA with zero config, AND name/theme_color still
// auto-fill from admin unless the merchant deliberately sets them. A malformed authored file is ignored
// (falls back to the synthesized base) so /manifest.json never breaks.
export function webManifest(input: WebManifestInput, authored?: string | null): string {
  const base = baseManifest(input);
  let overrides: Record<string, unknown> = {};
  if (typeof authored === 'string') {
    try {
      const parsed = JSON.parse(authored);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        overrides = parsed as Record<string, unknown>;
    } catch {
      // malformed authored manifest → serve the synthesized base
    }
  }
  return JSON.stringify({ ...base, ...overrides });
}

// The synthesized manifest with no authored overrides (store name + brand colour only).
export function defaultWebManifest(input: WebManifestInput): string {
  return webManifest(input);
}
