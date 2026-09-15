// The block page.
//
// Squid's deny_info sends a denied request here with ?url=<what was denied>. Every site is judged
// automatically the first time it is visited, so by the time anyone sees this page the verdict
// already exists — there is nothing to "request" and no button to press. The page says what was
// blocked and why, and stops. A parent who disagrees with a rating changes it in /admin.
//
// Three kinds of denial:
//   * a refused SEARCH — the words typed were rated above this phone's rung
//   * a blocked SITE  — the site's rating is above this phone's rung, or it is never allowed
//   * a LOCKED phone  — a schedule (the yeshiva shiur windows) has the web switched off right now
//
// A fourth thing lands here that is not a page at all: an IMAGE the phone's rung strips. Squid
// redirects every denial to this URL, an <img> included, and for those the Worker answers with
// renderBlankImage() — a flat placeholder that keeps the page's layout where the picture was.
//
// Self-contained HTML (no external assets, no script) so it works even though every other host is
// blocked, and renders instantly.
// rating: { level, reason } for the site, when known. The reason on file describes the SITE, not
// the denial — a rung-2 phone can be refused a site whose note reads "ordinary sports news". So
// the page says what the site is rated and lets that explain the block, rather than presenting
// the description as if it were an accusation.
function whyLine(rating) {
  if (!rating) return '';
  const { level, reason } = rating;
  const note = reason ? ` — ${String(reason).replace(/[.\s]+$/, '')}` : '';
  if (level >= 6) return `Not allowed on any phone${note}`;
  return `Rated ${level} of 5${note}. This phone is set lower.`;
}

// A flat, light-grey rectangle that stretches to whatever box the page gave the image, so a
// stripped picture leaves its shape behind rather than collapsing the layout around it. SVG rather
// than a bitmap: it scales to any size, weighs a few hundred bytes, and needs no binary in the
// source. preserveAspectRatio="none" is what makes it fill a box of any proportions.
export function renderBlankImage() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120" ' +
    'preserveAspectRatio="none"><rect width="160" height="120" fill="#dfe3e8"/></svg>';
}

export function renderBlockPage({ blockedUrl = '', kind = 'site', rating = null, detail = '' } = {}) {
  const esc = (s) => String(s).slice(0, 300)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  let host = '';
  try { host = blockedUrl ? new URL(blockedUrl).hostname : ''; } catch { host = ''; }

  const isSearch = kind === 'search';
  const isLocked = kind === 'locked';
  const title = isLocked ? 'The phone is locked right now'
    : isSearch ? 'That search isn’t allowed' : 'This site is blocked';
  const body = isLocked
    ? 'It’s shiur time. The web comes back when seder ends; calls and WhatsApp still work.'
    : isSearch
      ? 'The words in that search aren’t permitted on this phone. Try searching for something else.'
      : 'This site isn’t available on this phone.';
  const eyebrow = isLocked ? 'Shiur time' : isSearch ? 'Search not allowed' : 'Blocked';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${isLocked ? 'Phone locked' : isSearch ? 'Search not allowed' : 'Site blocked'}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 24px; line-height: 1.6;
    background: #0e1733; color: #eef0f6;
    display: flex; justify-content: center;
  }
  .wrap { width: 100%; max-width: 520px; padding-top: 40px; }
  .eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: .75rem; color: #8fa0c8; margin: 0 0 8px; }
  h1 { font-size: 1.6rem; margin: 0 0 12px; color: #f5eed4; font-family: Georgia, serif; }
  .site { color: #b9c2de; margin: 0 0 28px; word-break: break-all; }
  .card { background: #16224a; border: 1px solid #26356b; border-radius: 14px; padding: 22px; }
  p { margin: 0 0 12px; }
  p:last-child { margin: 0; }
  .why { color: #8fa0c8; font-size: .9rem; }
</style>
</head>
<body>
  <div class="wrap">
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    ${host && !isSearch && !isLocked ? `<p class="site">${esc(host)}</p>` : ''}
    <div class="card">
      <p>${body}</p>
      ${!isLocked && whyLine(rating) ? `<p class="why">${esc(whyLine(rating))}</p>` : ''}
      ${isSearch && detail && !/^cached$/i.test(detail) ? `<p class="why">${esc(detail)}</p>` : ''}
      ${isLocked ? '' : '<p class="why">If you need this for a legitimate reason, ask the person who set up this phone.</p>'}
    </div>
  </div>
</body>
</html>`;
}
