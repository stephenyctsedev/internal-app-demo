// Passkeys (WebAuthn) without a library: just enough to bind a person's key
// to the devices the owner approved.
//   - challenges and sessions are HMAC-signed tokens (no server storage);
//   - registration reads the public key out of the attestation object
//     (attestation "none": we don't trust the authenticator's make, the
//     owner's tick in 裝置 is the trust decision);
//   - sign-in checks the signature over authenticatorData ‖ SHA-256(clientDataJSON).
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { HttpError, serviceAccountKey } from "./_lib.js";

export const SESSION_DAYS = 30;
const CHALLENGE_MS = 10 * 60_000;
export const ALGS = { "-7": "ES256", "-257": "RS256" };

// --- signed tokens -------------------------------------------------------------

function secret() {
  // Derived from the service account's private key, so there is no extra
  // secret to set up; rotating that key logs everyone out (by design).
  const sa = serviceAccountKey();
  if (!sa) throw new HttpError(500, "not_configured", "未設定 Google service account。");
  return createHash("sha256").update("demo-session\0").update(sa).digest();
}

const mac = (s) => createHmac("sha256", secret()).update(s).digest("base64url");

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body)}`;
}

function unsign(token) {
  if (typeof token !== "string") return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return typeof p?.e === "number" && p.e > Date.now() ? p : null;
  } catch {
    return null;
  }
}

/** A challenge for this key and purpose ("create" / "get"), valid 10 min. */
export const newChallenge = (keyHash, purpose) =>
  sign({ k: keyHash.slice(0, 32), p: purpose, n: randomBytes(12).toString("base64url"), e: Date.now() + CHALLENGE_MS });

/** Session after a passkey ceremony: which key, which credential. */
export const newSession = (keyHash, credId) =>
  sign({ k: keyHash.slice(0, 32), c: credId, e: Date.now() + SESSION_DAYS * 86400_000 });

/** The credential ID a session cookie vouches for, or null. */
export function sessionCred(token, keyHash) {
  const p = unsign(token);
  return p && p.k === keyHash.slice(0, 32) && typeof p.c === "string" && !p.p ? p.c : null;
}

// --- cookies -----------------------------------------------------------------

/** One cookie per key, so two people can share a browser. */
export const cookieName = (keyHash) => `sw_${keyHash.slice(0, 12)}`;

export function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(req, keyHash, token) {
  const secure = siteOf(req).origin.startsWith("https:") ? "; Secure" : "";
  return `${cookieName(keyHash)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

// --- where are we --------------------------------------------------------------

/** Origin + RP ID from the request (passkeys belong to that exact domain). */
export function siteOf(req) {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim();
  const hostname = host.replace(/:\d+$/, "");
  const local = hostname === "localhost" || hostname === "127.0.0.1";
  const proto = String(req.headers["x-forwarded-proto"] ?? (local ? "http" : "https")).split(",")[0].trim();
  return { origin: `${proto}://${host}`, rpId: hostname };
}

// --- minimal CBOR (enough for attestation objects and COSE keys) ------------------

function cbor(buf) {
  let i = 0;
  const len = (info) => {
    if (info < 24) return info;
    if (info === 24) return buf[i++];
    if (info === 25) return (i += 2), buf.readUInt16BE(i - 2);
    if (info === 26) return (i += 4), buf.readUInt32BE(i - 4);
    throw new Error("cbor: length too big");
  };
  const item = () => {
    const b = buf[i++];
    const type = b >> 5;
    const info = b & 31;
    switch (type) {
      case 0:
        return len(info);
      case 1:
        return -1 - len(info);
      case 2: {
        const n = len(info);
        return (i += n), buf.subarray(i - n, i);
      }
      case 3: {
        const n = len(info);
        return (i += n), buf.toString("utf8", i - n, i);
      }
      case 4:
        return Array.from({ length: len(info) }, item);
      case 5: {
        const m = new Map();
        for (let n = len(info); n > 0; n--) m.set(item(), item());
        return m;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error("cbor: unsupported simple value");
      default:
        throw new Error("cbor: unsupported type");
    }
  };
  return item();
}

/** COSE_Key (ES256 / RS256) → SPKI DER, base64. */
function coseToSpki(cose) {
  const alg = cose.get(3);
  let jwk;
  if (alg === -7 && cose.get(1) === 2 && cose.get(-1) === 1) {
    jwk = { kty: "EC", crv: "P-256", x: Buffer.from(cose.get(-2)).toString("base64url"), y: Buffer.from(cose.get(-3)).toString("base64url") };
  } else if (alg === -257 && cose.get(1) === 3) {
    jwk = { kty: "RSA", n: Buffer.from(cose.get(-1)).toString("base64url"), e: Buffer.from(cose.get(-2)).toString("base64url") };
  } else {
    throw new HttpError(400, "bad_passkey", "呢部裝置嘅 passkey 類型未支援。");
  }
  return { alg, spki: createPublicKey({ key: jwk, format: "jwk" }).export({ type: "spki", format: "der" }).toString("base64") };
}

// --- ceremonies ------------------------------------------------------------------

const b64u = (s, what) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length > 20000) throw new HttpError(400, "bad_passkey", `bad ${what}`);
  return Buffer.from(s, "base64url");
};

