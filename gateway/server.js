import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import fetch, { Headers } from 'node-fetch';
import { config } from './config.js';
import { isOwned, isKilled, ownedEndpoints, killList as killListArray } from './mapping.js';
import crypto from 'crypto';
import { signToken, verifyToken } from './auth.js';
import { upsertUser, getUserByEmail, getUserSettings, saveUserSettings, listCharacters, addCharacter, getCharacterByAvatar, listCharacterChats, saveCharacterChat, getCharacterChat, deleteCharacterChat, getEntitlements, setEntitlements, saveCharacters, listPresets, savePreset, getPreset, deletePreset, getWorldInfo, saveWorldInfo, listGroups, addGroup, saveGroups, deleteGroup, getSecretState, writeSecretValue, findSecretValue, deleteSecretValue, rotateSecretValue, renameSecretValue } from './db/index.js';
import multer from 'multer';
import { makeCardPngFromFile, readCardFromPng } from './utils/pngCard.js';
import {
  ADVANCED_PRESET_CATEGORIES,
  COMPLETION_PRESET_CATEGORIES,
  mergeDefaultAndUserPresets,
  mergeDefaultAndUserCompletionPresets,
  getDefaultPreset,
  getDefaultCompletionPreset,
  mergeDefaultAndUserNamedCollection,
  getDefaultNamedEntry,
  getDefaultWorldNames,
  mergeSettingsWithDefaults,
} from './utils/defaultPresets.js';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.PORT || 3080;
const BASE_PATH = config.basePath;
const INJECT_BASE = config.injectBase;
const ROOT_DIR = path.resolve(__dirname, '..');
const ST_PUBLIC = path.resolve(ROOT_DIR, 'SillyTavern', 'public');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_HEADER_DEFAULTS = Object.freeze({
  'HTTP-Referer': config.openrouterReferer || 'https://sillytavern.app',
  'X-Title': config.openrouterTitle || 'SillyTavern',
});

const GEMINI_SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
];

// Minimal invariant checks
if (!fs.existsSync(ST_PUBLIC)) {
  console.error(`[gateway] Missing SillyTavern public dir: ${ST_PUBLIC}`);
}

const app = express();

// Large JSON payload support (e.g., very long prompts/history). Default 50mb if env not set.
const JSON_LIMIT = process.env.GATEWAY_JSON_LIMIT || '50mb';

// Logging + request id
app.use((req, res, next) => {
  res.locals.requestId = nanoid();
  res.setHeader('x-st-request-id', res.locals.requestId);
  next();
});
// Attach auth context early for logging
app.use((req, res, next) => {
  const hdr = req.headers.authorization || '';
  const token = (req.cookies && req.cookies['st_access']) || (hdr.startsWith('Bearer ') ? hdr.slice(7) : '');
  const payload = token ? verifyToken(token) : null;
  if (payload) res.locals.auth = payload; // {uid, tenantId, email}
  next();
});
morgan.token('st_uid', (req, res) => (res.locals.auth && res.locals.auth.uid) || '-');
morgan.token('st_tenant', (req, res) => (res.locals.auth && res.locals.auth.tenantId) || '-');
// Simple p95 metrics
const routeMetrics = new Map();
function recordMetric(key, ms) {
  const arr = routeMetrics.get(key) || [];
  arr.push(ms);
  if (arr.length > 500) arr.splice(0, arr.length - 500);
  routeMetrics.set(key, arr);
}
function p95(arr){ if(!arr||!arr.length) return 0; const a=[...arr].sort((a,b)=>a-b); const i=Math.floor(0.95*(a.length-1)); return a[i]; }
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - start;
    const key = `${req.method} ${req.path.split('?')[0]}`;
    recordMetric(key, dur);
  });
  next();
});
app.use(morgan(':method :url :status :res[content-length] - :response-time ms id=:req[x-st-request-id] uid=:st_uid tenant=:st_tenant', {
  stream: { write: (str) => process.stdout.write(str) },
}));
app.use(cookieParser());

// Default secret seeding helper (env driven)
function seedDefaultSecretFor(uid) {
  const defVal = process.env.DEFAULT_API_KEY || '';
  const defKey = process.env.DEFAULT_API_KEY_TYPE || '';
  if (!defVal || !defKey) return;
  try {
    const map = getSecretState(uid) || {};
    if (!Array.isArray(map[defKey]) || map[defKey].length === 0) {
      writeSecretValue(uid, defKey, defVal, 'Default');
    }
  } catch {}
}

// Seed global default for guests on startup (if configured)
try { seedDefaultSecretFor('guest'); } catch {}

// JSON error wrapper
function toJsonError(err, req, res) {
  const status = err.status || 500;
  const body = {
    error: true,
    status,
    message: err.message || 'Internal Error',
    requestId: res.locals.requestId,
  };
  res.setHeader('content-type', 'application/json; charset=utf-8');
  return res.status(status).send(body);
}

// Diagnostics helper
function setDiagnostics(res, extra = {}) {
  res.setHeader('x-st-proxy-target', extra.target || 'none');
  res.setHeader('x-st-auth-source', extra.authSource || 'none');
}

// Disable service worker under /st scope
app.get(`${BASE_PATH}/sw.js`, (_req, res) => {
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  res.send('// service worker disabled by gateway\nself.addEventListener("install", e => self.skipWaiting());\nself.addEventListener("activate", e => self.clients.claim());');
});

// Injection scripts
app.get(`${INJECT_BASE}/observer.js`, (_req, res) => {
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  res.send(`(function(){
    console.log('[inject] observer ready');
    window.__st_injected_ready = true;
    window.addEventListener('error', (e)=>{
      console.warn('[inject] window error', {message:e.message, filename:e.filename, lineno:e.lineno});
    });
    // Detect auth status for UI to distinguish guest vs logged-in
    async function detectAuth(){
      try{
        const r = await fetch('/api/auth/me', { method:'GET', credentials:'include' });
        if (r.ok) {
          const j = await r.json();
          window.__st_user = j && j.user || null;
          document.documentElement.classList.add('st-auth-logged-in');
          document.documentElement.classList.remove('st-auth-guest');
        } else {
          window.__st_user = null;
          document.documentElement.classList.add('st-auth-guest');
          document.documentElement.classList.remove('st-auth-logged-in');
        }
      } catch {
        document.documentElement.classList.add('st-auth-guest');
      }
    }
    detectAuth();
  })();`);
});

app.get(`${INJECT_BASE}/traffic.js`, (_req, res) => {
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  res.send(`(function(){
    const originalFetch = window.fetch.bind(window);
    function getCookie(name){
      const m = document.cookie.match(new RegExp('(?:^|; )'+name+'=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    }
    function withAuthHeaders(h){
      const headers = new Headers(h||{});
      const token = getCookie('st_access');
      if (token && !headers.has('Authorization')) headers.set('Authorization','Bearer '+token);
      return headers;
    }
    function getLastInput(){
      try{
        const el = document.querySelector('#send_textarea');
        if (el && typeof el.value === 'string' && el.value.trim()) return el.value.trim();
      }catch(_e){}
      // Fallback: last user bubble in chat DOM
      try{
        const nodes = document.querySelectorAll('#chat .mes[is_user="true"] .mes_text');
        for (let i = nodes.length - 1; i >= 0; i--) {
          const t = (nodes[i].innerText || nodes[i].textContent || '').trim();
          if (t) return t;
        }
      }catch(_e){}
      return '';
    }
    function maybeAttachLastInput(url, headers){
      try{
        const u = String(url||'');
        // Avoid regex literal to prevent escaping issues; simple substring check covers xhr & fetch
        if (u.indexOf('/api/backends/chat-completions/generate') !== -1){
          const last = getLastInput();
          if (last && !headers.has('x-st-last-input')){
            headers.set('x-st-last-input', encodeURIComponent(last.slice(0, 500)));
          }
        }
      }catch(_e){}
    }
    // fetch
    window.fetch = async function(input, init){
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const headers = withAuthHeaders(init && init.headers);
      maybeAttachLastInput(url, headers);
      try { return await originalFetch(input, Object.assign({}, init||{}, { headers })); }
      catch (e) { console.warn('[inject] fetch error', e); throw e; }
    };
    // XMLHttpRequest
    const OrigXHR = window.XMLHttpRequest;
    function wrapXHR(){
      const xhr = new OrigXHR();
      const _open = xhr.open; const _send = xhr.send; let _method='', _url='';
      xhr.open = function(method, url){ _method=method; _url=url; return _open.apply(xhr, arguments); };
      xhr.send = function(body){
        try{ const token = getCookie('st_access'); if (token) xhr.setRequestHeader('Authorization','Bearer '+token);}catch(_e){}
        try{ maybeAttachLastInput(_url, { has:(k)=>false, set:(k,v)=>xhr.setRequestHeader(k,v) }); }catch(_e){}
        return _send.apply(xhr, arguments);
      };
      return xhr;
    }
    window.XMLHttpRequest = wrapXHR;
    console.log('[inject] traffic hook installed (fetch + XHR)');
  })();`);
});

app.get(`${INJECT_BASE}/bridge.js`, (_req, res) => {
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  res.send(`(function(){
    console.log('[inject] bridge ready');
    // Placeholder for import/upload fallbacks
  })();`);
});

