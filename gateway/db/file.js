// File-based DB implementation (fallback when PG is not configured)
import fs from 'fs';
import path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const dataDir = path.resolve(__dirname, '../data');
const dbPath = path.join(dataDir, 'db.json');
const PRESET_DELIM = ':::';

function encodePresetKey(category, name) {
  const cat = String(category || 'openai');
  const nm = String(name || '').trim();
  return nm ? `${cat}${PRESET_DELIM}${nm}` : cat;
}

function decodePresetKey(key) {
  const raw = String(key || '');
  const idx = raw.indexOf(PRESET_DELIM);
  if (idx === -1) {
    return { category: 'openai', name: raw };
  }
  const category = raw.slice(0, idx) || 'openai';
  const name = raw.slice(idx + PRESET_DELIM.length);
  return { category, name };
}

function ensurePresetPayload(data, fallbackName) {
  if (!data || typeof data !== 'object') {
    return { name: fallbackName };
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'name')) {
    return { ...data, name: fallbackName };
  }
  return { ...data };
}

function clonePreset(data) {
  if (data === null || data === undefined) return data;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return data;
  }
}

function ensure() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify({ users: [], tenants: [], cards: [], entitlements: {}, settings: {}, characters: {}, chats: {}, assets: {}, presets: {}, worldinfo: {}, secrets: {} }, null, 2));
}

export function readDb() { ensure(); return JSON.parse(fs.readFileSync(dbPath, 'utf8')); }
export function writeDb(db) { ensure(); fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)); }

export function upsertUser(email, passwordHash, tenantId) {
  const db = readDb();
  let user = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) { user = { id: `u_${db.users.length+1}`, email, passwordHash, tenantId }; db.users.push(user); }
  else { user.passwordHash = passwordHash; if (tenantId) user.tenantId = tenantId; }
  writeDb(db); return user;
}
export function getUserByEmail(email) { const db = readDb(); return db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase()) || null; }

// Entitlements
export function getEntitlements(userId) { const db = readDb(); db.entitlements = db.entitlements || {}; return db.entitlements[userId] || { plan: 'free', expiresAt: null, features: {} }; }
export function setEntitlements(userId, ent) { const db = readDb(); db.entitlements = db.entitlements || {}; db.entitlements[userId] = ent; writeDb(db); }

// Settings
export function getUserSettings(userId) { const db = readDb(); db.settings = db.settings || {}; return db.settings[userId] || null; }
export function saveUserSettings(userId, settingsObj) { const db = readDb(); db.settings = db.settings || {}; db.settings[userId] = settingsObj; writeDb(db); }

// Characters
export function listCharacters(userId) { const db = readDb(); db.characters = db.characters || {}; return db.characters[userId] || []; }
export function saveCharacters(userId, chars) { const db = readDb(); db.characters = db.characters || {}; db.characters[userId] = chars; writeDb(db); }
export function addCharacter(userId, char) { const chars = listCharacters(userId); chars.push(char); saveCharacters(userId, chars); return char; }
export function getCharacterByAvatar(userId, avatarUrl) {
  const chars = listCharacters(userId);
  const target = String(avatarUrl || '');
  const tbase = path.basename(target);
  return chars.find(c => c.avatar === target || path.basename(String(c.avatar||'')) === tbase) || null;
}

// Chats
function ensureChats(db, userId) { db.chats = db.chats || {}; if (!db.chats[userId]) db.chats[userId] = {}; }
export function listCharacterChats(userId, characterId) { const db = readDb(); ensureChats(db, userId); return db.chats[userId][characterId] || {}; }
export function saveCharacterChat(userId, characterId, chatName, messages) { const db = readDb(); ensureChats(db, userId); if (!db.chats[userId][characterId]) db.chats[userId][characterId] = {}; if (messages === undefined) delete db.chats[userId][characterId][chatName]; else db.chats[userId][characterId][chatName] = messages; writeDb(db); }
export function getCharacterChat(userId, characterId, chatName) { const db = readDb(); ensureChats(db, userId); const byChar = db.chats[userId][characterId] || {}; return byChar[chatName] || null; }
export function deleteCharacterChat(userId, characterId, chatName) { const db = readDb(); ensureChats(db, userId); if (!db.chats[userId][characterId]) return; delete db.chats[userId][characterId][chatName]; writeDb(db); }

// Presets
export function listPresets(userId, category) {
  const db = readDb();
  db.presets = db.presets || {};
  const userMap = db.presets[userId] || {};
  const results = [];
  for (const [key, value] of Object.entries(userMap)) {
    const { category: cat, name } = decodePresetKey(key);
    if (category && cat !== category) continue;
    if (!name) continue;
    const payload = ensurePresetPayload(value, name);
    results.push(clonePreset(payload));
  }
  return results;
}

export function savePreset(userId, categoryOrName, maybeName, maybeData) {
  const useLegacy = maybeData === undefined && maybeName !== undefined;
  const category = useLegacy ? 'openai' : String(categoryOrName || 'openai');
  const name = useLegacy ? String(categoryOrName || '') : String(maybeName || '');
  const data = useLegacy ? maybeName : maybeData;
  if (!name) return;
  const key = encodePresetKey(category, name);
  const db = readDb();
  db.presets = db.presets || {};
  if (!db.presets[userId]) db.presets[userId] = {};
  db.presets[userId][key] = ensurePresetPayload(data, name);
  // Maintain legacy key for openai if present to avoid duplicates
  if (!useLegacy && category === 'openai' && db.presets[userId][name]) delete db.presets[userId][name];
  writeDb(db);
}