function checkClientData(raw, type, keyHash, purpose, site) {
  let cd;
  try {
    cd = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_passkey", "bad clientDataJSON");
  }
  if (cd.type !== type) throw new HttpError(400, "bad_passkey", "wrong ceremony");
  if (cd.origin !== site.origin) throw new HttpError(400, "bad_passkey", "wrong origin");
  const token = Buffer.from(String(cd.challenge ?? ""), "base64url").toString("utf8");
  const p = unsign(token);
  if (!p || p.p !== purpose || p.k !== keyHash.slice(0, 32)) {
    throw new HttpError(400, "stale", "頁面過咗期，請重新整理再試。");
  }
}

function checkAuthData(ad, site) {
  if (ad.length < 37) throw new HttpError(400, "bad_passkey", "short authenticatorData");
  const rpHash = createHash("sha256").update(site.rpId).digest();
  if (!ad.subarray(0, 32).equals(rpHash)) throw new HttpError(400, "bad_passkey", "wrong rpId");
  const flags = ad[32];
  if (!(flags & 0x01) || !(flags & 0x04)) throw new HttpError(400, "bad_passkey", "要用 Face ID／指紋／螢幕鎖確認。");
  return flags;
}

/** navigator.credentials.create() result → { credId, alg, spki }. */
export function verifyRegistration(cred, keyHash, site) {
  const clientData = b64u(cred?.clientDataJSON, "clientDataJSON");
  checkClientData(clientData, "webauthn.create", keyHash, "create", site);
  let att;
  try {
    att = cbor(b64u(cred?.attestationObject, "attestationObject"));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "bad_passkey", "bad attestationObject");
  }
  const ad = Buffer.from(att instanceof Map ? att.get("authData") ?? [] : []);
  const flags = checkAuthData(ad, site);
  if (!(flags & 0x40) || ad.length < 55) throw new HttpError(400, "bad_passkey", "no credential data");
  const idLen = ad.readUInt16BE(53);
  const credId = ad.subarray(55, 55 + idLen).toString("base64url");
  if (!credId || credId !== cred?.id) throw new HttpError(400, "bad_passkey", "credential id mismatch");
  let cose;
  try {
    cose = cbor(ad.subarray(55 + idLen));
  } catch {
    throw new HttpError(400, "bad_passkey", "bad public key");
  }
  if (!(cose instanceof Map)) throw new HttpError(400, "bad_passkey", "bad public key");
  return { credId, ...coseToSpki(cose) };
}

/** navigator.credentials.get() result, checked against the stored device. */
export function verifyAssertion(cred, device, keyHash, site) {
  const clientData = b64u(cred?.clientDataJSON, "clientDataJSON");
  checkClientData(clientData, "webauthn.get", keyHash, "get", site);
  const ad = b64u(cred?.authenticatorData, "authenticatorData");
  checkAuthData(ad, site);
  const sig = b64u(cred?.signature, "signature");
  const data = Buffer.concat([ad, createHash("sha256").update(clientData).digest()]);
  let ok = false;
  try {
    const key = createPublicKey({ key: Buffer.from(device.spki, "base64"), format: "der", type: "spki" });
    ok = verify("sha256", data, device.alg === -7 ? { key, dsaEncoding: "der" } : key, sig);
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(401, "bad_passkey", "Passkey 驗證唔到。");
}
