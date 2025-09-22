import pg from 'pg';

const connStr = process.env.PG_URL || process.env.DATABASE_URL || undefined;
const pool = new pg.Pool(connStr ? { connectionString: connStr } : undefined);

async function init() {
  await pool.query(`
    create table if not exists st_users (
      id serial primary key,
      email text unique not null,
      password_hash text not null,
      tenant_id text
    );
    create table if not exists st_entitlements (
      user_id int primary key references st_users(id) on delete cascade,
      payload jsonb not null
    );
    create table if not exists st_settings (
      user_id int primary key references st_users(id) on delete cascade,
      payload jsonb not null
    );
    create table if not exists st_characters (
      user_id int references st_users(id) on delete cascade,
      avatar text,
      payload jsonb not null,
      primary key(user_id, avatar)
    );
    create table if not exists st_chats (
      user_id int references st_users(id) on delete cascade,
      character_id text,
      chat_name text,
      messages jsonb,
      primary key(user_id, character_id, chat_name)
    );
    create table if not exists st_presets (
      user_id int references st_users(id) on delete cascade,
      name text,
      payload jsonb,
      primary key(user_id, name)
    );
    create table if not exists st_worldinfo (
      user_id int references st_users(id) on delete cascade,
      items jsonb not null,
      primary key(user_id)
    );
    create table if not exists st_groups (
      user_id int references st_users(id) on delete cascade,
      id text,
      payload jsonb,
      primary key(user_id, id)
    );
  `);
  await pool.query(`
    create index if not exists idx_characters_user_avatar on st_characters(user_id, avatar);
    create index if not exists idx_chats_user_char on st_chats(user_id, character_id);
    create index if not exists idx_presets_user_name on st_presets(user_id, name);
  `);
}

function toUser(row) { return { id: `u_${row.id}`, email: row.email, passwordHash: row.password_hash, tenantId: row.tenant_id }; }
function fromUid(uid) { return Number(String(uid||'').replace(/^u_/, '')) || null; }

export async function upsertUser(email, passwordHash, tenantId) {
  await init();
  const res = await pool.query(`insert into st_users(email, password_hash, tenant_id)
    values ($1,$2,$3)
    on conflict (email) do update set password_hash=excluded.password_hash, tenant_id=coalesce(excluded.tenant_id, st_users.tenant_id)
    returning *`, [email.toLowerCase(), passwordHash, tenantId||null]);
  return toUser(res.rows[0]);
}

export async function getUserByEmail(email) {
  await init();
  const res = await pool.query('select * from st_users where email=$1', [String(email).toLowerCase()]);
  return res.rowCount ? toUser(res.rows[0]) : null;
}

export async function getEntitlements(userId) {
  await init();
  const id = fromUid(userId);
  const res = await pool.query('select payload from st_entitlements where user_id=$1', [id]);
  return res.rowCount ? res.rows[0].payload : { plan: 'free', expiresAt: null, features: {} };
}
export async function setEntitlements(userId, ent) {
  await init();
  const id = fromUid(userId);
  await pool.query(`insert into st_entitlements(user_id,payload) values ($1,$2)
    on conflict (user_id) do update set payload=excluded.payload`, [id, ent]);
}

export async function getUserSettings(userId) {
  await init();
  const id = fromUid(userId);
  const res = await pool.query('select payload from st_settings where user_id=$1', [id]);
  return res.rowCount ? res.rows[0].payload : null;
}
export async function saveUserSettings(userId, settingsObj) {
  await init();
  const id = fromUid(userId);
  await pool.query(`insert into st_settings(user_id,payload) values ($1,$2)
    on conflict (user_id) do update set payload=excluded.payload`, [id, settingsObj]);
}

export async function listCharacters(userId) {
  await init();
  const id = fromUid(userId);
  const res = await pool.query('select payload from st_characters where user_id=$1', [id]);
  return res.rows.map(r => r.payload);
}
export async function saveCharacters(userId, chars) {
  await init();
  const id = fromUid(userId);
  await pool.query('delete from st_characters where user_id=$1', [id]);
  for (const ch of (chars||[])) {
    await pool.query('insert into st_characters(user_id, avatar, payload) values ($1,$2,$3)', [id, ch.avatar, ch]);
  }
}
export async function addCharacter(userId, char) {
  await init();
  const id = fromUid(userId);
  await pool.query('insert into st_characters(user_id, avatar, payload) values ($1,$2,$3)', [id, char.avatar, char]);
  return char;
}
export async function getCharacterByAvatar(userId, avatarUrl) {
  await init();
  const id = fromUid(userId);
  const res = await pool.query('select payload from st_characters where user_id=$1 and avatar=$2', [id, avatarUrl]);
  return res.rowCount ? res.rows[0].payload : null;
}

