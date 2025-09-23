import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PRESETS_DIR = path.resolve(ROOT_DIR, '..', 'SillyTavern', 'default', 'content', 'presets');
const THEMES_DIR = path.resolve(ROOT_DIR, '..', 'SillyTavern', 'default', 'content', 'themes');
const CONTENT_INDEX_PATH = path.resolve(ROOT_DIR, '..', 'SillyTavern', 'default', 'content', 'index.json');
const SETTINGS_PATH = path.resolve(ROOT_DIR, '..', 'SillyTavern', 'default', 'content', 'settings.json');

const advancedCache = new Map();
const completionCache = new Map();
const namedCollectionCache = new Map();
let defaultSettingsCache = null;
let defaultContentIndexCache = null;

function safeClone(value) {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function deepMergeDefaults(base, override) {
  if (override === null || override === undefined) {
    return safeClone(base);
  }
  if (base === null || base === undefined) {
    return safeClone(override);
  }
  if (Array.isArray(base)) {
    if (Array.isArray(override)) {
      return safeClone(override);
    }
    return safeClone(base);
  }
  if (typeof base !== 'object' || typeof override !== 'object') {
    return safeClone(override);
  }
  const result = {};
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(override || {})]);
  for (const key of keys) {
    const baseVal = base ? base[key] : undefined;
    if (!Object.prototype.hasOwnProperty.call(override, key)) {
      result[key] = safeClone(baseVal);
      continue;
    }
    const overrideVal = override[key];
    if (baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal) && overrideVal && typeof overrideVal === 'object' && !Array.isArray(overrideVal)) {
      result[key] = deepMergeDefaults(baseVal, overrideVal);
    } else if (Array.isArray(overrideVal)) {
      result[key] = safeClone(overrideVal);
    } else {
      result[key] = safeClone(overrideVal);
    }
  }
  return result;
}

function loadAdvancedCategory(category) {
  if (advancedCache.has(category)) {
    return advancedCache.get(category);
  }

  const items = [];
  try {
    const dir = path.join(PRESETS_DIR, category);
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (!parsed.name) {
            parsed.name = path.basename(file, path.extname(file));
          }
          items.push(parsed);
        }
      } catch (err) {
        console.warn(`[gateway] Failed to load default preset ${file} in ${category}:`, err?.message || err);
      }
    }
  } catch (err) {
    console.warn(`[gateway] Unable to read default presets for category ${category}:`, err?.message || err);
  }

  advancedCache.set(category, items);
  return items;
}

const COMPLETION_PRESET_CATEGORY_MAP = {
  openai: 'openai',
  kobold: 'kobold',
  novel: 'novel',
  textgenerationwebui: 'textgen',
};

const NAMED_COLLECTION_DIRS = {
  themes: THEMES_DIR,
  'moving-ui': path.join(PRESETS_DIR, 'moving-ui'),
  'quick-replies': path.join(PRESETS_DIR, 'quick-replies'),
};

function loadCompletionCategory(category) {
  if (completionCache.has(category)) {
    return completionCache.get(category);
  }
  const dirName = COMPLETION_PRESET_CATEGORY_MAP[category];
  if (!dirName) {
    completionCache.set(category, []);
    return [];
  }

  const items = [];
  try {
    const dir = path.join(PRESETS_DIR, dirName);
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const name = path.basename(file, path.extname(file));
          items.push({ name, preset: parsed });
        }
      } catch (err) {
        console.warn(`[gateway] Failed to load default completion preset ${file} in ${category}:`, err?.message || err);
      }
    }
  } catch (err) {
    console.warn(`[gateway] Unable to read default completion presets for category ${category}:`, err?.message || err);
  }

  completionCache.set(category, items);
  return items;
}

export function getDefaultPresets(category) {
  const items = loadAdvancedCategory(category);
  return items.map(item => safeClone(item));
}

export function getDefaultPreset(category, name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return null;
  const items = loadAdvancedCategory(category);
  const found = items.find(item => String(item?.name || '').trim().toLowerCase() === target);
  return found ? safeClone(found) : null;
}

