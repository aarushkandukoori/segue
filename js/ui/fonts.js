// Web fonts are a nicety, never a dependency: the page has to paint and the app has to boot when the
// font host is slow, blocked or never answers at all. A plain <link rel="stylesheet"> in <head> would
// hold back both rendering and every script until that request settles, so index.html declares the
// font stylesheet with media="print" (fetched in the background, blocks nothing) and this module
// switches it on once it has arrived. Until then, and for good if it never arrives, text is set in the
// system fallbacks listed in css/style.css.
//
// The usual one-liner for this is an inline onload="…" attribute, which the page's
// Content-Security-Policy (no inline script) rightly refuses.

for (const link of /** @type {NodeListOf<HTMLLinkElement>} */ (document.querySelectorAll('link[rel="stylesheet"][data-defer]'))) {
  const apply = () => {
    link.media = 'all';
  };
  if (link.sheet) apply();
  else link.addEventListener('load', apply, { once: true });
}
