/**
 * Minimal cookie jar compatible with Playwright storageState cookies.
 * Cookie shape: { name, value, domain, path, expires (-1 = session), httpOnly, secure, sameSite }.
 */
export class CookieJar {
  constructor(cookies = []) {
    this.cookies = cookies
      .filter((cookie) => cookie && typeof cookie.name === 'string' && typeof cookie.domain === 'string')
      .map((cookie) => ({ path: '/', expires: -1, ...cookie }));
    this.dirty = false;
  }

  header(url) {
    const target = toUrl(url);
    const now = Date.now() / 1000;
    const seen = new Set();
    return this.cookies
      .filter((cookie) => domainMatches(target.hostname, cookie.domain)
        && pathMatches(target.pathname, cookie.path)
        && !isExpired(cookie, now)
        && (!cookie.secure || target.protocol === 'https:'))
      .sort((a, b) => (b.path ?? '/').length - (a.path ?? '/').length
        || normalizeDomain(b.domain).length - normalizeDomain(a.domain).length)
      .filter((cookie) => {
        if (seen.has(cookie.name)) return false;
        seen.add(cookie.name);
        return true;
      })
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  store(url, setCookieHeaders = []) {
    const target = toUrl(url);
    for (const header of setCookieHeaders) {
      const cookie = parseSetCookie(header, target);
      if (!cookie) continue;
      const index = this.cookies.findIndex((item) => item.name === cookie.name
        && normalizeDomain(item.domain) === normalizeDomain(cookie.domain)
        && (item.path ?? '/') === cookie.path);
      const expired = isExpired(cookie, Date.now() / 1000);
      if (index >= 0) {
        if (expired) {
          this.cookies.splice(index, 1);
        } else {
          this.cookies[index] = cookie;
        }
      } else if (!expired) {
        this.cookies.push(cookie);
      }
      this.dirty = true;
    }
  }

  toJSON() {
    return this.cookies.map((cookie) => ({ ...cookie }));
  }
}

export function parseSetCookie(header, url) {
  const target = toUrl(url);
  const [pair, ...attributes] = String(header).split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: target.hostname,
    path: defaultPath(target.pathname),
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax'
  };
  let maxAge = null;
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join('=').trim();
    if (key === 'domain' && value) cookie.domain = `.${normalizeDomain(value)}`;
    else if (key === 'path' && value.startsWith('/')) cookie.path = value;
    else if (key === 'expires') {
      const time = Date.parse(value);
      if (Number.isFinite(time)) cookie.expires = Math.floor(time / 1000);
    } else if (key === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) maxAge = seconds;
    } else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite' && value) cookie.sameSite = value[0].toUpperCase() + value.slice(1).toLowerCase();
  }
  if (maxAge !== null) {
    cookie.expires = maxAge <= 0 ? 0 : Math.floor(Date.now() / 1000) + maxAge;
  }
  return cookie;
}

export function readSetCookies(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = typeof headers.get === 'function' ? headers.get('set-cookie') : null;
  return single ? [single] : [];
}

function toUrl(url) {
  return url instanceof URL ? url : new URL(url);
}

function normalizeDomain(domain) {
  return String(domain ?? '').replace(/^\./, '').toLowerCase();
}

function domainMatches(host, domain) {
  const normalized = normalizeDomain(domain);
  const lowerHost = host.toLowerCase();
  return lowerHost === normalized || lowerHost.endsWith(`.${normalized}`);
}

function pathMatches(requestPath, cookiePath = '/') {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function defaultPath(pathname) {
  const index = pathname.lastIndexOf('/');
  return index > 0 ? pathname.slice(0, index) : '/';
}

function isExpired(cookie, nowSeconds) {
  return typeof cookie.expires === 'number' && cookie.expires >= 0 && cookie.expires <= nowSeconds;
}