export function mergeDefaultAndUserPresets(category, userItems = []) {
  const merged = new Map();
  for (const preset of getDefaultPresets(category)) {
    if (!preset || typeof preset !== 'object') continue;
    const name = String(preset.name || '').trim();
    if (!name) continue;
    merged.set(name.toLowerCase(), preset);
  }
  for (const item of Array.isArray(userItems) ? userItems : []) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!name) continue;
    merged.set(name.toLowerCase(), safeClone(item));
  }
  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

export function getDefaultCompletionPresets(category) {
  return loadCompletionCategory(category).map(entry => ({ name: entry.name, preset: safeClone(entry.preset) }));
}

export function getDefaultCompletionPreset(category, name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return null;
  const items = loadCompletionCategory(category);
  const found = items.find(item => item && String(item.name || '').trim().toLowerCase() === target);
  return found ? safeClone(found.preset) : null;
}

export function mergeDefaultAndUserCompletionPresets(category, userItems = []) {
  const merged = new Map();
  for (const entry of getDefaultCompletionPresets(category)) {
    const name = String(entry.name || '').trim();
    if (!name) continue;
    merged.set(name.toLowerCase(), { name, preset: entry.preset });
  }
  for (const item of Array.isArray(userItems) ? userItems : []) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!name) continue;
    const clone = safeClone(item);
    delete clone.name;
    merged.set(name.toLowerCase(), { name, preset: clone });
  }
  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

export function getDefaultSettings() {
  if (defaultSettingsCache) {
    return defaultSettingsCache;
  }
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      defaultSettingsCache = parsed;
      return parsed;
    }
  } catch (err) {
    console.warn('[gateway] Failed to load default settings:', err?.message || err);
  }
  defaultSettingsCache = {};
  return defaultSettingsCache;
}

export function mergeSettingsWithDefaults(settings = {}) {
  const defaults = getDefaultSettings();
  return deepMergeDefaults(defaults, settings);
}

export const ADVANCED_PRESET_CATEGORIES = ['instruct', 'context', 'sysprompt', 'reasoning'];
export const COMPLETION_PRESET_CATEGORIES = Object.keys(COMPLETION_PRESET_CATEGORY_MAP);
function loadNamedCollection(category) {
  if (namedCollectionCache.has(category)) {
    return namedCollectionCache.get(category);
  }
  const dir = NAMED_COLLECTION_DIRS[category];
  if (!dir) {
    namedCollectionCache.set(category, []);
    return [];
  }
  const items = [];
  try {
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (!parsed.name) {
            parsed.name = path.basename(file, path.extname(file));
          }
          items.push(parsed);
        }
      } catch (err) {
        console.warn(`[gateway] Failed to load default ${category} entry ${file}:`, err?.message || err);
      }
    }
  } catch (err) {
    console.warn(`[gateway] Unable to read default ${category} entries:`, err?.message || err);
  }
  namedCollectionCache.set(category, items);
  return items;
}

export function getDefaultNamedCollection(category) {
  return loadNamedCollection(category).map(item => safeClone(item));
}

export function getDefaultNamedEntry(category, name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return null;
  const items = loadNamedCollection(category);
  const found = items.find(item => item && String(item.name || '').trim().toLowerCase() === target);
  return found ? safeClone(found) : null;
}

export function mergeDefaultAndUserNamedCollection(category, userItems = []) {
  const merged = new Map();
  for (const item of getDefaultNamedCollection(category)) {
    const name = String(item?.name || '').trim();
    if (!name) continue;
    merged.set(name.toLowerCase(), item);
  }
  for (const entry of Array.isArray(userItems) ? userItems : []) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    if (!name) continue;
    merged.set(name.toLowerCase(), safeClone(entry));
  }
  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

function loadContentIndex() {
  if (defaultContentIndexCache) {
    return defaultContentIndexCache;
  }
  try {
    const raw = fs.readFileSync(CONTENT_INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      defaultContentIndexCache = parsed;
      return parsed;
    }
  } catch (err) {
    console.warn('[gateway] Failed to load default content index:', err?.message || err);
  }
  defaultContentIndexCache = [];
  return defaultContentIndexCache;
}

export function getDefaultWorldNames() {
  const index = loadContentIndex();
  const names = new Set();
  for (const item of index) {
    if (!item || typeof item !== 'object') continue;
    if (String(item.type || '').toLowerCase() !== 'world') continue;
    const base = String(item.filename || '').trim();
    if (!base) continue;
    names.add(path.basename(base, path.extname(base)));
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}