export function getPreset(userId, categoryOrName, maybeName) {
  const useLegacy = maybeName === undefined;
  const category = useLegacy ? 'openai' : String(categoryOrName || 'openai');
  const name = useLegacy ? String(categoryOrName || '') : String(maybeName || '');
  if (!name) return null;
  const db = readDb();
  db.presets = db.presets || {};
  const userMap = db.presets[userId] || {};
  const key = encodePresetKey(category, name);
  const found = userMap[key] || (category === 'openai' ? userMap[name] : null);
  return found ? clonePreset(ensurePresetPayload(found, name)) : null;
}

export function deletePreset(userId, categoryOrName, maybeName) {
  const useLegacy = maybeName === undefined;
  const category = useLegacy ? 'openai' : String(categoryOrName || 'openai');
  const name = useLegacy ? String(categoryOrName || '') : String(maybeName || '');
  if (!name) return;
  const db = readDb();
  db.presets = db.presets || {};
  if (!db.presets[userId]) db.presets[userId] = {};
  const key = encodePresetKey(category, name);
  delete db.presets[userId][key];
  if (category === 'openai') delete db.presets[userId][name];
  writeDb(db);
}

// World Info
export function getWorldInfo(userId) { const db = readDb(); db.worldinfo = db.worldinfo || {}; return db.worldinfo[userId] || []; }
export function saveWorldInfo(userId, items) { const db = readDb(); db.worldinfo = db.worldinfo || {}; db.worldinfo[userId] = items; writeDb(db); }

// Groups
export function listGroups(userId) { const db = readDb(); db.groups = db.groups || {}; return db.groups[userId] || []; }
export function saveGroups(userId, groups) { const db = readDb(); db.groups = db.groups || {}; db.groups[userId] = groups; writeDb(db); }
export function addGroup(userId, group) { const groups = listGroups(userId); groups.push(group); saveGroups(userId, groups); return group; }
export function getGroupById(userId, id) { const groups = listGroups(userId); return groups.find(g => String(g.id) === String(id)) || null; }
export function deleteGroup(userId, id) { const groups = listGroups(userId).filter(g => String(g.id) !== String(id)); saveGroups(userId, groups); }

// Secrets (persisted per-user)
function ensureSecrets(db, userId) { db.secrets = db.secrets || {}; if (!db.secrets[userId]) db.secrets[userId] = {}; }

export function getSecretState(userId) {
  const db = readDb();
  db.secrets = db.secrets || {};
  const map = db.secrets[userId] || {};
  // Return a deep clone to avoid accidental mutation
  return JSON.parse(JSON.stringify(map));
}

export function writeSecretValue(userId, key, value, label) {
  const db = readDb();
  ensureSecrets(db, userId);
  const id = `sec_${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`;
  const arr = Array.isArray(db.secrets[userId][key]) ? db.secrets[userId][key] : (db.secrets[userId][key] = []);
  // Deactivate all current
  arr.forEach(s => { if (s && typeof s === 'object') s.active = false; });
  const entry = { id, value, label: label || new Date().toLocaleString(), active: true };
  arr.push(entry);
  writeDb(db);
  return entry;
}

export function findSecretValue(userId, key, id) {
  const db = readDb();
  db.secrets = db.secrets || {};
  const arr = Array.isArray(db.secrets[userId]?.[key]) ? db.secrets[userId][key] : [];
  if (!arr.length) return null;
  const entry = id ? arr.find(s => s.id === id) : arr.find(s => s.active) || arr[0];
  return entry ? { id: entry.id, value: entry.value } : null;
}

export function deleteSecretValue(userId, key, id) {
  const db = readDb();
  ensureSecrets(db, userId);
  const arr = Array.isArray(db.secrets[userId][key]) ? db.secrets[userId][key] : (db.secrets[userId][key] = []);
  const idx = arr.findIndex(s => id ? s.id === id : s.active);
  if (idx !== -1) arr.splice(idx, 1);
  // Ensure at least one active if any left
  if (arr.length && !arr.some(s => s.active)) arr[0].active = true;
  if (!arr.length) delete db.secrets[userId][key];
  writeDb(db);
}

export function rotateSecretValue(userId, key, id) {
  const db = readDb();
  ensureSecrets(db, userId);
  const arr = Array.isArray(db.secrets[userId][key]) ? db.secrets[userId][key] : (db.secrets[userId][key] = []);
  const idx = arr.findIndex(s => s.id === id);
  if (idx === -1) return;
  arr.forEach(s => { if (s && typeof s === 'object') s.active = false; });
  arr[idx].active = true;
  writeDb(db);
}

export function renameSecretValue(userId, key, id, label) {
  const db = readDb();
  ensureSecrets(db, userId);
  const arr = Array.isArray(db.secrets[userId][key]) ? db.secrets[userId][key] : (db.secrets[userId][key] = []);
  const idx = arr.findIndex(s => s.id === id);
  if (idx === -1) return;
  arr[idx].label = label || arr[idx].label;
  writeDb(db);
}
