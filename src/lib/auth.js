// auth.js — password hashing (PBKDF2) + stateless signed tokens (HMAC-SHA256).
// Pure Web Crypto, so it runs identically in the Worker and in Node (for seeding).

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const ub64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ub64url = (s) => ub64(s.replace(/-/g, "+").replace(/_/g, "/"));

const PBKDF2_ITERS = 100_000;

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, PBKDF2_ITERS);
  return `pbkdf2$${PBKDF2_ITERS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, iters, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const bits = await deriveBits(password, ub64(saltB64), Number(iters));
  const got = b64(new Uint8Array(bits));
  // length-safe compare
  if (got.length !== hashB64.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hashB64.charCodeAt(i);
  return diff === 0;
}

async function deriveBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
}

// token = base64url(payload) + "." + base64url(HMAC-SHA256(payload, secret))
export async function signToken(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(body, secret)}`;
}

export async function verifyToken(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!timingSafeEqual(sig, await hmac(body, secret))) return null;
  let payload;
  try { payload = JSON.parse(dec.decode(ub64url(body))); } catch { return null; }
  if (payload && payload.exp && Date.now() > payload.exp) return null;   // expired
  return payload;
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function hmac(data, secret) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(new Uint8Array(sig));
}
