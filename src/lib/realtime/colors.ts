/** Distinct, readable colours for user identities (sketches, presence, owner tint). */
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0f9e9e', '#d6308c', '#6b8e23', '#9a6324', '#800000', '#000075', '#b8860b'];

/** Stable colour per user id (FNV-1a hash → palette index). */
export function userColor(userId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return PALETTE[(hash >>> 0) % PALETTE.length]!;
}