// HTML responder with injection
app.get([`${BASE_PATH}`, `${BASE_PATH}/`, `${BASE_PATH}/index.html`], (req, res, next) => {
  const indexPath = path.join(ST_PUBLIC, 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return next(Object.assign(new Error('Index not found'), { status: 500 }));
    // Inject scripts and adjust base to /st/
    let out = html
      .replace(/<head(.*?)>/i, (m) => `${m}\n  <script src="${INJECT_BASE}/observer.js"></script>\n  <script src="${INJECT_BASE}/traffic.js"></script>\n  <script src="${INJECT_BASE}/bridge.js"></script>`)
      .replace(/<base\s+href=["']\/["'][^>]*>/i, '<base href="/st/">');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // Relax CSP to allow our inject scripts and same-origin connections
    res.setHeader('content-security-policy', [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https:",
      "connect-src 'self' data: ws: wss: https:",
    ].join('; '));
    // Drop compression-related headers just in case
    res.removeHeader('content-encoding');
    res.removeHeader('content-length');
    return res.send(out);
  });
});

// Minimal login page (no upstream modification)
app.get('/st-auth', (req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <style>body{font-family:sans-serif;max-width:420px;margin:40px auto;padding:0 12px}label{display:block;margin:10px 0 4px}input{width:100%;padding:8px}button{margin-top:12px;padding:10px 16px}</style>
  </head><body>
  <h2>SillyTavern 登录</h2>
  <p style="margin-bottom:12px;color:#555">请输入邮箱和密码。若账号不存在将自动注册。卡密可选，支持后续补录。</p>
  <label>邮箱</label><input id="email" type="email" required />
  <label>密码</label><input id="password" type="password" required />
  <label>卡密（可选）</label><input id="card" placeholder="AAAA-BBBB" />
  <div><button id="btnSubmit">登录 / 注册</button> <button id="btnRedeem" type="button">仅兑换卡密</button></div>
  <p id="msg"></p>
  <script>
  (async function(){
    try{
      const r = await fetch('/api/auth/me', { method:'GET', credentials:'include' });
      if (r.ok) {
        const j = await r.json();
        document.getElementById('msg').textContent = '已登录：'+(j.user && j.user.email || '');
        setTimeout(()=>{ location.href='/st'; }, 800);
      }
    }catch{}
  })();
  async function call(url,data){
    const r = await fetch(url,{method:'POST',headers:{'content-type':'application/json'},credentials:'include',body:JSON.stringify(data)});
    const t = await r.text();
    let parsed = t;
    try { parsed = JSON.parse(t); } catch {}
    return { ok: r.ok, status: r.status, data: parsed };
  }
  function q(id){return document.getElementById(id)}
  function setMsg(text){ q('msg').textContent = text || ''; }
  function extractError(resp){
    if (resp?.data && typeof resp.data === 'object' && resp.data.message) return resp.data.message;
    if (typeof resp?.data === 'string') return resp.data;
    return '操作失败，请重试。';
  }
  async function handleSubmit(){
    setMsg('');
    const email = q('email').value.trim();
    const password = q('password').value;
    const card = q('card').value.trim();
    if (!email || !password){ setMsg('请填写邮箱和密码'); return; }
    setMsg('正在处理...');
    const login = await call('/api/auth/login',{ email, password, card: card || undefined });
    if (login.ok){
      setMsg('登录成功，正在跳转...');
      setTimeout(()=>{ location.href='/st'; }, 400);
      return;
    }
    if (login.status === 401 || login.status === 404){
      const reg = await call('/api/auth/register',{ email, password, card: card || undefined });
      if (reg.ok){
        setMsg('账号已创建，正在跳转...');
        setTimeout(()=>{ location.href='/st'; }, 400);
        return;
      }
      setMsg(extractError(reg));
      return;
    }
    setMsg(extractError(login));
  }
  async function handleRedeem(){
    setMsg('');
    const card = q('card').value.trim();
    if (!card){ setMsg('请输入卡密'); return; }
    const resp = await call('/api/cards/redeem',{ code: card });
    if (resp.ok){
      setMsg('兑换成功，权益已更新。');
    } else {
      setMsg(extractError(resp));
    }
  }
  q('btnSubmit').onclick = handleSubmit;
  q('btnRedeem').onclick = handleRedeem;
  </script>
  </body></html>`);
});

// Minimal thumbnail endpoint (compat)
app.get('/thumbnail', (req, res, next) => {
  try {
    const type = String(req.query.type || '').toLowerCase();
    const raw = String(req.query.file || '');
    if (!raw) return res.status(400).send('file required');
    const q = decodeURIComponent(raw);
    let fsPath = '';
    if (type === 'bg') {
      const managed = path.join(MANAGED_BACKGROUNDS_DIR, q);
      const builtin = path.join(ROOT_DIR, 'SillyTavern', 'default', 'content', 'backgrounds', q);
      fsPath = fs.existsSync(managed) ? managed : builtin;
    } else if (type === 'persona') {
      const auth = requireAuth(req, res);
      if (auth) {
        fsPath = path.join(__dirname, 'data', 'users', auth.uid, 'avatars', q);
      } else {
        fsPath = path.join(ST_PUBLIC, 'img', 'user-default.png');
      }
    } else if (q.startsWith('/st/default/')) {
      const rel = q.replace(/^\/st\/default\//, '');
      fsPath = path.join(ROOT_DIR, 'SillyTavern', 'default', rel);
    } else if (q.startsWith('/st/')) {
      const rel = q.replace(/^\/st\//, '');
      fsPath = path.join(ST_PUBLIC, rel);
    } else if (q.startsWith('/st-internal/assets/users/')) {
      const rel = q.replace(/^\/st-internal\/assets\/users\//, '');
      fsPath = path.join(__dirname, 'data', 'users', rel);
    } else {
      // Try persona relative in user space as a last resort
      const auth = requireAuth(req, res);
      if (auth) fsPath = path.join(__dirname, 'data', 'users', auth.uid, 'avatars', q);
    }
    if (!fsPath || !fs.existsSync(fsPath)) return res.status(404).send('Not Found');
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    return res.sendFile(fsPath);
  } catch (err) {
    return next(err);
  }
});

// Static buckets under /st -> SillyTavern/public
const buckets = ['css','js','img','images','locales','themes','assets','fonts','webfonts','backgrounds','sounds'];
for (const bucket of buckets) {
  app.use(`${BASE_PATH}/${bucket}`, express.static(path.join(ST_PUBLIC, bucket), { fallthrough: true, etag: false }));
}
// Map /st/default to SillyTavern/default (upstream content tree)
app.use(`${BASE_PATH}/default`, express.static(path.join(ROOT_DIR, 'SillyTavern', 'default'), { fallthrough: true, etag: false }));
// Managed backgrounds directory (user-managed, overrides built-ins)
const MANAGED_BACKGROUNDS_DIR = path.join(__dirname, 'data', 'backgrounds');
fs.mkdirSync(MANAGED_BACKGROUNDS_DIR, { recursive: true });

const COMPLETION_PRESET_RESPONSE_KEYS = {
  openai: { names: 'openai_setting_names', values: 'openai_settings' },
  kobold: { names: 'koboldai_setting_names', values: 'koboldai_settings' },
  novel: { names: 'novelai_setting_names', values: 'novelai_settings' },
  textgenerationwebui: { names: 'textgenerationwebui_preset_names', values: 'textgenerationwebui_presets' },
};

const PRESET_CATEGORY_ALIASES = {
  kobold: ['koboldhorde'],
  textgenerationwebui: ['textgen'],
};

function normalizePresetCategory(raw) {
  const value = String(raw || 'openai').toLowerCase();
  if (value === 'koboldhorde') return 'kobold';
  if (value === 'textgen') return 'textgenerationwebui';
  return value;
}

function getPresetCategoryVariants(category) {
  const normalized = normalizePresetCategory(category);
  const extras = PRESET_CATEGORY_ALIASES[normalized] || [];
  const expanded = [normalized, ...extras.map(normalizePresetCategory)];
  return Array.from(new Set(expanded));
}

function clonePresetEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  try {
    return JSON.parse(JSON.stringify(entry));
  } catch {
    return { ...entry };
  }
}

async function loadUserPresetList(userId, category) {
  const variants = getPresetCategoryVariants(category);
  const byName = new Map();
  for (const variant of variants) {
    try {
      const items = await listPresets(userId, variant);
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.name || '').trim();
        if (!name) continue;
        byName.set(name.toLowerCase(), clonePresetEntry(item));
      }
    } catch (err) {
      console.warn(`[gateway] Failed to load presets for ${variant}:`, err?.message || err);
    }
  }
  return Array.from(byName.values());
}

async function findUserPresetByName(userId, category, name) {
  const variants = getPresetCategoryVariants(category);
  for (const variant of variants) {
    try {
      const preset = await getPreset(userId, variant, name);
      if (preset) return preset;
    } catch (err) {
      console.warn(`[gateway] Failed to read preset ${name} for ${variant}:`, err?.message || err);
    }
  }
  return null;
}

async function deletePresetAcrossCategories(userId, category, name, { includePrimary = true } = {}) {
  const variants = getPresetCategoryVariants(category);
  const primary = normalizePresetCategory(category);
  for (const variant of variants) {
    if (!includePrimary && variant === primary) continue;
    try {
      await deletePreset(userId, variant, name);
    } catch (err) {
      console.warn(`[gateway] Failed to delete preset ${name} for ${variant}:`, err?.message || err);
    }
  }
}
// Serve managed backgrounds with fallback to default bundled backgrounds
app.use(`${BASE_PATH}/backgrounds`, (req, res, next) => {
  const rel = decodeURIComponent(String(req.path || '').replace(/^\//, ''));
  const managed = path.join(MANAGED_BACKGROUNDS_DIR, rel);
  if (fs.existsSync(managed) && fs.statSync(managed).isFile()) {
    return res.sendFile(managed);
  }
  const builtin = path.join(ROOT_DIR, 'SillyTavern', 'default', 'content', 'backgrounds', rel);
  if (fs.existsSync(builtin) && fs.statSync(builtin).isFile()) {
    return res.sendFile(builtin);
  }
  return next();
});
// Map absolute /lib and /lib.js for assets referenced by absolute path
app.use('/lib', express.static(path.join(ST_PUBLIC, 'lib'), { fallthrough: true, etag: false }));
let libJsCache = null;
async function buildLibJs(p) {
  if (libJsCache) return libJsCache;
  // Alias problematic node-only deps (like chalk) to lightweight browser shims
  const aliasChalkPlugin = {
    name: 'alias-chalk',
    setup(build) {
      build.onResolve({ filter: /^chalk$/ }, () => ({ path: 'chalk-shim', namespace: 'shim' }));
      build.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
        contents: "const p=s=>s; const c={blue:p,green:p,red:p,yellow:p,cyan:p,magenta:p,gray:p,white:p,black:p,bgBlue:p,bgGreen:p,bgRed:p}; export default c; export const blue=p, green=p, red=p, yellow=p, cyan=p, magenta=p, gray=p, white=p, black=p;",
        loader: 'js',
      }));
    },
  };
  const result = await esbuild.build({
    entryPoints: [p],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    absWorkingDir: path.join(ROOT_DIR, 'SillyTavern'),
    nodePaths: [
      path.join(ROOT_DIR, 'SillyTavern', 'node_modules'),
      path.join(__dirname, 'node_modules'),
    ],
    sourcemap: false,
    plugins: [aliasChalkPlugin],
  });
  libJsCache = result.outputFiles[0].text;
  return libJsCache;
}
async function sendBundledLibJs(res, p) {
  try {
    const code = await buildLibJs(p);
    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    res.send(code);
  } catch {
    // Fallback to minimal shim rewriting if bundling fails
    let code = fs.readFileSync(p, 'utf8');
    code = code.replace(/from\s+['\"]chalk['\"]/g, "from '/st-inject/chalk-shim.js'");
    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    res.send(code);
  }
}

app.get('/lib.js', async (req, res, next) => {
  try {
    const srcPath = path.join(ST_PUBLIC, 'lib.js');
    if (!fs.existsSync(srcPath)) return next();
    return await sendBundledLibJs(res, srcPath);
  } catch (err) {
    return next(err);
  }
});

app.get(`${BASE_PATH}/lib.js`, async (req, res, next) => {
  try {
    const srcPath = path.join(ST_PUBLIC, 'lib.js');
    if (!fs.existsSync(srcPath)) return next();
    return await sendBundledLibJs(res, srcPath);
  } catch (err) {
    return next(err);
  }
});

// Simple shim for chalk in browsers
app.get('/st-inject/chalk-shim.js', (_req, res) => {
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  res.send(`const p=s=>s; const c={blue:p,green:p,red:p,yellow:p,cyan:p,magenta:p,gray:p,white:p,black:p,bgBlue:p,bgGreen:p,bgRed:p}; export default c; export const blue=p, green=p, red=p, yellow=p, cyan=p, magenta=p, gray=p, white=p, black=p;`);
});
// Also expose everything in public as a fallback
app.use(`${BASE_PATH}`, express.static(ST_PUBLIC, { fallthrough: true, etag: false }));
// Also expose locales at root for legacy absolute paths
app.use('/locales', express.static(path.join(ST_PUBLIC, 'locales'), { fallthrough: true, etag: false }));
// Expose scripts at root for absolute-path fetches (templates, etc.)
app.use('/scripts', express.static(path.join(ST_PUBLIC, 'scripts'), { fallthrough: true, etag: false }));
// Additional absolute mounts for assets referenced without /st base
for (const root of ['img','images','css','fonts','webfonts']) {
  app.use(`/${root}`, express.static(path.join(ST_PUBLIC, root), { fallthrough: true, etag: false }));
}

// Locales case-insensitive + regional alias fallback
app.get(`${BASE_PATH}/locales/:file`, (req, res, next) => {
  const reqNameRaw = String(req.params.file || '');
  const dir = path.join(ST_PUBLIC, 'locales');
  function candidates(name) {
    const base = name.replace(/\.json$/i, '');
    const exts = ['.json', ''];
    const alts = [base, base.replace('-', '_').toLowerCase(), base.replace('_', '-').toLowerCase(), base.toLowerCase()];
    const uniq = Array.from(new Set(alts));
    const out = [];
    for (const a of uniq) for (const e of exts) out.push(a + e);
    return out;
  }
  fs.readdir(dir, (err, files) => {
    if (err) return next();
    const lowered = files.map(f => ({ f, l: f.toLowerCase() }));
    const cands = candidates(reqNameRaw);
    const hit = cands.map(c => lowered.find(x => x.l === c.toLowerCase())).find(Boolean);
    if (!hit) return next();
    res.sendFile(path.join(dir, hit.f));
  });
});

// API: ping
app.all(['/api/ping', `${BASE_PATH}/api/ping`], (req, res) => {
  setDiagnostics(res, { target: 'gateway', authSource: 'none' });
  res.json({ ok: true, time: Date.now() });
});

// Version endpoint expected by client
app.get(['/version', `${BASE_PATH}/version`], (req, res) => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'SillyTavern', 'package.json'), 'utf8'));
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    res.json({ agent: 'gateway', pkgVersion: pkg.version || 'dev' });
  } catch {
    res.json({ agent: 'gateway', pkgVersion: 'dev' });
  }
});

// Basic auth endpoints (Stage 1 scaffolding)
app.post('/api/auth/register', express.json(), async (req, res) => {
  const { email, password, card } = req.body || {};
  if (!email || !password) return toJsonError(Object.assign(new Error('email and password required'), { status: 400 }), req, res);
  const passHash = crypto.createHash('sha256').update(String(password)).digest('hex');
  const tenantId = `t_default`; // placeholder; extend to real multi-tenant
  const user = await upsertUser(String(email), passHash, tenantId);
  let ent = await getEntitlements(user.id);
  try {
    if (card && String(card).trim()) {
      ent = await redeemCardForUser(user.id, card);
    } else if (!ent?.expiresAt || new Date(ent.expiresAt).getTime() < Date.now()) {
      const now = Date.now();
      const trialExpiry = new Date(now + 7 * 24 * 3600 * 1000);
      ent = { plan: 'trial', expiresAt: trialExpiry.toISOString(), features: { uploads: false } };
      await setEntitlements(user.id, ent);
    }
  } catch (err) {
    const status = err?.status || 400;
    return toJsonError(Object.assign(new Error(err?.message || 'Redeem failed'), { status }), req, res);
  }
  try { seedDefaultSecretFor(user.id); } catch {}
  const token = signToken({ uid: user.id, tenantId, email: user.email, iat: Date.now() });
  res.cookie('st_access', token, { httpOnly: false, sameSite: 'lax' });
  setDiagnostics(res, { target: 'compat', authSource: 'register' });
  return res.json({ ok: true, user: { id: user.id, email: user.email, tenantId }, token, entitlements: ent });
});

app.post('/api/auth/login', express.json(), async (req, res) => {
  const { email, password, card } = req.body || {};
  if (!email || !password) return toJsonError(Object.assign(new Error('email and password required'), { status: 400 }), req, res);
  const u = await getUserByEmail(String(email));
  if (!u) return toJsonError(Object.assign(new Error('invalid credentials'), { status: 401 }), req, res);
  const passHash = crypto.createHash('sha256').update(String(password)).digest('hex');
  if (u.passwordHash !== passHash) return toJsonError(Object.assign(new Error('invalid credentials'), { status: 401 }), req, res);
  // enforce entitlement for login
  const trimmedCard = card && String(card).trim();
  let ent = await getEntitlements(u.id);
  const now = Date.now();
  const expiry = ent && ent.expiresAt ? new Date(ent.expiresAt).getTime() : 0;
  const valid = expiry > now;
  if (!valid && trimmedCard) {
    try {
      ent = await redeemCardForUser(u.id, trimmedCard);
    } catch (err) {
      const status = err?.status || 400;
      return toJsonError(Object.assign(new Error(err?.message || 'Redeem failed'), { status }), req, res);
    }
  } else if (!valid && config.enforceRightsOnLogin) {
    return toJsonError(Object.assign(new Error('Payment required: please redeem card code'), { status: 402 }), req, res);
  } else if (valid && trimmedCard) {
    try {
      ent = await redeemCardForUser(u.id, trimmedCard);
    } catch (err) {
      const status = err?.status || 400;
      return toJsonError(Object.assign(new Error(err?.message || 'Redeem failed'), { status }), req, res);
    }
  }
  const token = signToken({ uid: u.id, tenantId: u.tenantId || 't_default', email: u.email, iat: Date.now() });
  res.cookie('st_access', token, { httpOnly: false, sameSite: 'lax' });
  setDiagnostics(res, { target: 'compat', authSource: 'login' });
  return res.json({ ok: true, user: { id: u.id, email: u.email, tenantId: u.tenantId }, token, entitlements: ent });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies && req.cookies['st_access'];
  const payload = verifyToken(token);
  if (!payload) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true, user: { id: payload.uid, email: payload.email, tenantId: payload.tenantId } });
});

// Users API minimal stubs
app.get('/api/users/me', (req, res) => {
  const auth = requireAuth(req, res);
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  return res.json({ handle: auth ? (auth.email || 'user') : 'guest', admin: true });
});

// Metrics endpoint (before catch-alls)
app.get('/_diagnostics/metrics', (req, res) => {
  const out = {};
  for (const [k, arr] of routeMetrics.entries()) {
    out[k] = { count: arr.length, p95: Number(p95(arr).toFixed(1)) };
  }
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  res.json({ routes: out });
});

// Diagnostics (register before catch-all)
app.get('/api/_diagnostics/state', (req, res) => {
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  res.json({
    killListEnabled: config.killListEnabled,
    enableUpstreamFallback: config.enableUpstreamFallback,
    upstreamBase: config.upstreamBase,
    ownedEndpoints,
    killList: killListArray,
    metrics: '/_diagnostics/metrics'
  });
});

app.post('/api/_diagnostics/toggle', express.json(), (req, res) => {
  const { killListEnabled, enableUpstreamFallback, upstreamBase } = req.body || {};
  if (typeof killListEnabled === 'boolean') config.killListEnabled = killListEnabled;
  if (typeof enableUpstreamFallback === 'boolean') config.enableUpstreamFallback = enableUpstreamFallback;
  if (typeof upstreamBase === 'string') config.upstreamBase = upstreamBase;
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  res.json({ ok: true, config: { killListEnabled: config.killListEnabled, enableUpstreamFallback: config.enableUpstreamFallback, upstreamBase: config.upstreamBase } });
});

app.get('/api/_diagnostics/radar', (req, res) => {
  try {
    const logDir = path.resolve(__dirname, 'logs');
    const p = path.join(logDir, 'radar.log');
    const tail = Number(req.query.tail || 200);
    const data = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').slice(-tail) : [];
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    res.json({ lines: data });
  } catch {
    return toJsonError(Object.assign(new Error('Failed to read radar'), { status: 500 }), req, res);
  }
});

app.delete('/api/_diagnostics/radar', (req, res) => {
  try {
    const logDir = path.resolve(__dirname, 'logs');
    const p = path.join(logDir, 'radar.log');
    if (fs.existsSync(p)) fs.unlinkSync(p);
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    res.json({ ok: true });
  } catch {
    return toJsonError(Object.assign(new Error('Failed to clear radar'), { status: 500 }), req, res);
  }
});

// Revoke current user's rights (diagnostics helper)
app.post('/api/_diagnostics/revoke-rights', (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const ent = { plan: 'free', expiresAt: new Date(0).toISOString(), features: {} };
  Promise.resolve(setEntitlements(auth.uid, ent))
    .then(() => { setDiagnostics(res, { target: 'compat', authSource: 'cookie' }); res.json({ ok: true }); })
    .catch(() => toJsonError(Object.assign(new Error('Failed to revoke'), { status: 500 }), req, res));
});

// Require auth helper
function requireAuth(req, res) {
  const token = req.cookies && req.cookies['st_access'];
  const payload = verifyToken(token);
  if (!payload) return null;
  return payload; // {uid, tenantId, email}
}

async function redeemCardForUser(userId, rawCode) {
  const code = String(rawCode || '').trim();
  if (!code) {
    const err = new Error('card code required');
    err.status = 400;
    throw err;
  }
  const now = Date.now();
  const prev = await getEntitlements(userId);
  const currentExpiry = prev?.expiresAt ? new Date(prev.expiresAt).getTime() : now;
  const nextExpiry = new Date(Math.max(now, currentExpiry) + 30 * 24 * 3600 * 1000);
  const ent = { plan: 'pro', expiresAt: nextExpiry.toISOString(), features: { uploads: true } };
  await setEntitlements(userId, ent);
  return ent;
}

// Rights and card codes
app.get('/api/rights', async (req, res) => {
  const auth = requireAuth(req, res);
  const ent = auth ? await getEntitlements(auth.uid) : { plan: 'free', expiresAt: null, features: {} };
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  return res.json(ent);
});

app.post('/api/cards/redeem', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  try {
    const ent = await redeemCardForUser(auth.uid, req.body?.code);
    setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
    return res.json({ ok: true, entitlements: ent });
  } catch (err) {
    const status = err?.status || 400;
    return toJsonError(Object.assign(new Error(err?.message || 'Redeem failed'), { status }), req, res);
  }
});

// Settings
app.post('/api/settings/get', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  const storedSettings = auth ? await getUserSettings(auth.uid) : null;
  const mergedSettings = mergeSettingsWithDefaults(storedSettings || {});

  if (auth) {
    if (!storedSettings) {
      mergedSettings.firstRun = true;
    }
    const defaultName = mergedSettings.username || '';
    if (!defaultName || defaultName === 'User') {
      const derived = auth.email ? auth.email.split('@')[0] : '';
      if (derived) mergedSettings.username = derived;
    }
  } else {
    mergedSettings.username = mergedSettings.username || 'Guest';
  }

  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });

  const payload = {
    settings: JSON.stringify(mergedSettings),
    enable_accounts: true,
    enable_extensions: false,
    enable_extensions_auto_update: false,
  };

  for (const category of ADVANCED_PRESET_CATEGORIES) {
    try {
      const userItems = auth ? await loadUserPresetList(auth.uid, category) : [];
      payload[category] = mergeDefaultAndUserPresets(category, userItems);
    } catch (err) {
      console.warn(`[gateway] Failed to load presets for ${category}:`, err?.message || err);
      payload[category] = mergeDefaultAndUserPresets(category, []);
    }
  }

  for (const category of COMPLETION_PRESET_CATEGORIES) {
    const responseKeys = COMPLETION_PRESET_RESPONSE_KEYS[category];
    if (!responseKeys) continue;
    try {
      const userItems = auth ? await loadUserPresetList(auth.uid, category) : [];
      const merged = mergeDefaultAndUserCompletionPresets(category, userItems);
      payload[responseKeys.names] = merged.map(entry => entry.name);
      payload[responseKeys.values] = merged.map(entry => JSON.stringify(entry.preset));
    } catch (err) {
      console.warn(`[gateway] Failed to build preset payload for ${category}:`, err?.message || err);
      const fallback = mergeDefaultAndUserCompletionPresets(category, []);
      payload[responseKeys.names] = fallback.map(entry => entry.name);
      payload[responseKeys.values] = fallback.map(entry => JSON.stringify(entry.preset));
    }
  }

  const namedCollectionPayloads = {
    themes: 'themes',
    'moving-ui': 'movingUIPresets',
    'quick-replies': 'quickReplyPresets',
  };

  for (const [category, key] of Object.entries(namedCollectionPayloads)) {
    try {
      const userItems = auth ? await loadUserPresetList(auth.uid, category) : [];
      payload[key] = mergeDefaultAndUserNamedCollection(category, userItems);
    } catch (err) {
      console.warn(`[gateway] Failed to build collection payload for ${category}:`, err?.message || err);
      payload[key] = mergeDefaultAndUserNamedCollection(category, []);
    }
  }

  const worldNameSet = new Set(getDefaultWorldNames());
  if (auth) {
    try {
      const items = await getWorldInfo(auth.uid);
      for (const entry of Array.isArray(items) ? items : []) {
        const name = String(entry?.name || entry?.id || '').trim();
        if (name) worldNameSet.add(name);
      }
    } catch (err) {
      console.warn('[gateway] Failed to load user world info names:', err?.message || err);
    }
  }
  payload.world_names = Array.from(worldNameSet).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

  return res.json(payload);
});

app.post('/api/settings/save', express.json({ limit: '2mb' }), async (req, res) => {
  const auth = requireAuth(req, res);
  const payload = req.body || {};
  if (!auth) {
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    return res.json({ ok: true });
  }
  await saveUserSettings(auth.uid, payload);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

function extractPresetName(raw) {
  return String(raw || '').trim();
}

async function persistNamedPreset(req, res, handler) {
  const auth = requireAuth(req, res);
  if (!auth) {
    return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  }
  try {
    await handler(auth.uid);
    setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
    return res.json({ ok: true });
  } catch (err) {
    const status = err?.status || 500;
    return toJsonError(Object.assign(new Error(err?.message || 'Operation failed'), { status }), req, res);
  }
}

app.post('/api/themes/save', express.json({ limit: '1mb' }), async (req, res) => {
  const theme = req.body || {};
  const name = extractPresetName(theme.name);
  if (!name) {
    return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  }
  await persistNamedPreset(req, res, uid => savePreset(uid, 'themes', name, theme));
});

app.post('/api/themes/delete', express.json(), async (req, res) => {
  const name = extractPresetName(req.body?.name);
  if (!name) {
    return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  }
  await persistNamedPreset(req, res, uid => deletePreset(uid, 'themes', name));
});

app.post('/api/moving-ui/save', express.json({ limit: '1mb' }), async (req, res) => {
  const preset = req.body || {};
  const name = extractPresetName(preset.name);
  if (!name) {
    return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  }
  await persistNamedPreset(req, res, uid => savePreset(uid, 'moving-ui', name, preset));
});

app.post('/api/quick-replies/save', express.json({ limit: '1mb' }), async (req, res) => {
  const preset = req.body || {};
  const name = extractPresetName(preset.name);
  if (!name) {
    return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  }
  await persistNamedPreset(req, res, uid => savePreset(uid, 'quick-replies', name, preset));
});

app.post('/api/quick-replies/delete', express.json(), async (req, res) => {
  const name = extractPresetName(req.body?.name);
  if (!name) {
    return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  }
  await persistNamedPreset(req, res, uid => deletePreset(uid, 'quick-replies', name));
});

// CSRF token compatibility endpoint
app.get('/csrf-token', (req, res) => {
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  return res.json({ token: 'disabled' });
});

// Characters minimal compat
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// Secrets API (persistent per-user)
app.post('/api/secrets/read', (req, res) => {
  const auth = requireAuth(req, res);
  const uid = auth?.uid || 'guest';
  try { seedDefaultSecretFor(uid); } catch {}
  const state = getSecretState(uid) || {};
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  return res.json(state);
});
app.post('/api/secrets/find', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  const uid = auth?.uid || 'guest';
  const { key, id } = req.body || {};
  if (!key) return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  const found = findSecretValue(uid, String(key), id ? String(id) : undefined);
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  return res.json({ value: found?.value ?? null, id: found?.id ?? null });
});
app.post('/api/secrets/write', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  const uid = auth?.uid || 'guest';
  const { key, value, label } = req.body || {};
  if (!key || typeof value !== 'string') return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  const entry = writeSecretValue(uid, String(key), String(value), label ? String(label) : undefined);
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  return res.json({ id: entry.id });
});
app.post('/api/secrets/delete', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  const uid = auth?.uid || 'guest';
  const { key, id } = req.body || {};
  if (!key) return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  deleteSecretValue(uid, String(key), id ? String(id) : undefined);
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  return res.json({ ok: true });
});
app.post('/api/secrets/rename', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  const uid = auth?.uid || 'guest';
  const { key, id, label } = req.body || {};
  if (!key || !id || typeof label !== 'string') return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  renameSecretValue(uid, String(key), String(id), String(label));
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  return res.json({ ok: true });
});
app.post('/api/secrets/rotate', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  const uid = auth?.uid || 'guest';
  const { key, id } = req.body || {};
  if (!key || !id) return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  rotateSecretValue(uid, String(key), String(id));
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  return res.json({ ok: true });
});
app.post('/api/secrets/view', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  const uid = auth?.uid || 'guest';
  const state = getSecretState(uid) || {};
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  return res.json(state);
});

// Personas / avatars minimal API
app.post('/api/avatars/get', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) {
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    return res.json([]);
  }
  const dir = path.join(__dirname, 'data', 'users', auth.uid, 'avatars');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile()); } catch {}
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json(files);
});

app.post('/api/avatars/upload', upload.single('avatar'), (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  if (!req.file) return toJsonError(Object.assign(new Error('avatar required'), { status: 400 }), req, res);
  const uid = auth.uid;
  const userDir = path.join(__dirname, 'data', 'users', uid, 'avatars');
  fs.mkdirSync(userDir, { recursive: true });
  const overwrite = String(req.body?.overwrite_name || '').trim();
  const baseName = overwrite || `user_${Date.now().toString(36)}.png`;
  const safeName = baseName.replace(/[^A-Za-z0-9._-]+/g, '_');
  const dst = path.join(userDir, safeName);
  try { fs.copyFileSync(req.file.path, dst); } catch {
    return toJsonError(Object.assign(new Error('Upload failed'), { status: 500 }), req, res);
  }
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  res.json({ ok: true, path: safeName, url: `/st-internal/assets/users/${uid}/avatars/${safeName}` });
});

app.post('/api/avatars/delete', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const uid = auth.uid;
  const avatar = String(req.body?.avatar || '');
  if (!avatar) return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  const file = path.join(__dirname, 'data', 'users', uid, 'avatars', path.basename(avatar));
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  res.json({ ok: true });
});

// Generic tokenizer encode/decode/count stubs
function approxTokenize(text) {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  return tokens.map((w, i) => (Math.abs(murmur(w) % 10000)) + 1);
}
function murmur(str){
  let h = 0; for (let i=0;i<str.length;i++){ h = Math.imul(31, h) + str.charCodeAt(i) | 0; } return h;
}
app.post('/api/tokenizers/:kind/:action', express.json(), (req, res, next) => {
  const { action } = req.params;
  const body = req.body || {};
  try {
    if (action === 'encode') {
      const text = typeof body === 'string' ? body : (body.text || body.content || '');
      const ids = approxTokenize(text);
      setDiagnostics(res, { target: 'compat', authSource: 'none' });
      return res.json({ ids, chunks: [{ ids, text }] });
    }
    if (action === 'decode') {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const text = ids.map(n => 't').join(' ');
      setDiagnostics(res, { target: 'compat', authSource: 'none' });
      return res.json({ text });
    }
    if (action === 'count') {
      const text = body.text || '';
      const count = Math.ceil(String(text).length / 4);
      setDiagnostics(res, { target: 'compat', authSource: 'none' });
      return res.json({ count });
    }
  } catch {
    return toJsonError(Object.assign(new Error('Tokenizer error'), { status: 500 }), req, res);
  }
  return next();
});

// Remote tokenizer proxy stubs
app.post('/api/tokenizers/remote/:service/encode', express.json(), (req, res) => {
  // Accept any shape and return a simple count/ids
  const text = (req.body && (req.body.text || req.body.prompt || '')) || '';
  const ids = approxTokenize(text);
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  return res.json({ count: ids.length, ids });
});

// Tokenizer stubs (OpenAI-compatible)
app.post('/api/tokenizers/openai/count', express.json(), async (req, res) => {
  try {
    // Body is an array of chat messages; do a simple heuristic: ~4 chars per token
    const arr = Array.isArray(req.body) ? req.body : [];
    const text = arr.map(m => (m && (m.content || m.text || ''))).join(' ');
    const approx = Math.max(0, Math.ceil(String(text).length / 4));
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    return res.json({ token_count: approx });
  } catch {
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    return res.json({ token_count: 0 });
  }
});

// Chat Completions backend stubs (OpenAI-compatible shape)
app.post('/api/backends/chat-completions/status', express.json(), (req, res) => {
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  res.json({ ok: true, provider: 'stub', online: true });
});

// Text Completions backend stubs (OOBA-compatible minimal)
app.post('/api/backends/text-completions/status', express.json(), (req, res) => {
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  res.json({ ok: true, result: 'Connected' });
});

app.post('/api/backends/text-completions/generate', express.json({ limit: '1mb' }), (req, res) => {
  const body = req.body || {};
  const prompt = String(body.prompt || '').trim();
  const reply = prompt ? `（演示文本回复）${prompt}` : '（演示文本回复）准备就绪。';
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  res.json({ choices: [{ text: reply }], content: reply });
});

// -----------------------------
// Batch stubs for optional APIs
// -----------------------------
function ok(res, payload = { ok: true }) { setDiagnostics(res, { target: 'compat', authSource: 'none' }); return res.json(payload); }

// Users management (admin flows)
for (const p of ['backup','change-avatar','change-name','change-password','create','delete','demote','disable','enable','get','list','login','logout','promote','recover-step1','recover-step2','reset-settings','reset-step1','reset-step2','slugify']) {
  app.post(`/api/users/${p}`, express.json({ limit: '1mb' }), (req, res) => ok(res));
}

// Settings snapshots
for (const p of ['get-snapshots','load-snapshot','make-snapshot','restore-snapshot']) {
  app.post(`/api/settings/${p}`, express.json(), (req, res) => ok(res, p === 'get-snapshots' ? { ok: true, snapshots: [] } : { ok: true }));
}

// Secrets extra ops
for (const p of ['delete','rename','rotate','view','write']) {
  app.post(`/api/secrets/${p}`, express.json({ limit: '1mb' }), (req, res) => ok(res));
}

// Extensions maintenance
for (const p of ['update','delete','move','version','branches','switch','install']) {
  app.post(`/api/extensions/${p}`, express.json({ limit: '1mb' }), (req, res) => ok(res));
}

// SD / image generation ecosystem (placeholders)
const sdPaths = [
  'aimlapi/generate-image','aimlapi/models','bfl/generate','comfy/delete-workflow','comfy/generate','comfy/models','comfy/ping','comfy/samplers','comfy/save-workflow','comfy/schedulers','comfy/vaes','comfy/workflow','comfy/workflows','drawthings/generate','drawthings/get-model','drawthings/get-upscaler','drawthings/ping','electronhub/generate','electronhub/models','electronhub/sizes','falai/generate','falai/models','generate','get-model','huggingface/generate','models','nanogpt/generate','nanogpt/models','ping','pollinations/generate','pollinations/models','samplers','schedulers','sd-next/upscalers','set-model','stability/generate','together/generate','together/models','upscalers','vaes','xai/generate'
];
for (const p of sdPaths) {
  app.post(`/api/sd/${p}`, express.json({ limit: '2mb' }), (req, res) => ok(res));
}

// Horde placeholders
for (const p of ['cancel-task','caption-image','generate-image','generate-text','sd-models','sd-samplers','status','task-status','text-models','text-workers','user-info']) {
  app.post(`/api/horde/${p}`, express.json({ limit: '2mb' }), (req, res) => ok(res));
}

// Google images/TTS placeholders
for (const p of ['generate-image','generate-native-tts','generate-voice','list-native-voices','list-voices']) {
  app.post(`/api/google/${p}`, express.json({ limit: '2mb' }), (req, res) => ok(res));
}

// Azure placeholders
for (const p of ['list','generate']) {
  app.post(`/api/azure/${p}`, express.json({ limit: '2mb' }), (req, res) => ok(res));
}

// OpenAI media placeholders
for (const p of ['generate-image','generate-voice','custom/generate-voice']) {
  app.post(`/api/openai/${p}`, express.json({ limit: '2mb' }), (req, res) => ok(res));
}

// Speech & Pollinations
for (const p of ['pollinations/generate','pollinations/voices']) {
  app.post(`/api/speech/${p}`, express.json({ limit: '2mb' }), (req, res) => ok(res));
}

// Translation proxies
for (const p of ['bing','deepl','deeplx','google','libre','lingva','onering','yandex']) {
  app.post(`/api/translate/${p}`, express.json({ limit: '1mb' }), (req, res) => ok(res, { ok: true, text: String(req.body?.text || '') }));
}

// Plugins & Office & Fandom probes
for (const p of ['edge-tts/probe','office/probe','office/parse','fandom/probe','fandom/probe-mediawiki','fandom/scrape','fandom/scrape-mediawiki']) {
  app.post(`/api/plugins/${p}`, express.json({ limit: '2mb' }), (req, res) => ok(res));
}

// Sprites
for (const op of ['delete']) {
  app.post(`/api/sprites/${op}`, express.json({ limit: '1mb' }), (req, res) => ok(res));
}

// Stats
for (const p of ['get','recreate','update']) {
  app.post(`/api/stats/${p}`, express.json(), (req, res) => ok(res));
}

// Vector DB minimal stubs
app.post('/api/vector/list', express.json(), (req, res) => ok(res, { ok: true, vectors: [] }));
for (const p of ['insert','delete','purge','purge-all']) app.post(`/api/vector/${p}`, express.json({ limit: '2mb' }), (req, res) => ok(res));
for (const p of ['query','query-multi']) app.post(`/api/vector/${p}`, express.json({ limit: '2mb' }), (req, res) => ok(res, { ok: true, results: [] }));

// Content import
for (const p of ['importURL','importUUID']) app.post(`/api/content/${p}`, express.json({ limit: '1mb' }), (req, res) => ok(res));

// Chats import (file upload)
app.post('/api/chats/import', upload.single('file'), (req, res) => ok(res));

// Simple in-memory last-LLM diagnostics
let __LAST_LLM_DIAG = null;

function buildOpenRouterTransforms(mode) {
  const value = String(mode || '').toLowerCase();
  if (!value || value === 'auto') return undefined;
  if (value === 'on') return ['middle-out'];
  if (value === 'off') return [];
  return undefined;
}

function buildOpenRouterPlugins(enableWebSearch) {
  return enableWebSearch ? [{ id: 'web' }] : [];
}

app.post('/api/backends/chat-completions/generate', express.json({ limit: JSON_LIMIT }), async (req, res) => {
  try {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const source = String(body.chat_completion_source || '').toLowerCase();
    const model = String(body.model || 'stub');
    const stream = !!body.stream;

    // If Google AI Studio (Makersuite) or model is gemini*, proxy to Generative Language API
    const isGemini = source === 'makersuite' || /^gemini/i.test(model);
    if (isGemini) {
      async function fetchWithRetries(url, options) {
        const retries = Math.max(0, Number(config.geminiRetryCount||0));
        const delay = Math.max(0, Number(config.geminiRetryDelayMs||0));
        let lastTxt = '';
        let lastStatus = 0;
        let lastErrTxt = '';
        for (let i=0;i<=retries;i++) {
          try {
            const r = await fetch(url, options);
            lastStatus = r.status;
            lastTxt = await r.text();
            if (r.ok) return { ok:true, status:r.status, text:lastTxt };
            // Retry on 429/5xx/UNAVAILABLE
            if (i < retries && (r.status===429 || (r.status>=500 && r.status<=599))) {
              await new Promise(res=>setTimeout(res, delay * Math.pow(2,i)));
              continue;
            }
            return { ok:false, status:r.status, text:lastTxt };
          } catch (err) {
            lastErrTxt = err && typeof err.message === 'string' ? err.message : '';
            if (i < retries) {
              await new Promise(res=>setTimeout(res, delay * Math.pow(2,i)));
              continue;
            }
            break;
          }
        }
        const fallbackText = lastTxt || lastErrTxt || 'request failed';
        return { ok:false, status:lastStatus, text:fallbackText };
      }
      // Math/Story intent detectors used for anchoring/short-circuit and guidance
      function isMathIntentText(s) {
        try { return /只回答数字|只输出|=\?|[\d\s\+\-\/*()=]{3,}/.test(String(s||'')); } catch { return false; }
      }
      function isStoryIntentText(s) {
        try {
          const t = String(s||'');
          return /(剧情推进|继续剧情|推进剧情|采取行动|继续(?!\S)|继续下去|继续写|接着|推动剧情|推进|展开(剧情|故事)?|下一步|采取(行动|下一步))/.
            test(t);
        } catch { return false; }
      }
      function tryEvalMath(expr) {
        try {
          const s = String(expr||'').replace(/，/g, ',').replace(/．/g,'.');
          const m = s.match(/([\d\s\+\-\/*().]{1,120})/);
          if (!m) return null;
          const candidate = m[1];
          if (!/^[\d\s\+\-\/*().]+$/.test(candidate)) return null;
          const val = Function(`"use strict"; return (${candidate})`)();
          if (typeof val === 'number' && Number.isFinite(val)) return String(val);
          return null;
        } catch { return null; }
      }
      function scrubMeta(text) {
        let t = String(text || '');
        // Remove ST meta prompts like [Start a new Chat] etc. (compatible with ST prompt pipeline)
        const patterns = /\[(?:Start a new Chat|Start a new group chat\.|Example Chat|Continue your last message[^\]]*|Write the next reply[^\]]*)\]/gmi;
        return t.replace(patterns, '').replace(/^\s*\[.*?\]\s*$/gmi, '').trim();
      }
      function toText(m){
        const c = m && m.content;
        if (typeof c === 'string') return scrubMeta(c);
        if (Array.isArray(c)) return scrubMeta(c.map(p => (typeof p === 'string' ? p : (p && (p.text || p.content || '')))).join(''));
        if (c && typeof c === 'object') return scrubMeta(String(c.text || c.content || ''));
        return '';
      }
      function getLastNonEmptyText(arr){
        for (let i = arr.length - 1; i >= 0; i--) {
          const t = String(toText(arr[i]) || '').trim();
          if (t) return t;
        }
        return '';
      }
      const auth = requireAuth(req, res);
      const uid = auth?.uid || 'guest';
      const found = findSecretValue(uid, 'api_key_makersuite', undefined);
      let apiKey = (found && found.value) || process.env.MAKERSUITE_API_KEY || '';
      // Fallback to guest/global key if user scoped key is missing
      if (!apiKey) {
        const guestFound = findSecretValue('guest', 'api_key_makersuite', undefined);
        apiKey = (guestFound && guestFound.value) || apiKey;
      }
      if (!apiKey) {
        // graceful fallback
        const last = messages[messages.length - 1] || {};
        const userText = String(last.content || '').trim();
        const reply = `（未配置 Google API Key，返回演示）你说：${userText || '...'}`;
        setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
        return res.json({ id:`chatcmpl_${Date.now().toString(36)}`, object:'chat.completion', created:Math.floor(Date.now()/1000), model, choices:[{ index:0, message:{ role:'assistant', content: reply }, finish_reason:'stop' }], usage:{ prompt_tokens:1, completion_tokens: reply.length/4|0, total_tokens: (reply.length/4|0)+1 } });
      }
      // Build Gemini contents
      // Separate system messages into systemInstruction (improves adherence)
      const systemText = messages.filter(m => String(m.role||'').toLowerCase() === 'system').map(toText).filter(Boolean).join('\n');
      const roleMap = { user:'user', assistant:'model' };
      // Clip history to last N turns (non-system)
      const nonSys = messages.filter(m => String(m.role||'').toLowerCase() !== 'system');
      const turns = [];
      for (const m of nonSys) {
        const r = String(m.role||'').toLowerCase();
        if (r==='user' || r==='assistant') turns.push(m);
      }
      const keep = Math.max(2, Number(config.chatHistoryTurns||8)*2);
      const clipped = turns.slice(-keep);
      let contents = clipped
        .map(m => ({ role: roleMap[String(m.role||'user').toLowerCase()] || 'user', parts: [{ text: toText(m) }]}))
        .filter(x => x.parts && x.parts[0] && String(x.parts[0].text||'').trim().length > 0);
      // Fallback: If no non-system text left (e.g., strict_tools injected only system/tool schema),
      // use last non-empty message text as a single user turn to satisfy Gemini API.
      if (!Array.isArray(contents) || contents.length === 0) {
        const allTexts = messages.map(toText).map(s => String(s||'').trim()).filter(Boolean);
        const fallbackText = allTexts[allTexts.length - 1] || '';
        if (fallbackText) {
          contents = [{ role: 'user', parts: [{ text: fallbackText }] }];
        }
      }
      const genCfg = {};
      // Respect caller's max_tokens; fallback to env or 8192 if missing/invalid
      const requested = Number(body.max_tokens);
      const cap = Number(config.geminiMaxOutputTokens || process.env.GEMINI_DEFAULT_MAX_TOKENS || 1024);
      const picked = (Number.isFinite(requested) && requested > 0) ? Math.min(requested, cap) : cap;
      genCfg.maxOutputTokens = picked;
      res.setHeader('x-st-max-tokens-used', String(picked));
      if (body.temperature != null) genCfg.temperature = Number(body.temperature);
      // Ensure latest user input is present
      const lastUserMsg = messages.slice().reverse().find(m => String(m.role||'').toLowerCase()==='user');
      let lastUserText = lastUserMsg ? toText(lastUserMsg) : '';
      if (!lastUserText) {
        const hdr = String(req.headers['x-st-last-input']||'');
        if (hdr) {
          try { lastUserText = decodeURIComponent(hdr); } catch { lastUserText = hdr; }
          res.setHeader('x-st-last-input-used', 'header');
        }
      }
      function escapeReg(s){ return String(s||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
      function extractUserFromSystem(sys, userName){
        try{
          const text = String(sys||'');
          const name = String(userName||'用户');
          const re = new RegExp(`(?:^|\\n)\s*${escapeReg(name)}\s*[:：]\s*([^\n\r]+)`, 'g');
          let m, last='';
          while ((m = re.exec(text))){ last = (m[1]||'').trim(); }
          if (last) return last;
          const re2 = /(?:^|\n)\s*(?:User|用户|你)\s*[:：]\s*([^\n\r]+)/g;
          while ((m = re2.exec(text))){ last = (m[1]||'').trim(); }
          return last;
        }catch{ return ''; }
      }
      const lastAnyText = getLastNonEmptyText(messages);
      let anchorBase = lastUserText || lastAnyText;
      if (!anchorBase && systemText) {
        const extracted = extractUserFromSystem(systemText, userName);
        if (extracted) { anchorBase = extracted; res.setHeader('x-st-anchor-source', 'sys-extract'); }
      }
      const mathIntent = isMathIntentText(lastUserText) || isMathIntentText(anchorBase);
      let userInjected = false;
      if (lastUserText) {
        const userIndices = Array.isArray(contents) ? contents.map((x,i)=>x.role==='user'?i:-1).filter(i=>i>=0) : [];
        const lastUserIdx = userIndices.length ? userIndices[userIndices.length-1] : -1;
        const lastUserInPayload = lastUserIdx>=0 ? (contents[lastUserIdx].parts?.[0]?.text || '') : '';
        // If there is no user turn or the last user turn text differs from latest user input, append it
        if (lastUserIdx === -1 || String(lastUserInPayload).trim() !== String(lastUserText).trim()) {
          contents.push({ role: 'user', parts: [{ text: String(lastUserText) }] });
          userInjected = true;
        }
      }
      if (userInjected) res.setHeader('x-st-user-injected', 'true');
      // If still没有任何user turn，把锚定文本也补为一个user回合，确保对话承接
      if ((!Array.isArray(contents) || contents.every(x => x.role !== 'user')) && anchorBase) {
        contents.push({ role: 'user', parts: [{ text: String(anchorBase) }] });
        res.setHeader('x-st-user-injected', 'true');
      }
      const payload = { contents };
      // UI language auto-injection: if Accept-Language indicates zh and enabled in config
      const acceptLang = String(req.headers['accept-language'] || '').toLowerCase();
      const charName = String(body.char_name || '').trim();
      const userName = String(body.user_name || '').trim();
      const strictLatest = !!config.strictLatestOnly;
      const sysList = [];
      if (systemText && !config.strictLatestDropPersona) sysList.push(systemText);
      if (config.injectChineseOnZhUI && /^zh/.test(acceptLang)) {
        sysList.push(config.chineseInstructionText || '请用中文回复');
        res.setHeader('x-st-lang-injected', 'zh');
      }
      // Intent rules based on latest user text (math/story)
      try {
        if (!strictLatest && lastUserText) {
          const isMath = isMathIntentText(lastUserText);
          const isStory = isStoryIntentText(lastUserText);
          if (config.intentRuleMath && isMath) {
            const rule = /^zh/.test(acceptLang) ? (config.intentRuleMathTextZH||'') : (config.intentRuleMathTextEN||'');
            if (rule) { sysList.push(rule); res.setHeader('x-st-intent-rule', 'math'); }
          }
          if (config.intentRuleStory && isStory) {
            const rule2 = /^zh/.test(acceptLang) ? (config.intentRuleStoryTextZH||'') : (config.intentRuleStoryTextEN||'');
            if (rule2) { sysList.push(rule2); res.setHeader('x-st-intent-rule', 'story'); }
          }
        }
      } catch {}
      // Intent anchor (explicit) for Gemini branch already below
      // Intent rules based on the latest intent
      try {
        if (!strictLatest && anchorBase) {
          const isMath = isMathIntentText(anchorBase);
          const isStory = isStoryIntentText(anchorBase);
          if (config.intentRuleMath && isMath) {
            const rule = /^zh/.test(acceptLang) ? (config.intentRuleMathTextZH||'') : (config.intentRuleMathTextEN||'');
            if (rule) { sysList.push(rule); res.setHeader('x-st-intent-rule', 'math'); }
          }
          if (config.intentRuleStory && isStory) {
            const rule2 = /^zh/.test(acceptLang) ? (config.intentRuleStoryTextZH||'') : (config.intentRuleStoryTextEN||'');
            if (rule2) { sysList.push(rule2); res.setHeader('x-st-intent-rule', 'story'); }
          }
        }
      } catch {}

      // Intent anchor: explicitly include the latest user intent in systemInstruction
      try {
        if (!strictLatest && config.intentAnchor && anchorBase && !mathIntent) {
          const max = Math.max(40, Number(config.intentAnchorClamp||400));
          const brief = String(anchorBase).slice(0, max);
          const t = /^zh/.test(acceptLang) ? (config.intentAnchorTextZH||'') : (config.intentAnchorTextEN||'');
          const anchor = t.replace('{lastUser}', brief);
          if (anchor.trim()) {
            sysList.push(anchor);
            res.setHeader('x-st-intent-anchored', 'on');
            if (!lastUserText) res.setHeader('x-st-anchor-source', 'fallback');
          }
        }
      } catch {}
      // Optional: inject character card brief
      try {
        if (!config.strictLatestDropPersona && config.roleplayUseCharacterCard && charName) {
          const auth = requireAuth(req, res);
          const uid = auth?.uid || '';
          if (uid) {
            const chars = await listCharacters(uid);
            const foundChar = chars.find(c => String(c.name||'').toLowerCase() === String(charName).toLowerCase());
            if (foundChar) {
              const t = /^zh/.test(acceptLang) ? (config.roleplayCardTemplateZH||'') : (config.roleplayCardTemplateEN||'');
              const persona = t
                .replace('{name}', String(foundChar.name||''))
                .replace('{description}', String(foundChar.description||''))
                .replace('{personality}', String(foundChar.personality||''))
                .replace('{scenario}', String(foundChar.scenario||''))
                .replace('{first_mes}', String(foundChar.first_mes||''));
              if (persona.trim()) {
                sysList.push(persona);
                res.setHeader('x-st-card-injected', 'on');
              }
            }
          }
        }
      } catch {}
      // Optional: inject World Info brief
      try {
        if (!config.strictLatestDropPersona && config.roleplayUseWorldInfo) {
          const auth = requireAuth(req, res);
          const uid = auth?.uid || '';
          if (uid) {
            const items = await getWorldInfo(uid);
            const n = Math.max(1, Number(config.roleplayWorldItems||3));
            const picked = Array.isArray(items) ? items.slice(0, n) : [];
            const bulletT = /^zh/.test(acceptLang) ? (config.roleplayWorldItemBulletZH||'- {text}') : (config.roleplayWorldItemBulletEN||'- {text}');
            const bullets = picked.map(it => {
              const t = String(it?.text || it?.content || it?.description || it?.name || JSON.stringify(it)).trim();
              return bulletT.replace('{text}', t);
            }).join('\n');
            const tpl = /^zh/.test(acceptLang) ? (config.roleplayWorldTemplateZH||'') : (config.roleplayWorldTemplateEN||'');
            let wiText = tpl.replace('{n}', String(picked.length)).replace('{items}', bullets);
            const clamp = Math.max(200, Number(config.worldClampChars||800));
            if (wiText.length > clamp) wiText = wiText.slice(0, clamp);
            if (wiText.trim()) { sysList.push(wiText); res.setHeader('x-st-world-injected', 'on'); }
          }
        }
      } catch {}
      if (!config.strictLatestDropPersona && config.roleplayEnforcer && (charName || userName)) {
        const tmpl = /^zh/.test(acceptLang) ? (config.roleplayInstructionZH || '') : (config.roleplayInstructionEN || '');
        const text = tmpl.replace('{char}', charName || '角色').replace('{user}', userName || '用户');
        if (text) sysList.push(text);
        res.setHeader('x-st-roleplay-enforcer', 'on');
      }
      // Force user priority guidance
      if (config.forceUserPriority) {
        sysList.push(/^zh/.test(acceptLang) ? (config.userPriorityTextZH || '') : (config.userPriorityTextEN || ''));
        res.setHeader('x-st-user-priority', 'on');
      }
      // Optional: inject World Info brief (OpenAI-compatible)
      try {
        if (config.roleplayUseWorldInfo) {
          const auth2 = requireAuth(req, res);
          const uid2 = auth2?.uid || '';
          if (uid2) {
            const items2 = await getWorldInfo(uid2);
            const n2 = Math.max(1, Number(config.roleplayWorldItems||3));
            const picked2 = Array.isArray(items2) ? items2.slice(0, n2) : [];
            const bullet2 = /^zh/.test(acceptLang) ? (config.roleplayWorldItemBulletZH||'- {text}') : (config.roleplayWorldItemBulletEN||'- {text}');
            const bullets2 = picked2.map(it => {
              const t = String(it?.text || it?.content || it?.description || it?.name || JSON.stringify(it)).trim();
              return bullet2.replace('{text}', t);
            }).join('\n');
            const tpl2 = /^zh/.test(acceptLang) ? (config.roleplayWorldTemplateZH||'') : (config.roleplayWorldTemplateEN||'');
            let wi2 = tpl2.replace('{n}', String(picked2.length)).replace('{items}', bullets2);
            const clamp2 = Math.max(200, Number(config.worldClampChars||800));
            if (wi2.length > clamp2) wi2 = wi2.slice(0, clamp2);
            if (wi2.trim()) { sysList.push(wi2); res.setHeader('x-st-world-injected', 'on'); }
          }
        }
      } catch {}
      // Strict mode: collapse to only the latest user text
      if (strictLatest) {
        const collapsed = String(lastUserText || anchorBase || '').trim();
        payload.contents = [{ role: 'user', parts: [{ text: collapsed || '' }] }];
      }
      
      // Intent anchor: explicitly include the latest user intent in systemInstruction (Gemini)
      try {
        if (!strictLatest && config.intentAnchor && lastUserText && !mathIntent) {
          const max = Math.max(40, Number(config.intentAnchorClamp||400));
          const brief = String(lastUserText).slice(0, max);
          const t = /^zh/.test(acceptLang) ? (config.intentAnchorTextZH||'') : (config.intentAnchorTextEN||'');
          const anchor = t.replace('{lastUser}', brief);
          if (anchor.trim()) { sysList.push(anchor); res.setHeader('x-st-intent-anchored', 'on'); }
        }
      } catch {}
      const sysCombined = sysList.filter(Boolean).join('\n');
      if (sysCombined) payload.systemInstruction = { parts: [{ text: sysCombined }] };
      if (Object.keys(genCfg).length) payload.generationConfig = genCfg;
      // Hard intent append: add a synthetic user turn at the end
      try {
        if (!strictLatest && config.hardIntentAppend && anchorBase && !mathIntent) {
          const suffix = /^zh/.test(acceptLang) ? (config.hardIntentSuffixZH||'') : (config.hardIntentSuffixEN||'');
          const brief3 = String(anchorBase).slice(0, Math.max(40, Number(config.intentAnchorClamp||400)));
          payload.contents.push({ role: 'user', parts: [{ text: `${brief3}${suffix}` }] });
          res.setHeader('x-st-hard-append', 'on');
          if (!lastUserText) res.setHeader('x-st-anchor-source', 'fallback');
        }
      } catch {}
      // Short-circuit math intent locally to ensure numeric-only answers
      try {
        if (config.intentRuleMath && mathIntent) {
          const localMath = tryEvalMath(lastUserText || anchorBase);
          if (localMath != null) {
            setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
            res.setHeader('x-st-fallback', 'math-shortcircuit');
            res.setHeader('x-st-intent-rule', 'math');
            res.setHeader('x-st-llm-branch', 'gemini');
            if (stream) {
              res.setHeader('content-type', 'text/event-stream; charset=utf-8');
              res.setHeader('cache-control', 'no-cache');
              if (source === 'makersuite') {
                const ev = JSON.stringify({ candidates: [ { content: { parts: [ { text: String(localMath) } ] } } ] });
                res.write(`data: ${ev}\n\n`);
                res.write('data: [DONE]\n\n');
                return res.end();
              } else {
                const ev = JSON.stringify({ id:`chatcmpl_${Date.now().toString(36)}`, object:'chat.completion.chunk', created:Math.floor(Date.now()/1000), model, choices:[{ index:0, delta:{ content: String(localMath) }, finish_reason:'stop' }] });
                res.write(`data: ${ev}\n\n`);
                res.write('data: [DONE]\n\n');
                return res.end();
              }
            }
            return res.json({ id:`chatcmpl_${Date.now().toString(36)}`, object:'chat.completion', created:Math.floor(Date.now()/1000), model, choices:[{ index:0, message:{ role:'assistant', content: String(localMath) }, finish_reason:'stop' }], usage:{ prompt_tokens:1, completion_tokens: String(localMath).length/4|0, total_tokens: ((String(localMath).length/4|0)+1) } });
          }
        }
      } catch {}
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      res.setHeader('x-st-llm-branch', 'gemini');
      const r1 = await fetchWithRetries(endpoint, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(payload) });
      if (!r1.ok) {
        // Try local math fallback if intent is math-like
        const localMath = tryEvalMath(anchorBase);
        if (localMath != null && /math/.test(String(res.getHeader('x-st-intent-rule')||''))) {
          setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
          res.setHeader('x-st-fallback', 'math');
          return res.json({ id:`chatcmpl_${Date.now().toString(36)}`, object:'chat.completion', created:Math.floor(Date.now()/1000), model, choices:[{ index:0, message:{ role:'assistant', content: localMath }, finish_reason:'stop' }], usage:{ prompt_tokens:1, completion_tokens: String(localMath).length/4|0, total_tokens: ((String(localMath).length/4|0)+1) } });
        }
        setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
        __LAST_LLM_DIAG = { when: Date.now(), branch: 'gemini', status: r1.status, source, model, stream, error: String(r1.text||'').slice(0, 500), msgCount: messages.length };
        return res.status(502).json({ error: true, provider: 'gemini', status: r1.status, message: String(r1.text||'').slice(0, 500) });
      }
      const j = JSON.parse(r1.text);
      // Prefer aggregating text from all candidates/parts to avoid empty replies
      const aggregateText = (() => {
        try {
          if (Array.isArray(j?.candidates) && j.candidates.length) {
            const byCand = j.candidates.map(cn => {
              const parts = cn?.content?.parts;
              if (Array.isArray(parts) && parts.length) {
                return parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('');
              }
              return '';
            }).filter(Boolean);
            const joined = byCand.join('\n').trim();
            if (joined) return joined;
          }
          if (typeof j?.output_text === 'string' && j.output_text.trim()) return j.output_text.trim();
        } catch {}
        return '';
      })();
      const lastUserForEcho = (messages.slice().reverse().find(m => String(m.role||'').toLowerCase()==='user') || null);
      const echoText = lastUserForEcho ? String(toText(lastUserForEcho)).trim() : '';
      const reply = aggregateText || (echoText ? `（空白回复，已回显）你说：${echoText}` : '（空回复）');
      setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
      const lastUser = (messages.slice().reverse().find(m => String(m.role||'').toLowerCase()==='user') || null);
      __LAST_LLM_DIAG = { when: Date.now(), branch: 'gemini', source, model, stream, msgCount: messages.length, lastUser: lastUser ? String(toText(lastUser)).slice(0,160) : '' };
      if (stream) {
        res.setHeader('content-type', 'text/event-stream; charset=utf-8');
        res.setHeader('cache-control', 'no-cache');
        const chunks = (reply.match(/.{1,120}/g) || ['']);
        if (source === 'makersuite') {
          // Makersuite 形状
          for (const part of chunks) {
            const ev = JSON.stringify({ candidates: [ { content: { parts: [ { text: part } ] } } ] });
            res.write(`data: ${ev}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          return res.end();
        } else {
          // OpenAI 兼容流式形状（custom/openai 等）
          for (const part of chunks) {
            const ev = JSON.stringify({ id:`chatcmpl_${Date.now().toString(36)}`, object:'chat.completion.chunk', created:Math.floor(Date.now()/1000), model, choices:[{ index:0, delta:{ content: part }, finish_reason:null }] });
            res.write(`data: ${ev}\n\n`);
          }
          const done = JSON.stringify({ id:`chatcmpl_${Date.now().toString(36)}`, object:'chat.completion.chunk', created:Math.floor(Date.now()/1000), model, choices:[{ index:0, delta:{}, finish_reason:'stop' }] });
          res.write(`data: ${done}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
      }
      // Non-streaming response in OpenAI-like shape
      return res.json({ id:`chatcmpl_${Date.now().toString(36)}`, object:'chat.completion', created:Math.floor(Date.now()/1000), model, choices:[{ index:0, message:{ role:'assistant', content: reply }, finish_reason:'stop' }], usage:{ prompt_tokens:1, completion_tokens: reply.length/4|0, total_tokens: (reply.length/4|0)+1 } });
    }

    // OpenAI-compatible proxy (includes OpenRouter)
    const isOpenAICompat = source === 'openai' || source === 'custom' || source === 'generic' || source === 'openrouter';
    if (isOpenAICompat) {
      const auth = requireAuth(req, res);
      const uid = auth?.uid || 'guest';
      const isOpenRouter = source === 'openrouter';
      const keyType = isOpenRouter ? 'api_key_openrouter' : (source === 'openai' ? 'api_key_openai' : 'api_key_generic');
      let apiKey = (findSecretValue(uid, keyType)?.value)
        || (uid !== 'guest' ? findSecretValue('guest', keyType)?.value : '')
        || (isOpenRouter
          ? (process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_TOKEN || '')
          : (source === 'openai' ? (process.env.OPENAI_API_KEY || '') : (process.env.GENERIC_API_KEY || '')));
      // Allow reverse proxy password to override Authorization header
      const proxyPassword = typeof body.proxy_password === 'string' ? body.proxy_password : '';
      // Resolve base URL
      const baseDefault = isOpenRouter ? OPENROUTER_BASE_URL : (source === 'openai' ? 'https://api.openai.com' : '');
      const baseRaw = isOpenRouter
        ? (body.reverse_proxy || body.custom_url || baseDefault)
        : (body.custom_url || body.reverse_proxy || process.env.OPENAI_COMPAT_BASE || baseDefault);
      const base = String(baseRaw || '').replace(/\/$/, '');
      if (!base) {
        function toText(m){
          const c = m && m.content;
          if (typeof c === 'string') return c;
          if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : (p && (p.text || p.content || '')))).join('');
          if (c && typeof c === 'object') return String(c.text || c.content || '');
          return '';
        }
        const last = messages[messages.length - 1] || {};
        const userText = String(toText(last)).trim();
        const providerLabel = isOpenRouter ? 'OpenRouter' : 'OpenAI';
        const reply = userText ? `（${providerLabel}代理未配置）你说：${userText}` : `（${providerLabel}代理未配置）`;
        const fallbackBranch = isOpenRouter ? 'openrouter-fallback' : 'openai-compat-fallback';
        const diagTarget = isOpenRouter ? 'openrouter' : 'compat';
        setDiagnostics(res, { target: diagTarget, authSource: auth ? 'cookie' : 'none' });
        res.setHeader('x-st-llm-branch', fallbackBranch);
        __LAST_LLM_DIAG = { when: Date.now(), branch: fallbackBranch, source, model, stream };
        return res.json({ id:`chatcmpl_${Date.now().toString(36)}`, object:'chat.completion', created:Math.floor(Date.now()/1000), model, choices:[{ index:0, message:{ role:'assistant', content: reply }, finish_reason:'stop' }], usage:{ prompt_tokens:1, completion_tokens: reply.length/4|0, total_tokens: (reply.length/4|0)+1 } });
      }

      // Build OpenAI payload
      function toText(m){
        const c = m && m.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : (p && (p.text || p.content || '')))).join('');
        if (c && typeof c === 'object') return String(c.text || c.content || '');
        return '';
      }
      // Split out system + non-system, inject zh system instruction if enabled
      const acceptLang = String(req.headers['accept-language'] || '').toLowerCase();
      const charName = String(body.char_name || '').trim();
      const userName = String(body.user_name || '').trim();
      const sysText = messages.filter(m => String(m.role||'').toLowerCase()==='system').map(toText).filter(Boolean).join('\n');
      // Clip history to last N turns for OpenAI-compatible branch
      const nonSystemClipped = (()=>{
        const nonSystemAll = messages.filter(m => String(m.role||'').toLowerCase()!=='system');
        const t = [];
        for (const m of nonSystemAll) { const r=String(m.role||'').toLowerCase(); if (r==='user'||r==='assistant') t.push(m); }
        const keepN = Math.max(2, Number(config.chatHistoryTurns||8)*2);
        return t.slice(-keepN);
      })();
      function oc_toText(m){
        const c = m && m.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : (p && (p.text || p.content || '')))).join('');
        if (c && typeof c === 'object') return String(c.text || c.content || '');
        return '';
      }
      function oc_scrubMeta(t){
        let s = String(t||'');
        if (!config.scrubStMetaPrompts) return s;
        const patterns = [/\[(?:Start a new Chat|Start a new group chat\.|Example Chat|Continue your last message[^\]]*|Write the next reply[^\]]*)\]/gmi];
        for (const p of patterns) s = s.replace(p, '');
        s = s.replace(/^\s*\[.*?\]\s*$/gmi, '').trim();
        return s;
      }
      function oc_isMathIntent(text){
        try { return /只回答数字|只输出|=\?|[\d\s\+\-\/*()=]{3,}/.test(String(text||'')); } catch { return false; }
      }
      function oc_isStoryIntent(text){
        try {
          const t = String(text||'');
          return /(剧情推进|继续剧情|推进剧情|采取行动|继续(?!\S)|继续下去|继续写|接着|推动剧情|推进|展开(剧情|故事)?|下一步|采取(行动|下一步))/.test(t);
        } catch { return false; }
      }
      function oc_tryEvalMath(expr) {
        try {
          const s = String(expr||'').replace(/，/g, ',').replace(/．/g,'.');
          const m = s.match(/([\d\s\+\-\/*().]{1,120})/);
          if (!m) return null;
          const candidate = m[1];
          if (!/^[\d\s\+\-\/*().]+$/.test(candidate)) return null;
          const val = Function(`"use strict"; return (${candidate})`)();
          if (typeof val === 'number' && Number.isFinite(val)) return String(val);
          return null;
        } catch { return null; }
      }
      const nonSystem = nonSystemClipped
        .map(m => ({ role: m.role, content: oc_scrubMeta(oc_toText(m)) }))
        .filter(x => String(x.content||'').trim().length>0);
      let outMessages = [];
      let lastUserText2 = '';
      let anchorBase2 = '';
      let strictLatest2 = !!config.strictLatestOnly;
      let mathIntent2 = false;

      if (config.preserveMessageStructure) {
        outMessages = messages
          .filter(m => m && typeof m === 'object' && typeof m.role === 'string')
          .map(m => ({ ...m }));
        const lastUserMsg2 = messages.slice().reverse().find(m => String(m.role||'').toLowerCase()==='user');
        lastUserText2 = lastUserMsg2 ? toText(lastUserMsg2) : '';
        if (!lastUserText2) {
          const hdr2 = String(req.headers['x-st-last-input']||'');
          if (hdr2) {
            try { lastUserText2 = decodeURIComponent(hdr2); } catch { lastUserText2 = hdr2; }
            res.setHeader('x-st-last-input-used', 'header');
          }
        }
        const lastAnyText2 = (function(){ for (let i=messages.length-1;i>=0;i--){ const t=String(toText(messages[i])||'').trim();if(t) return t;} return '';})();
        anchorBase2 = lastUserText2 || lastAnyText2;
        mathIntent2 = oc_isMathIntent(lastUserText2) || oc_isMathIntent(anchorBase2);
        const trimmedLastUserText2 = String(lastUserText2 || '').trim();
        if (trimmedLastUserText2) {
          const hasMatchingUser = outMessages.some(m => {
            if (!m || typeof m !== 'object') return false;
            if (String(m.role || '').toLowerCase() !== 'user') return false;
            return String(toText(m) || '').trim() === trimmedLastUserText2;
          });
          if (!hasMatchingUser) {
            outMessages = [...outMessages, { role: 'user', content: lastUserText2 }];
            res.setHeader('x-st-user-injected', 'true');
          }
        }
      } else {
        const sysList = [];
        if (sysText && !config.strictLatestDropPersona) sysList.push(sysText);
        if (config.injectChineseOnZhUI && /^zh/.test(acceptLang)) {
          sysList.push(config.chineseInstructionText || '请用中文回复');
          res.setHeader('x-st-lang-injected', 'zh');
        }
        try {
          if (!config.strictLatestDropPersona && config.roleplayUseCharacterCard && charName) {
            const auth = requireAuth(req, res);
            const uid = auth?.uid || '';
            if (uid) {
              const chars = await listCharacters(uid);
              const foundChar = chars.find(c => String(c.name||'').toLowerCase() === String(charName).toLowerCase());
              if (foundChar) {
                const t = /^zh/.test(acceptLang) ? (config.roleplayCardTemplateZH||'') : (config.roleplayCardTemplateEN||'');
                const persona = t
                  .replace('{name}', String(foundChar.name||''))
                  .replace('{description}', String(foundChar.description||''))
                  .replace('{personality}', String(foundChar.personality||''))
                  .replace('{scenario}', String(foundChar.scenario||''))
                  .replace('{first_mes}', String(foundChar.first_mes||''));
                if (persona.trim()) {
                  sysList.push(persona);
                  res.setHeader('x-st-card-injected', 'on');
                }
              }
            }
          }
        } catch {}
        if (!config.strictLatestDropPersona && config.roleplayEnforcer && (charName || userName)) {
          const tmpl = /^zh/.test(acceptLang) ? (config.roleplayInstructionZH || '') : (config.roleplayInstructionEN || '');
          const text = tmpl.replace('{char}', charName || '角色').replace('{user}', userName || '用户');
          if (text) sysList.push(text);
          res.setHeader('x-st-roleplay-enforcer', 'on');
        }
        if (config.forceUserPriority) {
          sysList.push(/^zh/.test(acceptLang) ? (config.userPriorityTextZH || '') : (config.userPriorityTextEN || ''));
          res.setHeader('x-st-user-priority', 'on');
        }
        const lastUserMsg2 = messages.slice().reverse().find(m => String(m.role||'').toLowerCase()==='user');
        lastUserText2 = lastUserMsg2 ? toText(lastUserMsg2) : '';
        if (!lastUserText2) {
          const hdr2 = String(req.headers['x-st-last-input']||'');
          if (hdr2) {
            try { lastUserText2 = decodeURIComponent(hdr2); } catch { lastUserText2 = hdr2; }
            res.setHeader('x-st-last-input-used', 'header');
          }
        }
        const lastAnyText2 = (function(){ for (let i=messages.length-1;i>=0;i--){ const t=String(toText(messages[i])||'').trim();if(t) return t;} return '';})();
        anchorBase2 = lastUserText2 || lastAnyText2;
        try {
          if (!strictLatest2 && lastUserText2) {
            const isMath2 = oc_isMathIntent(lastUserText2);
            const isStory2 = oc_isStoryIntent(lastUserText2);
            if (config.intentRuleMath && isMath2) {
              const rule = /^zh/.test(acceptLang) ? (config.intentRuleMathTextZH||'') : (config.intentRuleMathTextEN||'');
              if (rule) { sysList.push(rule); res.setHeader('x-st-intent-rule', 'math'); }
            }
            if (config.intentRuleStory && isStory2) {
              const rule2 = /^zh/.test(acceptLang) ? (config.intentRuleStoryTextZH||'') : (config.intentRuleStoryTextEN||'');
              if (rule2) { sysList.push(rule2); res.setHeader('x-st-intent-rule', 'story'); }
            }
          }
          if (!strictLatest2 && anchorBase2) {
            const isMathA = oc_isMathIntent(anchorBase2);
            const isStoryA = oc_isStoryIntent(anchorBase2);
            if (config.intentRuleMath && isMathA) {
              const ruleA = /^zh/.test(acceptLang) ? (config.intentRuleMathTextZH||'') : (config.intentRuleMathTextEN||'');
              if (ruleA) { sysList.push(ruleA); res.setHeader('x-st-intent-rule', 'math'); }
            }
            if (config.intentRuleStory && isStoryA) {
              const ruleA2 = /^zh/.test(acceptLang) ? (config.intentRuleStoryTextZH||'') : (config.intentRuleStoryTextEN||'');
              if (ruleA2) { sysList.push(ruleA2); res.setHeader('x-st-intent-rule', 'story'); }
            }
          }
          if (!strictLatest2 && config.intentAnchor && lastUserText2) {
            const max2 = Math.max(40, Number(config.intentAnchorClamp||400));
            const brief2 = String(lastUserText2).slice(0, max2);
            const t2 = /^zh/.test(acceptLang) ? (config.intentAnchorTextZH||'') : (config.intentAnchorTextEN||'');
            const anchor2 = t2.replace('{lastUser}', brief2);
            if (anchor2.trim()) { sysList.push(anchor2); res.setHeader('x-st-intent-anchored', 'on'); }
          }
        } catch {}
        const sysCombined = sysList.filter(Boolean).join('\n');
        mathIntent2 = oc_isMathIntent(lastUserText2) || oc_isMathIntent(anchorBase2);
        outMessages = sysCombined ? [{ role: 'system', content: sysCombined }, ...nonSystem] : nonSystem;
        if (strictLatest2) {
          const collapsed2 = String(lastUserText2 || anchorBase2 || '').trim();
          outMessages = sysCombined ? [{ role: 'system', content: sysCombined }, { role: 'user', content: collapsed2 }] : [{ role: 'user', content: collapsed2 }];
        }
      }

      if (!config.preserveMessageStructure) {
        if (lastUserText2) {
          const lastUserInPayload = [...outMessages].reverse().find(m => m.role==='user')?.content || '';
          if (!lastUserInPayload || String(lastUserInPayload).trim() !== String(lastUserText2).trim()) {
            outMessages = [...outMessages, { role: 'user', content: String(lastUserText2) }];
            res.setHeader('x-st-user-injected', 'true');
          }
        }
        if (!strictLatest2 && config.hardIntentAppend && anchorBase2 && !mathIntent2) {
          const suffix2 = /^zh/.test(acceptLang) ? (config.hardIntentSuffixZH||'') : (config.hardIntentSuffixEN||'');
          const brief4 = String(anchorBase2).slice(0, Math.max(40, Number(config.intentAnchorClamp||400)));
          outMessages = [...outMessages, { role: 'user', content: `${brief4}${suffix2}` }];
          res.setHeader('x-st-hard-append', 'on');
        }
      }
      const reqMax = Number(body.max_tokens);
      const capMax = Number(config.openaiCompatMaxTokens || 1024);
      const maxUsed = (Number.isFinite(reqMax) && reqMax > 0) ? Math.min(reqMax, capMax) : capMax;
      const payload = {
        model,
        messages: outMessages,
        max_tokens: maxUsed,
        temperature: body.temperature,
        stream,
      };
      const passthroughKeys = ['top_p','top_k','presence_penalty','frequency_penalty','repetition_penalty','min_p','top_a','seed','logit_bias','stop','n','logprobs','top_logprobs'];
      for (const key of passthroughKeys) {
        if (Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined) {
          payload[key] = body[key];
        }
      }
      if (Array.isArray(body.tools)) payload.tools = body.tools;
      if (Object.prototype.hasOwnProperty.call(body, 'tool_choice')) payload.tool_choice = body.tool_choice;
      if (Object.prototype.hasOwnProperty.call(body, 'reasoning_effort') && !isOpenRouter) payload.reasoning_effort = body.reasoning_effort;
      if (isOpenRouter) {
        if (Object.prototype.hasOwnProperty.call(body, 'include_reasoning')) {
          payload.include_reasoning = Boolean(body.include_reasoning);
        }
        if (body.reasoning_effort) {
          payload.reasoning = { effort: body.reasoning_effort };
        }
        const transforms = buildOpenRouterTransforms(body.middleout);
        if (transforms !== undefined) payload.transforms = transforms;
        const plugins = buildOpenRouterPlugins(body.enable_web_search);
        if (plugins.length) payload.plugins = plugins;
        if (Array.isArray(body.provider) && body.provider.length) {
          payload.provider = {
            order: body.provider,
            allow_fallbacks: body.allow_fallbacks !== undefined ? !!body.allow_fallbacks : true,
          };
        } else if (Object.prototype.hasOwnProperty.call(body, 'allow_fallbacks')) {
          payload.provider = { allow_fallbacks: !!body.allow_fallbacks };
        }
        if (body.use_fallback) payload.route = 'fallback';
        if (body.json_schema && typeof body.json_schema === 'object') {
          payload.response_format = {
            type: 'json_schema',
            json_schema: {
              name: body.json_schema.name || 'response_schema',
              strict: body.json_schema.strict !== undefined ? !!body.json_schema.strict : true,
              schema: body.json_schema.value || {},
            },
          };
        }
        if (/google\/gemini/i.test(model)) {
          payload.safety_settings = GEMINI_SAFETY;
        }
      }
      res.setHeader('x-st-max-tokens-used', String(maxUsed));
      // remove undefined
      Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

      // Short-circuit math intent (OpenAI-compatible branch)
      try {
        if (config.intentRuleMath && mathIntent2) {
          const localMath = oc_tryEvalMath(lastUserText2 || anchorBase2);
          if (localMath != null) {
            const compatBranch = isOpenRouter ? 'openrouter' : 'openai-compat';
            const diagTarget = isOpenRouter ? 'openrouter' : 'compat';
            setDiagnostics(res, { target: diagTarget, authSource: auth ? 'cookie' : 'none' });
            res.setHeader('x-st-fallback', 'math-shortcircuit');
            res.setHeader('x-st-intent-rule', 'math');
            res.setHeader('x-st-llm-branch', compatBranch);
            if (stream) {
              res.setHeader('content-type', 'text/event-stream; charset=utf-8');
              res.setHeader('cache-control', 'no-cache');
              const ev = JSON.stringify({ id:`chatcmpl_${Date.now().toString(36)}`, object:'chat.completion.chunk', created:Math.floor(Date.now()/1000), model, choices:[{ index:0, delta:{ content: String(localMath) }, finish_reason:'stop' }] });
              res.write(`data: ${ev}\n\n`);
              res.write('data: [DONE]\n\n');
              return res.end();
            }
            return res.json({ id:`chatcmpl_${Date.now().toString(36)}`, object:'chat.completion', created:Math.floor(Date.now()/1000), model, choices:[{ index:0, message:{ role:'assistant', content: String(localMath) }, finish_reason:'stop' }], usage:{ prompt_tokens:1, completion_tokens: String(localMath).length/4|0, total_tokens: ((String(localMath).length/4|0)+1) } });
          }
        }
      } catch {}

      const compatBranch = isOpenRouter ? 'openrouter' : 'openai-compat';
      const endpointBase = base.replace(/\/$/, '');
      const endpoint = isOpenRouter ? `${endpointBase}/chat/completions` : `${endpointBase}/v1/chat/completions`;
      const headers = new Headers({ 'content-type': 'application/json' });
      const token = proxyPassword || apiKey;
      if (token) headers.set('authorization', `Bearer ${token}`);
      if (isOpenRouter) {
        const referer = config.openrouterReferer || OPENROUTER_HEADER_DEFAULTS['HTTP-Referer'];
        const title = config.openrouterTitle || OPENROUTER_HEADER_DEFAULTS['X-Title'];
        headers.set('HTTP-Referer', referer);
        headers.set('X-Title', title);
        if (!headers.has('Referer')) headers.set('Referer', referer);
      }
      res.setHeader('x-st-llm-branch', compatBranch);
      const r = await fetch(endpoint, { method:'POST', headers, body: JSON.stringify(payload) });
      if (!r.ok) {
        const txt = await r.text();
        const diagTarget = isOpenRouter ? 'openrouter' : 'compat';
        setDiagnostics(res, { target: diagTarget, authSource: auth ? 'cookie' : 'none' });
        __LAST_LLM_DIAG = { when: Date.now(), branch: compatBranch, status: r.status, source, model, stream, error: txt.slice(0, 500) };
        return res.status(502).json({ error: true, provider: compatBranch, status: r.status, message: txt.slice(0, 500) });
      }
      const diagTarget = isOpenRouter ? 'openrouter' : 'compat';
      setDiagnostics(res, { target: diagTarget, authSource: auth ? 'cookie' : 'none' });
      __LAST_LLM_DIAG = { when: Date.now(), branch: compatBranch, source, model, stream };
      if (stream) {
        res.setHeader('content-type', 'text/event-stream; charset=utf-8');
        res.setHeader('cache-control', 'no-cache');
        const bodyStream = r.body;
        bodyStream.on('data', chunk => res.write(chunk));
        bodyStream.on('end', () => res.end());
        bodyStream.on('error', () => res.end());
        return;
      }
      const j = await r.json();
      return res.json(j);
    }

    // Default demo fallback
    function toText(m){
      const c = m && m.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : (p && (p.text || p.content || '')))).join('');
      if (c && typeof c === 'object') return String(c.text || c.content || '');
      return '';
    }
    const last = messages[messages.length - 1] || {};
    const userText = String(toText(last)).trim();
    const reply = userText ? `（演示回复）你说：${userText}` : '（演示回复）你好，我在这里。';
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    res.setHeader('x-st-llm-branch', 'demo');
    __LAST_LLM_DIAG = { when: Date.now(), branch: 'demo', source, model, stream };
    if (stream) {
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache');
      const chunk = JSON.stringify({ choices: [{ index: 0, text: reply, finish_reason: null }] });
      res.write(`data: ${chunk}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return res.json({ id:`chatcmpl_${Date.now().toString(36)}`, object:'chat.completion', created:Math.floor(Date.now()/1000), model: body.model || 'stub', choices:[{ index:0, message:{ role:'assistant', content: reply }, finish_reason:'stop' }], usage:{ prompt_tokens: Math.ceil((userText.length||1)/4), completion_tokens: Math.ceil(reply.length/4), total_tokens: Math.ceil((userText.length+reply.length)/4) } });
  } catch (e) {
    console.error('chat-completions error', e);
    return toJsonError(Object.assign(new Error('Generation failed'), { status: 500 }), req, res);
  }
});

// Diagnostics: last LLM branch and status
app.get('/api/_diagnostics/last-llm', (req, res) => {
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  res.json(__LAST_LLM_DIAG || {});
});

app.post('/api/characters/all', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) {
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    return res.json([]);
  }
  const chars = await listCharacters(auth.uid);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json(chars);
});

