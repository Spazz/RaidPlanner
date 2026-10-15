// Random TEXT ids: a prefix + 16 random bytes in base64url (22 characters).
const PATTERNS = {
  u: /^u_[A-Za-z0-9_-]{22}$/,
  g: /^g_[A-Za-z0-9_-]{22}$/,
  t: /^t_[A-Za-z0-9_-]{22}$/,
  ra: /^ra_[A-Za-z0-9_-]{22}$/,
  al: /^al_[A-Za-z0-9_-]{22}$/,
};

export function defaultRandomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newId(prefix, randomBytes) {
  if (!PATTERNS[prefix]) throw new Error('unknown id prefix');
  return `${prefix}_${base64url(randomBytes(16))}`;
}

export function isId(prefix, value) {
  return typeof value === 'string' && !!PATTERNS[prefix] && PATTERNS[prefix].test(value);
}

// Route-parameter name -> the regex source that parameter must match.
export const PARAM_SOURCE = {
  gid: 'g_[A-Za-z0-9_-]{22}',
  tid: 't_[A-Za-z0-9_-]{22}',
  uid: 'u_[A-Za-z0-9_-]{22}',
};
