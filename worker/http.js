// HTTP helpers: every Worker response carries the same security headers.
export const MAX_BODY_BYTES = 16 * 1024;

export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function baseHeaders(extra) {
  const headers = new Headers(SECURITY_HEADERS);
  for (const [key, value] of Object.entries(extra || {})) headers.set(key, value);
  return headers;
}

export function jsonResponse(data, status = 200, extraHeaders = {}, cookies = []) {
  const headers = baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorBody(code, message, extra = {}) {
  return { error: code, message, ...extra };
}

export function errorResponse(status, code, message, extra = {}, extraHeaders = {}) {
  return jsonResponse(errorBody(code, message, extra), status, extraHeaders);
}

// Response.redirect cannot carry cookies, so the 302 is built by hand.
export function redirectResponse(location, cookies = []) {
  const headers = baseHeaders({ Location: location });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!name || Object.prototype.hasOwnProperty.call(cookies, name)) continue;
    cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
}

export function serializeCookie(name, value, { maxAge, path = '/', httpOnly = true, secure = true, sameSite = 'Lax' } = {}) {
  const parts = [`${name}=${value}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  parts.push(`Path=${path}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  parts.push(`SameSite=${sameSite}`);
  return parts.join('; ');
}

// Non-GET requests from another site are refused: Sec-Fetch-Site says cross-site,
// or Origin names a host other than this request's own.
export function isCrossSite(request) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site.toLowerCase() === 'cross-site') return true;
  const origin = request.headers.get('Origin');
  if (origin === null) return false;
  try {
    return new URL(origin).host.toLowerCase() !== new URL(request.url).host.toLowerCase();
  } catch {
    return true;
  }
}

export function hasJsonContentType(request) {
  const type = request.headers.get('Content-Type');
  return typeof type === 'string' && /^application\/json\s*(;|$)/i.test(type.trim());
}

// Reads at most maxBytes (default MAX_BODY_BYTES); a JSON object is required.
export async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'too_large', 'The request body is too large.');
  }
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* the stream is already closed */ }
        throw new HttpError(413, 'too_large', 'The request body is too large.');
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'bad_request', 'The request body must be JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'bad_request', 'The request body must be a JSON object.');
  }
  return parsed;
}

// Constant-time string comparison in plain JS.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}

// A trimmed single-line string within [min, max] characters, or a 400 naming the field.
export function cleanText(value, field, { min = 1, max }) {
  if (typeof value !== 'string') throw new HttpError(400, 'bad_request', `${field} must be text.`, { field });
  const text = value.trim();
  const length = Array.from(text).length;
  if (length < min || length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new HttpError(400, 'bad_request', `${field} must be ${min === 0 ? 'at most' : `${min} to`} ${max} characters of plain text.`, { field });
  }
  return text;
}

// D1 wraps the SQLite error; the text can sit on error.message or error.cause.message.
export function isUniqueViolation(error) {
  const text = [error && error.message, error && error.cause && error.cause.message]
    .filter((part) => part !== undefined && part !== null).map(String).join(' ');
  return /UNIQUE constraint failed/i.test(text);
}