app.post('/api/characters/get', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const avatar_url = (req.body && req.body.avatar_url) || '';
  const ch = await getCharacterByAvatar(auth.uid, avatar_url);
  if (!ch) return toJsonError(Object.assign(new Error('Not Found'), { status: 404 }), req, res);
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  return res.json(ch);
});

app.post('/api/characters/create', upload.single('avatar'), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const uid = auth.uid;
  const name = req.body?.name || 'New Character';
  const first_message = req.body?.first_message || '';
  const avatarId = `char_${Date.now().toString(36)}`;
  let avatarRel = '/st/default/content/default_Seraphina.png';
  if (req.file) {
    const ext = path.extname(req.file.originalname) || '.png';
    const userDir = path.join(__dirname, 'data', 'users', uid, 'avatars');
    fs.mkdirSync(userDir, { recursive: true });
    const destPath = path.join(userDir, `${avatarId}${ext}`);
    fs.copyFileSync(req.file.path, destPath);
    avatarRel = `/st-internal/assets/users/${uid}/avatars/${avatarId}${ext}`;
  } else {
    // Copy default avatar into user space to ensure avatar URL is a stable unique key
    const userDir = path.join(__dirname, 'data', 'users', uid, 'avatars');
    fs.mkdirSync(userDir, { recursive: true });
    const destPath = path.join(userDir, `${avatarId}.png`);
    const defaultSrc = path.join(ROOT_DIR, 'SillyTavern', 'default', 'content', 'default_Seraphina.png');
    try {
      fs.copyFileSync(defaultSrc, destPath);
      avatarRel = `/st-internal/assets/users/${uid}/avatars/${avatarId}.png`;
    } catch {
      // fallback to shared default path if copy fails
      avatarRel = '/st/default/content/default_Seraphina.png';
    }
  }
  // store character
  const character = { name, avatar: avatarRel, chat: `${name} - ${new Date().toISOString()}`, first_mes: first_message, fav: false, shallow: false, data: { extensions: {}, alternate_greetings: [] } };
  // Optional metadata fields from form
  const fields = ['description','creator_notes','character_version','post_history_instructions','system_prompt','tags','creator','personality','mes_example','scenario','world'];
  for (const k of fields) {
    if (k in (req.body||{})) character[k] = req.body[k];
  }
  if ('talkativeness' in (req.body||{})) {
    const t = Number(req.body.talkativeness);
    if (Number.isFinite(t)) character.talkativeness = t;
  }
  if ('depth_prompt_prompt' in (req.body||{})) character.depth_prompt_prompt = req.body.depth_prompt_prompt;
  if ('depth_prompt_depth' in (req.body||{})) character.depth_prompt_depth = Number(req.body.depth_prompt_depth) || character.depth_prompt_depth;
  if ('depth_prompt_role' in (req.body||{})) character.depth_prompt_role = req.body.depth_prompt_role;
  // Extensions JSON
  if (req.body && typeof req.body.extensions === 'string') {
    try { character.data.extensions = JSON.parse(req.body.extensions); } catch {}
  }
  // Alternate greetings (array or single)
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'alternate_greetings')) {
    const ag = req.body.alternate_greetings;
    if (Array.isArray(ag)) character.data.alternate_greetings = ag.filter(Boolean).map(String);
    else if (typeof ag === 'string' && ag) character.data.alternate_greetings = [ag];
  }
  await addCharacter(uid, character);
  // expose static route for user assets
  app.use(`/st-internal/assets/users/${uid}/avatars`, express.static(path.join(__dirname, 'data', 'users', uid, 'avatars')));
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  return res.send(avatarId);
});

