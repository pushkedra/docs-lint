// Every answer is kept for a moment rather than for the process: the CLI ends in seconds, but an editor
// loads this once and would otherwise keep answering from the tree as it first found it.
const CACHE_MS = 2000;
let cache: { at: number; entries: Map<string, unknown> } | undefined;

export const cached = <T>(kind: string, key: string, compute: () => T): T => {
  if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), entries: new Map() };
  const full = `${kind}\0${key}`;
  if (!cache.entries.has(full)) cache.entries.set(full, compute());
  return cache.entries.get(full) as T;
};
