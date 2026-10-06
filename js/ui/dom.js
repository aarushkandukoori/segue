// Small DOM helpers shared by the view modules.
// Everything that puts an untrusted string or URL into the page goes through here:
// text via textContent, URLs only after an https:/blob: check.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);

/**
 * @param {unknown} u
 * @returns {string} the normalized URL if it is an absolute https: or blob: URL, otherwise ''
 */
export function safeUrl(u) {
  if (typeof u !== 'string' || !u) return '';
  try {
    const parsed = new URL(u);
    if (parsed.protocol === 'blob:') return parsed.href;
    // https only, and never with credentials in front of the host (same rule as sources/util.js
    // httpsUrl): "https://familiar-name@other.host/" reads like a link to the wrong place.
    return parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password ? parsed.href : '';
  } catch {
    return '';
  }
}

/** True when `host` is `domain` itself or a subdomain of it — never a look-alike that merely ends with it. */
const onDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

const lastText = new WeakMap();

/** textContent write that is skipped when the text did not change (safe to call every frame). */
export function setText(el, value) {
  const s = value == null ? '' : String(value);
  if (lastText.get(el) === s) return false;
  lastText.set(el, s);
  el.textContent = s;
  return true;
}

/** "m:ss" (or "h:mm:ss"). Negative / non-finite input renders as 0:00. */
export function fmtTime(sec) {
  let s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const ss = String(s - m * 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Point an <img> at an untrusted URL. Its parent only gets .has-img (which is what makes the image
 * visible; a CSS placeholder shows otherwise) once the image has actually loaded, so a broken or
 * non-https URL never shows a broken-image icon.
 * @param {HTMLImageElement} img
 * @param {unknown} url
 */
export function setImage(img, url) {
  const safe = safeUrl(url);
  if (img.dataset.url === safe) return;
  img.dataset.url = safe;
  img.parentElement?.classList.remove('has-img');
  if (!safe) {
    img.removeAttribute('src');
    return;
  }
  if (!img.dataset.bound) {
    img.dataset.bound = '1';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.addEventListener('load', () => {
      if (img.dataset.url) img.parentElement?.classList.add('has-img');
    });
    img.addEventListener('error', () => img.parentElement?.classList.remove('has-img'));
  }
  img.src = safe;
}

/**
 * Point an <a> at an untrusted URL. Without a safe URL the anchor loses its href (so it is inert) and is
 * hidden, unless `keepVisible` — then it simply renders as plain text.
 * @param {HTMLAnchorElement} a
 * @param {unknown} url
 * @param {boolean} [keepVisible]
 * @returns {boolean} whether the link is live
 */
export function setLink(a, url, keepVisible = false) {
  const safe = safeUrl(url);
  if (a.dataset.url === safe) return !!safe;
  a.dataset.url = safe;
  if (safe) {
    a.href = safe;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.hidden = false;
  } else {
    a.removeAttribute('href');
    a.removeAttribute('target');
    a.hidden = !keepVisible;
  }
  return !!safe;
}

/** "Open in Spotify" style label from a track / playlist URL. */
export function linkLabel(url) {
  const safe = safeUrl(url);
  if (!safe) return '';
  let host = '';
  try {
    host = new URL(safe).hostname;
  } catch {
    return 'Open track';
  }
  // Only a link that really is on the service gets the service's name; anything else is just "a link".
  if (onDomain(host, 'spotify.com')) return 'Open in Spotify';
  if (onDomain(host, 'deezer.com') || onDomain(host, 'deezer.page.link')) return 'Open in Deezer';
  if (onDomain(host, 'apple.com')) return 'Open in Apple Music';
  if (onDomain(host, 'youtube.com') || onDomain(host, 'youtu.be') || onDomain(host, 'youtube-nocookie.com')) return 'Open on YouTube';
  return 'Open track';
}

/** Map of data-ref name → element under `root`. */
export function collectRefs(root) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const el of root.querySelectorAll('[data-ref]')) out[el.dataset.ref] = el;
  return out;
}

/** createElement with a class and optional text (textContent). */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** True when a key event should be left alone because the user is typing / operating a form control. */
export function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}