app.post('/api/characters/rename', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const uid = auth.uid;
  const { avatar_url, name } = req.body || {};
  const chars = await listCharacters(uid);
  const ch = chars.find(c => c.avatar === avatar_url);
  if (!ch) return toJsonError(Object.assign(new Error('Character Not Found'), { status: 404 }), req, res);
  ch.name = name || ch.name;
  await saveCharacters(uid, chars);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

app.post('/api/characters/edit', upload.single('avatar'), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const uid = auth.uid;
  const avatar_url = req.body?.avatar_url;
  let existing = null;
  if (avatar_url) existing = await getCharacterByAvatar(uid, avatar_url);
  // Fallback by name if avatar_url missing
  if (!existing && req.body?.name) {
    const list = await listCharacters(uid);
    existing = list.find(c => c.name === req.body.name) || null;
  }
  if (!existing) return toJsonError(Object.assign(new Error('Character Not Found'), { status: 404 }), req, res);
  const chars = await listCharacters(uid);
  const idx = chars.findIndex(c => c.avatar === (avatar_url || existing.avatar));
  if (idx === -1) return toJsonError(Object.assign(new Error('Character Not Found'), { status: 404 }), req, res);
  const ch = { ...chars[idx] };
  if (req.body?.name) ch.name = req.body.name;
  if (req.body?.first_message) ch.first_mes = req.body.first_message;
  // Apply extended fields if provided
  const efields = ['description','creator_notes','character_version','post_history_instructions','system_prompt','tags','creator','personality','mes_example','scenario','world'];
  for (const k of efields) {
    if (k in (req.body||{})) ch[k] = req.body[k];
  }
  if ('talkativeness' in (req.body||{})) {
    const t = Number(req.body.talkativeness);
    if (Number.isFinite(t)) ch.talkativeness = t;
  }
  if ('depth_prompt_prompt' in (req.body||{})) ch.depth_prompt_prompt = req.body.depth_prompt_prompt;
  if ('depth_prompt_depth' in (req.body||{})) ch.depth_prompt_depth = Number(req.body.depth_prompt_depth) || ch.depth_prompt_depth;
  if ('depth_prompt_role' in (req.body||{})) ch.depth_prompt_role = req.body.depth_prompt_role;
  // Update extensions if provided
  if (req.body && typeof req.body.extensions === 'string') {
    try { ch.data = ch.data || {}; ch.data.extensions = JSON.parse(req.body.extensions); } catch {}
  }
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'alternate_greetings')) {
    const ag = req.body.alternate_greetings;
    ch.data = ch.data || {};
    if (Array.isArray(ag)) ch.data.alternate_greetings = ag.filter(Boolean).map(String);
    else if (typeof ag === 'string' && ag) ch.data.alternate_greetings = [ag];
  }
  // Update avatar if a new file uploaded
  if (req.file) {
    const userDir = path.join(__dirname, 'data', 'users', uid, 'avatars');
    fs.mkdirSync(userDir, { recursive: true });
    const ext = path.extname(req.file.originalname) || '.png';
    const base = path.basename(ch.avatar).replace(/\.[^.]+$/, '');
    const dst = path.join(userDir, `${base}${ext}`);
    try { fs.copyFileSync(req.file.path, dst); ch.avatar = `/st-internal/assets/users/${uid}/avatars/${path.basename(dst)}`; } catch {}
  }
  chars[idx] = ch;
  await saveCharacters(uid, chars);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

