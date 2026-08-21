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
export function defaultWebManifest({ name, themeColor, iconUrl }: WebManifestInput): string {
  return JSON.stringify({
    name,
    short_name: name.slice(0, 12),
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: themeColor && HEX.test(themeColor) ? themeColor : '#000000',
    icons: [{ src: iconUrl ?? '/favicon.ico', sizes: 'any', type: 'image/x-icon' }],
  });
}
