import { DEFAULT_SETTINGS, STORAGE_KEYS, cacheKey } from "./constants.js";

export async function getSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

export async function getCachedProfile(author, publication, maxAgeDays) {
  const key = cacheKey(author, publication);
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (!entry) return null;
  const ageMs = Date.now() - entry.savedAt;
  if (maxAgeDays > 0 && ageMs > maxAgeDays * 86400000) return null;
  return entry;
}

export async function setCachedProfile(author, publication, profile, meta) {
  const key = cacheKey(author, publication);
  const entry = { profile, meta, savedAt: Date.now() };
  await chrome.storage.local.set({ [key]: entry });
  return entry;
}

export async function clearProfileCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(STORAGE_KEYS.cachePrefix));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

export async function cacheStats() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([k]) => k.startsWith(STORAGE_KEYS.cachePrefix));
  return {
    count: entries.length,
    bytes: entries.reduce((n, [, v]) => n + JSON.stringify(v).length, 0),
  };
}
