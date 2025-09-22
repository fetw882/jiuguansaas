import crypto from 'crypto';

const SECRET = process.env.ST_AUTH_SECRET || 'dev-secret-change-me';

export function signToken(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const sig = hmac(`${header}.${body}`);
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token) {
  const [h, b, s] = String(token || '').split('.');
  if (!h || !b || !s) return null;
  const expected = hmac(`${h}.${b}`);
  if (!timingSafeEqual(expected, s)) return null;
  try {
    return JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function hmac(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

function base64url(str) {
  return Buffer.from(str, 'utf8').toString('base64url');
}

function timingSafeEqual(a, b) {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

