// The block page.
//
// Squid's deny_info sends a denied request here with ?url=<what was denied>. Every site is judged
// automatically the first time it is visited, so by the time anyone sees this page the verdict
// already exists — there is nothing to "request" and no button to press. The page says what was
// blocked and why, and stops. A parent who disagrees with a rating changes it in /admin.
//
// Two kinds of denial:
//   * a refused SEARCH — the words typed were rated above this phone's rung
//   * a blocked SITE  — the site's rating is above this phone's rung, or it is never allowed
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
  const note = reason ? ` — ${reason}` : '';
  if (level >= 6) return `Not allowed on any phone${note}`;
  return `Rated ${level} of 5${note}. This phone is set lower.`;
}

export function renderBlockPage({ blockedUrl = '', kind = 'site', rating = null } = {}) {
  const esc = (s) => String(s).slice(0, 300)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  let host = '';
  try { host = blockedUrl ? new URL(blockedUrl).hostname : ''; } catch { host = ''; }

  const isSearch = kind === 'search';
  const title = isSearch ? 'That search isn’t allowed' : 'This site is blocked';
  const body = isSearch
    ? 'The words in that search aren’t permitted on this phone. Try searching for something else.'
    : 'This site isn’t available on this phone.';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${isSearch ? 'Search not allowed' : 'Site blocked'}</title>
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
    <p class="eyebrow">${isSearch ? 'Search not allowed' : 'Blocked'}</p>
    <h1>${title}</h1>
    ${host && !isSearch ? `<p class="site">${esc(host)}</p>` : ''}
    <div class="card">
      <p>${body}</p>
      ${whyLine(rating) ? `<p class="why">${esc(whyLine(rating))}</p>` : ''}
      <p class="why">If you need this for a legitimate reason, ask the person who set up this phone.</p>
    </div>
  </div>
</body>
</html>`;
}