app.post('/api/characters/delete', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const uid = auth.uid;
  const avatar_url = req.body?.avatar_url;
  let chars = await listCharacters(uid);
  chars = chars.filter(c => c.avatar !== avatar_url);
  await saveCharacters(uid, chars);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

app.post('/api/characters/duplicate', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const uid = auth.uid;
  const avatar_url = req.body?.avatar_url;
  const ch = await getCharacterByAvatar(uid, avatar_url);
  if (!ch) return toJsonError(Object.assign(new Error('Character Not Found'), { status: 404 }), req, res);
  const copy = JSON.parse(JSON.stringify(ch));
  copy.name = `${ch.name} (copy)`;
  await addCharacter(uid, copy);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

app.post('/api/characters/import', upload.single('avatar'), async (req, res) => {
  try {
    const auth = requireAuth(req, res);
    if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
    const uid = auth.uid;
    if (!req.file) return toJsonError(Object.assign(new Error('file required'), { status: 400 }), req, res);

    const format = String(req.body?.file_type || '').toLowerCase();
    const buf = fs.readFileSync(req.file.path);
    let data = null;
    if (format === 'json' || format === 'charx') {
      try {
        data = JSON.parse(buf.toString('utf8'));
      } catch {}
    } else if (format === 'png' || format === 'byaf') {
      try { data = readCardFromPng(buf); } catch {}
    }

    // Normalize keys to lower-case for robust field matching
    function lowerKeys(obj){
      if (Array.isArray(obj)) return obj.map(lowerKeys);
      if (obj && typeof obj === 'object') {
        const out = {};
        for (const [k,v] of Object.entries(obj)) out[String(k).toLowerCase()] = lowerKeys(v);
        return out;
      }
      return obj;
    }
    if (data && typeof data === 'object') data = lowerKeys(data);
    // If everything is wrapped under a single 'data' key, unwrap once
    if (data && typeof data === 'object' && Object.keys(data).length === 1 && data.data) data = data.data;

    const pick = (...arr) => arr.find(v => typeof v === 'string' && v.trim().length) || '';
    const baseName = String(req.body?.preserved_name || '').replace(/\.[^.]+$/, '');
    const name = pick(data?.name, data?.character, data?.title, data?.data?.name, baseName, 'Imported');
    const first_message = pick(
      data?.first_mes, data?.greeting, data?.first_message,
      data?.data?.first_mes, data?.data?.greeting, data?.data?.first_message,
      ''
    );
    const description = pick(
      data?.description, data?.data?.description,
      data?.system_prompt, data?.data?.system_prompt,
      data?.persona, data?.personality, data?.bio, ''
    );
    const creator_notes = pick(data?.creator_notes, data?.creatorcomment, data?.data?.creator_notes, '');
    const character_version = pick(data?.character_version, data?.version, data?.data?.character_version, '');
    const system_prompt = pick(data?.system_prompt, data?.data?.system_prompt, '');
    const post_history_instructions = pick(data?.post_history_instructions, data?.data?.post_history_instructions, '');
    const world = pick(data?.world, data?.scenario, data?.data?.world, data?.data?.extensions?.world, '');

    // Prepare avatar file (JSON may embed data URL)
    const avatarsDir = path.join(__dirname, 'data', 'users', uid, 'avatars');
    fs.mkdirSync(avatarsDir, { recursive: true });
    const id = `char_${Date.now().toString(36)}`;
    let avatarRel = `/st-internal/assets/users/${uid}/avatars/${id}.png`;
    const destPng = path.join(avatarsDir, `${id}.png`);
    if (format === 'png' || format === 'byaf') {
      try { fs.writeFileSync(destPng, buf); } catch { /* fallback below */ }
    }
    // If JSON carries data: URL under avatar, decode it
    if (!fs.existsSync(destPng)) {
      const dataUrl = (typeof data?.avatar === 'string' && data.avatar.startsWith('data:image')) ? data.avatar : null;
      if (dataUrl) {
        const base64 = dataUrl.split(',')[1] || '';
        try { fs.writeFileSync(destPng, Buffer.from(base64, 'base64')); } catch {}
      }
    }
    if (!fs.existsSync(destPng)) {
      // fallback to default
      const defaultSrc = path.join(ROOT_DIR, 'SillyTavern', 'default', 'content', 'default_Seraphina.png');
      try { fs.copyFileSync(defaultSrc, destPng); } catch { avatarRel = '/st/default/content/default_Seraphina.png'; }
    }

    // Store character
    const tags = Array.isArray(data?.tags) ? data.tags : (Array.isArray(data?.data?.tags) ? data.data.tags : []);
    const character = {
      name,
      avatar: avatarRel,
      chat: `${name} - ${new Date().toISOString()}`,
      first_mes: first_message,
      description,
      fav: false,
      shallow: false,
      tags: Array.isArray(tags) ? tags : [],
      data: {
        ...(data?.data || {}),
        creator_notes,
        character_version,
        system_prompt,
        post_history_instructions,
        tags: Array.isArray(tags) ? tags : [],
        extensions: { ...(data?.data?.extensions || {}), world }
      }
    };
    await addCharacter(uid, character);

    setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
    // The client expects { file_name } without extension
    return res.json({ ok: true, file_name: id });
  } catch (e) {
    console.error('import character error', e);
    return toJsonError(Object.assign(new Error('Import failed'), { status: 500 }), req, res);
  }
});

app.post('/api/characters/merge-attributes', express.json(), (req, res) => {
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  return res.json({ ok: true });
});

// Chat maintenance
app.post('/api/chats/delete', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const uid = auth.uid;
  const { avatar_url, chatfile } = req.body || {};
  const ch = await getCharacterByAvatar(uid, avatar_url);
  if (!ch) return toJsonError(Object.assign(new Error('Character Not Found'), { status: 404 }), req, res);
  const charId = ch.avatar;
  const name = String(chatfile || '').replace(/\.jsonl$/, '');
  await deleteCharacterChat(uid, charId, name);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

app.post('/api/chats/rename', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const uid = auth.uid;
  const { avatar_url, file_name, new_name } = req.body || {};
  const ch = await getCharacterByAvatar(uid, avatar_url);
  if (!ch) return toJsonError(Object.assign(new Error('Character Not Found'), { status: 404 }), req, res);
  const charId = ch.avatar;
  const old = String(file_name || '').replace(/\.jsonl$/, '');
  const map = await listCharacterChats(uid, charId);
  const arr = map[old] || [];
  await deleteCharacterChat(uid, charId, old);
  await saveCharacterChat(uid, charId, new_name, arr);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

// Group chats using chatId as both characterId and chatName (UI expects {id,chat})
app.post('/api/chats/group/get', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const chatId = req.body?.id || (req.body?.file_name);
  if (!chatId) return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  const messages = await getCharacterChat(auth.uid, chatId, chatId) || [];
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json(messages);
});

app.post('/api/chats/group/save', express.json({ limit: '5mb' }), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const chatId = req.body?.id || (req.body?.file_name);
  const chat = Array.isArray(req.body?.chat) ? req.body.chat : [];
  if (!chatId) return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  await saveCharacterChat(auth.uid, chatId, chatId, chat);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

app.post('/api/chats/group/delete', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const chatId = req.body?.id || (req.body?.chatfile && String(req.body.chatfile).replace(/\.jsonl$/, ''));
  if (!chatId) return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  await deleteCharacterChat(auth.uid, chatId, chatId);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

app.post('/api/chats/group/import', upload.single('file'), (req, res) => {
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  return res.json({ ok: true });
});

// Export/import stubs
app.post('/api/chats/export', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  const { avatar_url, group_id, file_name } = req.body || {};
  let messages = [];
  if (auth && group_id) messages = await getCharacterChat(auth.uid, group_id, file_name) || [];
  else if (auth && avatar_url) messages = await getCharacterChat(auth.uid, avatar_url, file_name) || [];
  const content = JSON.stringify({ ok: true, file: file_name, count: messages.length, messages });
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-disposition', 'attachment; filename="chat.json"');
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  return res.send(content);
});

app.post('/api/characters/export', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  const avatar_url = req.body?.avatar_url;
  let ch = null;
  if (auth && avatar_url) {
    const list = await listCharacters(auth.uid);
    ch = list.find(c => c.avatar === avatar_url) || null;
  }
  const content = JSON.stringify({ ok: true, character: ch });
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-disposition', 'attachment; filename="character.json"');
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  return res.send(content);
});

// Export character as PNG with embedded card JSON
app.post('/api/characters/export-png', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const avatar_url = req.body?.avatar_url;
  const list = await listCharacters(auth.uid);
  const ch = list.find(c => c.avatar === avatar_url) || null;
  if (!ch) return toJsonError(Object.assign(new Error('Character Not Found'), { status: 404 }), req, res);
  let fsPath = null;
  if (avatar_url && avatar_url.startsWith('/st-internal/assets/users/')) {
    const rel = avatar_url.replace(/^\/st-internal\/assets\/users\//, '');
    fsPath = path.join(__dirname, 'data', 'users', rel);
  } else if (avatar_url && avatar_url.startsWith('/st/default/')) {
    const rel = avatar_url.replace(/^\/st\/default\//, '');
    fsPath = path.join(ROOT_DIR, 'SillyTavern', 'default', rel);
  }
  const buf = makeCardPngFromFile(fsPath, ch);
  res.setHeader('content-type', 'image/png');
  res.setHeader('content-disposition', `attachment; filename="${(ch.name||'character').replace(/[^A-Za-z0-9._-]+/g,'_')}.png"`);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.send(buf);
});

// Import TavernCard PNG or JSON
app.post('/api/characters/import-card', upload.single('file'), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  if (!req.file) return toJsonError(Object.assign(new Error('file required'), { status: 400 }), req, res);
  const buf = fs.readFileSync(req.file.path);
  let data = null;
  // Try PNG card
  data = readCardFromPng(buf);
  if (!data) {
    // Try JSON
    try { data = JSON.parse(buf.toString('utf8')); } catch {}
  }
  if (!data || typeof data !== 'object') return toJsonError(Object.assign(new Error('Unsupported card format'), { status: 400 }), req, res);
  const name = data.name || 'Imported';
  const first_message = data.first_mes || '';
  // Optional: set avatar if embedded path is resolvable; otherwise default
  const avatarId = `char_${Date.now().toString(36)}`;
  let avatarRel = '/st/default/content/default_Seraphina.png';
  const userDir = path.join(__dirname, 'data', 'users', auth.uid, 'avatars');
  fs.mkdirSync(userDir, { recursive: true });
  const destPath = path.join(userDir, `${avatarId}.png`);
  try { fs.writeFileSync(destPath, makeCardPngFromFile(null, data)); avatarRel = `/st-internal/assets/users/${auth.uid}/avatars/${avatarId}.png`; } catch {}
  const character = { name, avatar: avatarRel, chat: `${name} - ${new Date().toISOString()}`, first_mes: first_message, fav: false, shallow: false, data: { ...(data.data||{}), extensions: (data.data && data.data.extensions) || {} } };
  await addCharacter(auth.uid, character);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true, avatar: avatarRel });
});

// Character chats
app.post('/api/characters/chats', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const avatar_url = req.body?.avatar_url;
  const ch = await getCharacterByAvatar(auth.uid, avatar_url);
  if (!ch) return res.json({});
  const charId = ch.avatar; // use avatar URL as id
  const chats = await listCharacterChats(auth.uid, charId);
  const mapped = {};
  Object.keys(chats).forEach((name) => {
    const arr = chats[name] || [];
    const last = arr[arr.length - 1];
    const last_ts = last && (last.create_date || last.time || last.ts) ? Date.parse(last.create_date || last.time || last.ts) : 0;
    mapped[name] = { file_name: `${name}.jsonl`, last_mes: last_ts || Date.now(), message_count: arr.length, preview_message: last?.mes || '' };
  });
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json(mapped);
});

