import fs from 'fs';
import path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const dataDir = path.resolve(__dirname, 'data');
const dbPath = path.join(dataDir, 'db.json');

function ensure() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify({ users: [], tenants: [], cards: [], entitlements: {}, settings: {}, characters: {}, chats: {}, assets: {} }, null, 2));
}

export function readDb() {
  ensure();
  return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

export function writeDb(db) {
  ensure();
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

export function upsertUser(email, passwordHash, tenantId) {
  const db = readDb();
  let user = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    user = { id: `u_${db.users.length+1}`, email, passwordHash, tenantId };
    db.users.push(user);
  } else {
    user.passwordHash = passwordHash;
    if (tenantId) user.tenantId = tenantId;
  }
  writeDb(db);
  return user;
}

export function getUserByEmail(email) {
  const db = readDb();
  return db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase()) || null;
}

// Entitlements
export function getEntitlements(userId) {
  const db = readDb();
  db.entitlements = db.entitlements || {};
  return db.entitlements[userId] || { plan: 'free', expiresAt: null, features: {} };
}

export function setEntitlements(userId, ent) {
  const db = readDb();
  db.entitlements = db.entitlements || {};
  db.entitlements[userId] = ent;
  writeDb(db);
}

export function listCards() {
  const db = readDb();
  db.cards = db.cards || [];
  return db.cards;
}

export function upsertCard(card) {
  const db = readDb();
  db.cards = db.cards || [];
  const i = db.cards.findIndex(c => c.code === card.code);
  if (i >= 0) db.cards[i] = card; else db.cards.push(card);
  writeDb(db);
}

// Settings
export function getUserSettings(userId) {
  const db = readDb();
  db.settings = db.settings || {};
  return db.settings[userId] || null;
}

export function saveUserSettings(userId, settingsObj) {
  const db = readDb();
  db.settings = db.settings || {};
  db.settings[userId] = settingsObj;
  writeDb(db);
}

// Characters
export function listCharacters(userId) {
  const db = readDb();
  db.characters = db.characters || {};
  return db.characters[userId] || [];
}

export function saveCharacters(userId, chars) {
  const db = readDb();
  db.characters = db.characters || {};
  db.characters[userId] = chars;
  writeDb(db);
}

export function addCharacter(userId, char) {
  const chars = listCharacters(userId);
  chars.push(char);
  saveCharacters(userId, chars);
  return char;
}

export function getCharacterByAvatar(userId, avatarUrl) {
  const chars = listCharacters(userId);
  return chars.find(c => c.avatar === avatarUrl) || null;
}

// Chats
function ensureChats(db, userId) {
  db.chats = db.chats || {};
  if (!db.chats[userId]) db.chats[userId] = {};
}

export function listCharacterChats(userId, characterId) {
  const db = readDb();
  ensureChats(db, userId);
  const byChar = db.chats[userId][characterId] || {};
  return byChar; // map of chatName -> array
}

export function saveCharacterChat(userId, characterId, chatName, messages) {
  const db = readDb();
  ensureChats(db, userId);
  if (!db.chats[userId][characterId]) db.chats[userId][characterId] = {};
  db.chats[userId][characterId][chatName] = messages;
  writeDb(db);
}

export function getCharacterChat(userId, characterId, chatName) {
  const db = readDb();
  ensureChats(db, userId);
  const byChar = db.chats[userId][characterId] || {};
  return byChar[chatName] || null;
}

export function deleteCharacterChat(userId, characterId, chatName) {
  const db = readDb();
  ensureChats(db, userId);
  if (!db.chats[userId][characterId]) return;
  delete db.chats[userId][characterId][chatName];
  writeDb(db);
}
