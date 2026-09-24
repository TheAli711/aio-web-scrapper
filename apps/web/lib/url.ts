/** True for absolute http(s) URLs — the only ones we ever render as clickable links. */
export function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}