export async function listCharacterChats(userId, characterId) {
  await init();
  const id = fromUid(userId);
  const res = await pool.query('select chat_name, messages from st_chats where user_id=$1 and character_id=$2', [id, characterId]);
  const map = {};
  for (const r of res.rows) map[r.chat_name] = r.messages || [];
  return map;
}
export async function saveCharacterChat(userId, characterId, chatName, messages) {
  await init();
  const id = fromUid(userId);
  if (messages === undefined) {
    await pool.query('delete from st_chats where user_id=$1 and character_id=$2 and chat_name=$3', [id, characterId, chatName]);
    return;
  }
  await pool.query(`insert into st_chats(user_id, character_id, chat_name, messages) values ($1,$2,$3,$4)
    on conflict (user_id, character_id, chat_name) do update set messages=excluded.messages`, [id, characterId, chatName, messages]);
}
export async function getCharacterChat(userId, characterId, chatName) {
  await init();
  const id = fromUid(userId);
  const res = await pool.query('select messages from st_chats where user_id=$1 and character_id=$2 and chat_name=$3', [id, characterId, chatName]);
  return res.rowCount ? res.rows[0].messages : null;
}
export async function deleteCharacterChat(userId, characterId, chatName) {
  await init();
  const id = fromUid(userId);
  await pool.query('delete from st_chats where user_id=$1 and character_id=$2 and chat_name=$3', [id, characterId, chatName]);
}

export async function listPresets(userId) {
  await init();
  const id = fromUid(userId);
  const res = await pool.query('select name from st_presets where user_id=$1', [id]);
  return res.rows.map(r => r.name);
}
export async function savePreset(userId, name, data) {
  await init();
  const id = fromUid(userId);
  await pool.query(`insert into st_presets(user_id, name, payload) values ($1,$2,$3)
    on conflict (user_id, name) do update set payload=excluded.payload`, [id, name, data]);
}
export async function getPreset(userId, name) {
  await init();
  const id = fromUid(userId);
  const res = await pool.query('select payload from st_presets where user_id=$1 and name=$2', [id, name]);
  return res.rowCount ? res.rows[0].payload : null;
}
export async function deletePreset(userId, name) {
  await init();
  const id = fromUid(userId);
  await pool.query('delete from st_presets where user_id=$1 and name=$2', [id, name]);
}

export async function getWorldInfo(userId) {
  await init();
  const id = fromUid(userId);
  const res = await pool.query('select items from st_worldinfo where user_id=$1', [id]);
  return res.rowCount ? res.rows[0].items : [];
}
export async function saveWorldInfo(userId, items) {
  await init();
  const id = fromUid(userId);
  await pool.query(`insert into st_worldinfo(user_id, items) values ($1,$2)
    on conflict (user_id) do update set items=excluded.items`, [id, items]);
}

// Groups
export async function listGroups(userId) {
  await init();
  const id = fromUid(userId);
  const res = await pool.query('select payload from st_groups where user_id=$1', [id]);
  return res.rows.map(r => r.payload);
}
export async function saveGroups(userId, groups) {
  await init();
  const id = fromUid(userId);
  await pool.query('delete from st_groups where user_id=$1', [id]);
  for (const g of (groups||[])) {
    await pool.query('insert into st_groups(user_id, id, payload) values ($1,$2,$3)', [id, String(g.id), g]);
  }
}
export async function addGroup(userId, group) {
  await init();
  const id = fromUid(userId);
  await pool.query('insert into st_groups(user_id, id, payload) values ($1,$2,$3)', [id, String(group.id), group]);
  return group;
}
export async function getGroupById(userId, gid) {
  await init();
  const id = fromUid(userId);
  const res = await pool.query('select payload from st_groups where user_id=$1 and id=$2', [id, String(gid)]);
  return res.rowCount ? res.rows[0].payload : null;
}
export async function deleteGroup(userId, gid) {
  await init();
  const id = fromUid(userId);
  await pool.query('delete from st_groups where user_id=$1 and id=$2', [id, String(gid)]);
}
