#!/usr/bin/env node
// Migrate data from file DB to PostgreSQL while preserving the same API shapes
import 'dotenv/config';
import { readDb } from '../db/file.js';
import {
  upsertUser as pgUpsertUser,
  setEntitlements as pgSetEntitlements,
  saveUserSettings as pgSaveUserSettings,
  saveCharacters as pgSaveCharacters,
  saveCharacterChat as pgSaveCharacterChat,
  savePreset as pgSavePreset,
  saveWorldInfo as pgSaveWorldInfo,
} from '../db/pg.js';

async function run() {
  if (!(process.env.PG_URL || process.env.DATABASE_URL || process.env.PGHOST)) {
    console.error('[migrate] PostgreSQL connection is not configured. Set PG_URL or DATABASE_URL.');
    process.exit(1);
  }
  const src = readDb();
  console.log('[migrate] Loaded file DB');

  const users = src.users || [];
  for (const u of users) {
    const user = await pgUpsertUser(u.email, u.passwordHash || '', u.tenantId || null);
    const uid = user.id;
    const ent = (src.entitlements||{})[u.id] || { plan: 'free', expiresAt: null, features: {} };
    await pgSetEntitlements(uid, ent);
    const settings = (src.settings||{})[u.id] || null;
    if (settings) await pgSaveUserSettings(uid, settings);

    const chars = (src.characters||{})[u.id] || [];
    await pgSaveCharacters(uid, chars);

    const chatsByChar = (src.chats||{})[u.id] || {};
    for (const [charId, chatMap] of Object.entries(chatsByChar)) {
      for (const [chatName, messages] of Object.entries(chatMap||{})) {
        await pgSaveCharacterChat(uid, charId, chatName, messages);
      }
    }

    const presetsByUser = (src.presets||{})[u.id] || {};
    for (const [name, payload] of Object.entries(presetsByUser)) {
      await pgSavePreset(uid, name, payload);
    }

    const worldinfoItems = (src.worldinfo||{})[u.id] || [];
    if (worldinfoItems.length) await pgSaveWorldInfo(uid, worldinfoItems);
  }

  console.log(`[migrate] Completed migration for ${users.length} users.`);
}

run().catch((e) => { console.error('[migrate] Failed:', e); process.exit(1); });

