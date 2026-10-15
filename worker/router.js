import { PARAM_SOURCE } from './ids.js';

// Routes: { method, path: '/api/guild/:gid/teams', auth, handler }. A route matches on its shape alone
// (any single path segment per parameter), so the caller can check the session first; the format of each
// parameter is then checked with paramsAreValid() and a malformed id is a plain 404.
function compile(route) {
  const names = [];
  const source = route.path.replace(/:([a-z]+)/g, (_, name) => {
    if (!PARAM_SOURCE[name]) throw new Error(`unknown route parameter :${name}`);
    names.push(name);
    return '([^/]+)';
  });
  return { ...route, names, pattern: new RegExp(`^${source}$`) };
}

const STRICT = Object.fromEntries(Object.entries(PARAM_SOURCE).map(([name, source]) => [name, new RegExp(`^${source}$`)]));

export function paramsAreValid(params) {
  return Object.entries(params).every(([name, value]) => STRICT[name].test(value));
}

export function createRouter(routes) {
  const compiled = routes.map(compile);
  return {
    // -> { route, params } | { allowed: [methods] } | null
    resolve(method, pathname) {
      const allowed = [];
      for (const route of compiled) {
        const match = route.pattern.exec(pathname);
        if (!match) continue;
        if (route.method === method) {
          const params = {};
          route.names.forEach((name, i) => { params[name] = match[i + 1]; });
          return { route, params };
        }
        allowed.push(route.method);
      }
      return allowed.length ? { allowed } : null;
    },
  };
}