app.post('/api/chats/get', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const { file_name, avatar_url } = req.body || {};
  const ch = await getCharacterByAvatar(auth.uid, avatar_url);
  if (!ch) return res.json([]);
  const charId = ch.avatar;
  const messages = await getCharacterChat(auth.uid, charId, file_name) || [];
  const metadata = { create_date: new Date().toISOString(), chat_metadata: {} };
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json([metadata, ...messages]);
});

app.post('/api/chats/save', express.json({ limit: '5mb' }), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const { file_name, chat, avatar_url } = req.body || {};
  const ch = await getCharacterByAvatar(auth.uid, avatar_url);
  if (!ch) return toJsonError(Object.assign(new Error('Character Not Found'), { status: 404 }), req, res);
  const charId = ch.avatar;
  await saveCharacterChat(auth.uid, charId, file_name, Array.isArray(chat) ? chat : []);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

// Recent chats and search
app.post('/api/chats/recent', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) {
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    return res.json([]);
  }
  const max = Math.min(parseInt(req.body?.max || '10', 10) || 10, 50);
  const chars = await listCharacters(auth.uid);
  const results = [];
  for (const ch of chars) {
    const chats = await listCharacterChats(auth.uid, ch.avatar);
    for (const [name, arr] of Object.entries(chats)) {
      const last = arr[arr.length - 1];
      const last_ts = last && (last.create_date || last.time || last.ts) ? Date.parse(last.create_date || last.time || last.ts) : 0;
      results.push({ file_name: `${name}.jsonl`, last_mes: last_ts || Date.now(), message_count: arr.length, preview_message: last?.mes || '', avatar: ch.avatar });
    }
  }
  results.sort((a, b) => b.last_mes - a.last_mes);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json(results.slice(0, max));
});

