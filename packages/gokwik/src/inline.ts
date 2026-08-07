// Serialize a value for injection into an inline <script>; escape `<` so a stray `</script>` in the
// data can't break out of the tag (config values come from tenant/env, not literals).
export const jsInline = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');
