// KwikPass writes the customer access token to a cookie (+ localStorage) under one of these keys,
// per environment. The origin reads it to identify the shopper for the auth'd order API and to gate
// protected routes. (Source: SDK's own clear-storage list.)
export const KWIKPASS_TOKEN_KEYS = [
  'KWIKUSERTOKEN',
  'SANDBOXKWIKUSERTOKEN',
  'QAKWIKUSERTOKEN',
  'DEVKWIKUSERTOKEN',
] as const;

export function readCustomerToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const jar: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  for (const key of KWIKPASS_TOKEN_KEYS) {
    const v = jar[key];
    if (v) {
      try {
        return decodeURIComponent(v) || null;
      } catch {
        return v || null;
      }
    }
  }
  return null;
}