app.post('/api/chats/search', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const query = String(req.body?.query || '').toLowerCase();
  const avatar_url = req.body?.avatar_url;
  const list = [];
  const chars = await listCharacters(auth.uid);
  for (const ch of chars) {
    if (avatar_url && ch.avatar !== avatar_url) continue;
    const chats = await listCharacterChats(auth.uid, ch.avatar);
    for (const [name, arr] of Object.entries(chats)) {
      const preview = arr[arr.length - 1]?.mes || '';
      const matches = !query || name.toLowerCase().includes(query) || preview.toLowerCase().includes(query);
      if (!matches) continue;
      const last = arr[arr.length - 1];
      const last_ts = last && (last.create_date || last.time || last.ts) ? Date.parse(last.create_date || last.time || last.ts) : 0;
      list.push({ file_name: `${name}.jsonl`, last_mes: last_ts || Date.now(), message_count: arr.length, preview_message: preview, file_size: `${arr.length} msgs` });
    }
  }
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json(list);
});

// Files & Images minimal compat
function ensureUserStatic(uid, sub) {
  const dir = path.join(__dirname, 'data', 'users', uid, sub);
  fs.mkdirSync(dir, { recursive: true });
  app.use(`/st-internal/assets/users/${uid}/${sub}`, express.static(dir));
  return dir;
}

app.post('/api/files/upload', upload.single('file'), (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const uid = auth.uid;
  if (!req.file) return toJsonError(Object.assign(new Error('file required'), { status: 400 }), req, res);
  const subdir = ensureUserStatic(uid, 'files');
  const ext = path.extname(req.file.originalname) || path.extname(req.file.filename) || '';
  const outName = `${Date.now().toString(36)}${ext}`;
  const dst = path.join(subdir, outName);
  fs.copyFileSync(req.file.path, dst);
  const url = `/st-internal/assets/users/${uid}/files/${outName}`;
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true, url });
});

app.post('/api/files/delete', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const uid = auth.uid;
  const url = req.body?.url || '';
  // Only allow delete within our static dir
  const prefix = `/st-internal/assets/users/${uid}/`;
  if (!url.startsWith(prefix)) return toJsonError(Object.assign(new Error('Forbidden'), { status: 403 }), req, res);
  const rel = url.substring(`/st-internal/assets/users/${uid}/`.length);
  const filePath = path.join(__dirname, 'data', 'users', uid, rel);
  try { fs.unlinkSync(filePath); } catch {}
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

app.post('/api/files/verify', express.json(), (req, res) => {
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  return res.json({ ok: true });
});

app.post('/api/files/sanitize-filename', express.json(), (req, res) => {
  const name = req.body?.file_name || '';
  const safe = String(name).replace(/[\\/:*?"<>|]+/g, '_');
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  return res.json({ file_name: safe });
});

app.post('/api/images/upload', upload.single('image'), (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const uid = auth.uid;
  if (!req.file) return toJsonError(Object.assign(new Error('image required'), { status: 400 }), req, res);
  const subdir = ensureUserStatic(uid, 'images');
  const ext = path.extname(req.file.originalname) || '.png';
  const outName = `${Date.now().toString(36)}${ext}`;
  const dst = path.join(subdir, outName);
  fs.copyFileSync(req.file.path, dst);
  const url = `/st-internal/assets/users/${uid}/images/${outName}`;
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true, url });
});

app.post('/api/images/list', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  const uid = auth?.uid || 'anon';
  const dir = path.join(__dirname, 'data', 'users', uid, 'images');
  let files = [];
  try { files = fs.readdirSync(dir); } catch {}
  const list = files.map(f => ({ file: f, url: `/st-internal/assets/users/${uid}/images/${f}` }));
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  return res.json(list);
});

// Backgrounds API
function listFilesSafe(dir) {
  try { return fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile()); } catch { return []; }
}

app.post('/api/backgrounds/all', express.json(), (_req, res) => {
  const defaultsDir = path.join(ROOT_DIR, 'SillyTavern', 'default', 'content', 'backgrounds');
  const builtins = listFilesSafe(defaultsDir);
  const managed = listFilesSafe(MANAGED_BACKGROUNDS_DIR);
  // Merge lists (managed first to prefer user assets)
  const images = Array.from(new Set([...managed, ...builtins]));
  const config = { width: 160, height: 90 };
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  return res.json({ images, config });
});

// Groups API (minimal alignment for UI)
app.post('/api/groups/all', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const groups = await listGroups(auth.uid);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json(groups);
});

app.post('/api/groups/create', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const { name, members = [] } = req.body || {};
  const id = `g_${Date.now().toString(36)}`;
  const group = { id, name: name || 'Group', members: members, chats: [id], chat_id: id, fav: false, disabled_members: [], past_metadata: {}, avatar_url: '' };
  await addGroup(auth.uid, group);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true, id });
});

app.post('/api/groups/edit', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const { id, name, members, avatar_url, fav } = req.body || {};
  if (!id) return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  const groups = await listGroups(auth.uid);
  const idx = groups.findIndex(g => String(g.id) === String(id));
  if (idx === -1) return toJsonError(Object.assign(new Error('Not Found'), { status: 404 }), req, res);
  const g = { ...groups[idx] };
  if (name !== undefined) g.name = name;
  if (Array.isArray(members)) g.members = members;
  if (avatar_url !== undefined) g.avatar_url = avatar_url;
  if (fav !== undefined) g.fav = !!fav;
  groups[idx] = g;
  await saveGroups(auth.uid, groups);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

app.post('/api/groups/delete', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const { id } = req.body || {};
  if (!id) return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  await deleteGroup(auth.uid, id);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

app.post('/api/backgrounds/upload', upload.single('avatar'), (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  if (!req.file) return toJsonError(Object.assign(new Error('file required'), { status: 400 }), req, res);
  const src = req.file.path;
  const base = path.basename(req.file.originalname).replace(/[^A-Za-z0-9._ -]+/g, '_');
  const dst = path.join(MANAGED_BACKGROUNDS_DIR, base);
  try { fs.copyFileSync(src, dst); } catch { return toJsonError(Object.assign(new Error('Upload failed'), { status: 500 }), req, res); }
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  return res.send(base);
});

app.post('/api/backgrounds/rename', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const { old_bg, new_bg } = req.body || {};
  if (!old_bg || !new_bg) return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  const src = path.join(MANAGED_BACKGROUNDS_DIR, path.basename(old_bg));
  const dst = path.join(MANAGED_BACKGROUNDS_DIR, path.basename(new_bg));
  if (!fs.existsSync(src)) return toJsonError(Object.assign(new Error('Forbidden or Not Found'), { status: 403 }), req, res);
  try { fs.renameSync(src, dst); } catch { return toJsonError(Object.assign(new Error('Rename failed'), { status: 500 }), req, res); }
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

app.post('/api/backgrounds/delete', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const { bg } = req.body || {};
  if (!bg) return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  const file = path.join(MANAGED_BACKGROUNDS_DIR, path.basename(bg));
  if (!fs.existsSync(file)) return toJsonError(Object.assign(new Error('Forbidden or Not Found'), { status: 403 }), req, res);
  try { fs.unlinkSync(file); } catch { return toJsonError(Object.assign(new Error('Delete failed'), { status: 500 }), req, res); }
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

// Presets API (minimal)
app.post('/api/presets/save', express.json({ limit: '1mb' }), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const { name, preset, apiId } = req.body || {};
  const category = normalizePresetCategory(apiId || (preset && preset.apiId) || 'openai');
  const resolvedName = String(name || (preset && preset.name) || '').trim();
  if (!resolvedName) {
    return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  }
  const payload = preset && typeof preset === 'object' ? { ...preset } : {};
  if (!Object.prototype.hasOwnProperty.call(payload, 'name')) payload.name = resolvedName;
  await savePreset(auth.uid, category, resolvedName, payload);
  await deletePresetAcrossCategories(auth.uid, category, resolvedName, { includePrimary: false });
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  res.json({ name: resolvedName });
});

app.post('/api/presets/delete', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const { name, apiId } = req.body || {};
  const resolvedName = String(name || '').trim();
  if (!resolvedName) {
    return toJsonError(Object.assign(new Error('Bad Request'), { status: 400 }), req, res);
  }
  const category = normalizePresetCategory(apiId || 'openai');
  await deletePresetAcrossCategories(auth.uid, category, resolvedName);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  res.json({ ok: true });
});

app.post('/api/presets/restore', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  const category = normalizePresetCategory(req.body?.apiId || 'openai');
  const name = String(req.body?.name || '').trim();
  let preset = {};
  let isDefault = false;
  if (name) {
    const defaultPreset = getDefaultPreset(category, name);
    if (defaultPreset) {
      preset = defaultPreset;
      isDefault = true;
    } else {
      const completionDefault = getDefaultCompletionPreset(category, name);
      if (completionDefault) {
        preset = completionDefault;
        isDefault = true;
      } else {
        const namedDefault = getDefaultNamedEntry(category, name);
        if (namedDefault) {
          preset = namedDefault;
          isDefault = true;
        } else if (auth) {
          const current = await findUserPresetByName(auth.uid, category, name);
          if (current) preset = current;
        }
      }
    }
  }
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  res.json({ isDefault, preset });
});

// World Info (minimal)
app.post('/api/worldinfo/get', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  const items = auth ? await getWorldInfo(auth.uid) : [];
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  res.json(items);
});

app.post('/api/worldinfo/edit', express.json({ limit: '1mb' }), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  await saveWorldInfo(auth.uid, items);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  res.json({ ok: true });
});

app.post('/api/worldinfo/delete', express.json(), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const existing = await getWorldInfo(auth.uid);
  const id = req.body?.id || req.body?.name;
  const filtered = existing.filter(x => (x.id || x.name) !== id);
  await saveWorldInfo(auth.uid, filtered);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  res.json({ ok: true });
});

app.post('/api/worldinfo/import', upload.single('file'), async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const existing = await getWorldInfo(auth.uid);
  const newItem = { id: `wi_${Date.now().toString(36)}`, name: req.body?.name || 'Imported', entries: [] };
  await saveWorldInfo(auth.uid, [...existing, newItem]);
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  res.json({ ok: true, id: newItem.id });
});

// Extensions (stubs to satisfy UI flows)
app.get('/api/extensions/discover', (_req, res) => {
  try {
    const extRoot = path.join(ST_PUBLIC, 'scripts', 'extensions');
    const list = [];
    const dirs = fs.readdirSync(extRoot).filter(d => !d.startsWith('.') && fs.statSync(path.join(extRoot, d)).isDirectory());
    for (const d of dirs) {
      const manifestPath = path.join(extRoot, d, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const j = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          list.push({ name: d, version: j.version || '0.0.0', description: j.description || j.display_name || '', enabled: false });
        } catch {}
      } else {
        // No manifest: still expose folder as a basic extension
        list.push({ name: d, version: '0.0.0', description: '', enabled: false });
      }
    }
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    res.json(list);
  } catch {
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    res.json([]);
  }
});
for (const p of ['update','delete','move','version','branches','switch','install']) {
  const method = p === 'discover' ? 'get' : 'post';
  app[method](`/api/extensions/${p}`, express.json(), (_req, res) => {
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    res.json({ ok: true });
  });
}

// Search (stubs)
app.post('/api/search/visit', express.json(), (req, res) => {
  const url = String(req.body?.url || '');
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  res.json({ ok: true, title: '', content: '', url });
});
app.post('/api/search/transcript', express.json(), (req, res) => {
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  res.json({ ok: true, transcript: '' });
});

app.post('/api/images/delete', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  const uid = auth.uid;
  const url = req.body?.url || '';
  const prefix = `/st-internal/assets/users/${uid}/images/`;
  if (!url.startsWith(prefix)) return toJsonError(Object.assign(new Error('Forbidden'), { status: 403 }), req, res);
  const file = url.replace(prefix, '');
  const filePath = path.join(__dirname, 'data', 'users', uid, 'images', file);
  try { fs.unlinkSync(filePath); } catch {}
  setDiagnostics(res, { target: 'compat', authSource: 'cookie' });
  return res.json({ ok: true });
});

app.post('/api/images/folders', express.json(), (req, res) => {
  const auth = requireAuth(req, res);
  const uid = auth?.uid || 'anon';
  const dir = path.join(__dirname, 'data', 'users', uid, 'images');
  let files = [];
  try { files = fs.readdirSync(dir); } catch {}
  const folders = [{ name: 'root', files: files.map(f => ({ file: f, url: `/st-internal/assets/users/${uid}/images/${f}` })) }];
  setDiagnostics(res, { target: 'compat', authSource: auth ? 'cookie' : 'none' });
  return res.json(folders);
});

// API: unified proxy stub (Stage 0: always JSON + unauthorized for write)
app.use('/api', async (req, res, next) => {
  const urlPath = req.path.startsWith('/api') ? req.path : `/api${req.path}`;
  const authHeader = req.get('authorization') || '';
  const tokenFromCookie = req.cookies && req.cookies['st_access'];
  const hasAuth = Boolean(authHeader || tokenFromCookie);
  setDiagnostics(res, { target: 'compat', authSource: authHeader ? 'header' : (tokenFromCookie ? 'cookie' : 'none') });

  // Owned endpoints handled locally
  if (isOwned(urlPath)) {
    if (urlPath === '/api/ping') {
      return res.json({ ok: true, time: Date.now() });
    }
    return toJsonError(Object.assign(new Error('Not Implemented'), { status: 501 }), req, res);
  }

  // If kill list active for this path => block
  if (isKilled(urlPath) && (config.killListEnabled === true || process.env.ST_KILLLIST === 'true')) {
    return toJsonError(Object.assign(new Error('Blocked by KillList'), { status: 451 }), req, res);
  }

  // Upstream fallback
  if ((config.enableUpstreamFallback === true || process.env.ST_ENABLE_FALLBACK === 'true') && (config.upstreamBase || process.env.ST_UPSTREAM_BASE)) {
    try {
      const upstreamUrl = new URL(urlPath, config.upstreamBase || process.env.ST_UPSTREAM_BASE).toString();
      const headers = new Headers(req.headers);
      if (!headers.has('authorization') && tokenFromCookie) {
        headers.set('authorization', `Bearer ${tokenFromCookie}`);
      }
      headers.delete('host');
      headers.delete('content-length');
      const method = req.method;
      const body = ['GET','HEAD'].includes(method) ? undefined : req;
      const upstreamRes = await fetch(upstreamUrl, { method, headers, body });
      res.status(upstreamRes.status);
      upstreamRes.headers.forEach((value, key) => {
        if (['content-encoding','content-length'].includes(key)) return;
        res.setHeader(key, value);
      });
      return upstreamRes.body.pipe(res);
    } catch {
      return toJsonError(Object.assign(new Error('Upstream error'), { status: 502 }), req, res);
    }
  }

  if (!hasAuth && !['GET','HEAD','OPTIONS'].includes((req.method || '').toUpperCase())) {
    return toJsonError(Object.assign(new Error('Unauthorized'), { status: 401 }), req, res);
  }
  // Radar log for unmapped endpoints when fallback is disabled
  try {
    const line = JSON.stringify({
      ts: Date.now(),
      path: urlPath,
      method: req.method,
      rid: res.locals.requestId,
    }) + '\n';
    const logDir = path.resolve(__dirname, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'radar.log'), line);
  } catch {}
  return toJsonError(Object.assign(new Error('Not Implemented'), { status: 501 }), req, res);
});

// 404 JSON for others
app.use((req, res) => {
  setDiagnostics(res, { target: 'none', authSource: 'none' });
  res.status(404).json({ error: true, status: 404, message: 'Not Found', requestId: res.locals.requestId });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error('[gateway] error:', err && err.stack || err);
  setDiagnostics(res, { target: 'error', authSource: 'none' });
  return toJsonError(err, req, res);
});

// Diagnostics endpoints
app.get('/api/_diagnostics/state', (req, res) => {
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  res.json({
    killListEnabled: config.killListEnabled,
    enableUpstreamFallback: config.enableUpstreamFallback,
    upstreamBase: config.upstreamBase,
    ownedEndpoints,
    killList: killListArray,
  });
});

app.post('/api/_diagnostics/toggle', express.json(), (req, res) => {
  const { killListEnabled, enableUpstreamFallback, upstreamBase } = req.body || {};
  if (typeof killListEnabled === 'boolean') config.killListEnabled = killListEnabled;
  if (typeof enableUpstreamFallback === 'boolean') config.enableUpstreamFallback = enableUpstreamFallback;
  if (typeof upstreamBase === 'string') config.upstreamBase = upstreamBase;
  setDiagnostics(res, { target: 'compat', authSource: 'none' });
  res.json({ ok: true, config: { killListEnabled: config.killListEnabled, enableUpstreamFallback: config.enableUpstreamFallback, upstreamBase: config.upstreamBase } });
});

app.get('/api/_diagnostics/radar', (req, res) => {
  try {
    const logDir = path.resolve(__dirname, 'logs');
    const p = path.join(logDir, 'radar.log');
    const tail = Number(req.query.tail || 200);
    const data = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').slice(-tail) : [];
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    res.json({ lines: data });
  } catch {
    return toJsonError(Object.assign(new Error('Failed to read radar'), { status: 500 }), req, res);
  }
});

app.delete('/api/_diagnostics/radar', (req, res) => {
  try {
    const logDir = path.resolve(__dirname, 'logs');
    const p = path.join(logDir, 'radar.log');
    if (fs.existsSync(p)) fs.unlinkSync(p);
    setDiagnostics(res, { target: 'compat', authSource: 'none' });
    res.json({ ok: true });
  } catch {
    return toJsonError(Object.assign(new Error('Failed to clear radar'), { status: 500 }), req, res);
  }
});

app.listen(PORT, () => {
  console.log(`[gateway] listening on http://localhost:${PORT}${BASE_PATH}`);
});
