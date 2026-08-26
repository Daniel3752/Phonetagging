// The block / request-access page.
//
// With DNS-level filtering there is no injected block page: a blocked lookup just fails in the
// browser, and Cloudflare never gets the chance to hand us the URL. So this page is reached
// DELIBERATELY — via a bookmark or a launcher tile — and asks the user which site they want.
//
// It still accepts Gateway's cf_site_uri when present, so it keeps working unchanged if full-URL
// path blocking is switched on later (that mode does inject a block page).
//
// Under the proxy architecture Squid DOES hand us the URL (via deny_info), so the page can tell the
// three denials apart instead of showing one undifferentiated wall:
//
//   * a site nobody has reviewed  -> offer to check it, which is the common case
//   * a site rated above this phone's rung -> say so; there is nothing to request
//   * a refused search -> say so; requesting "google.com" would not help, and offering a button
//     that cannot work is worse than offering none
//
// Self-contained HTML (no external assets) so it works even though every other host is blocked.
export function renderBlockPage({ blockedUrl = '', kind = 'site' } = {}) {
  // The URL is attacker-influenced — it arrives from whatever was typed into the address bar — so it
  // is escaped before going anywhere near the document.
  const safeUrl = String(blockedUrl).slice(0, 300)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const isSearch = kind === 'search';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${isSearch ? 'Search not allowed' : 'Request a site'}</title>
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
  .card.raised { display: none; }
  p { margin: 0 0 16px; }
  button {
    width: 100%; padding: 14px 18px; font-size: 1rem; font-weight: 600;
    border: 0; border-radius: 10px; cursor: pointer;
    background: #e8c96b; color: #1a1400;
  }
  button:disabled { opacity: .6; cursor: default; }
  h3 { margin: 0 0 8px; font-family: Georgia, serif; }
  .ok h3 { color: #a8dcab; }
  .no h3 { color: #f0c96b; }
  .err h3 { color: #e08a8a; }
  .msg { margin-top: 12px; min-height: 1.2em; color: #e08a8a; font-size: .9rem; }
  input[type=text] {
    width: 100%; padding: 13px 14px; font-size: 1rem; margin-bottom: 12px;
    border-radius: 10px; border: 1px solid #33447f;
    background: #0e1733; color: #eef0f6;
  }
  input[type=text]:focus { outline: 2px solid #e8c96b; outline-offset: 1px; }
  label { display: block; font-size: .85rem; color: #8fa0c8; margin-bottom: 6px; }
</style>
</head>
<body>
  <div class="wrap">
    <p class="eyebrow">${isSearch ? 'Search not allowed' : 'Request a site'}</p>
    <h1>${isSearch ? 'That search isn\'t allowed' : 'Ask for a site to be approved'}</h1>
    <p class="site" id="site">${isSearch ? '' : safeUrl}</p>

    ${isSearch ? `<div class="card no">
      <h3>Not allowed</h3>
      <p>The words in that search aren't permitted on this phone. Try searching for something else.</p>
      <p>If you need this for a legitimate reason, ask the person who set up this phone.</p>
    </div>` : ''}

    <div class="card" id="start"${isSearch ? ' style="display:none"' : ''}>
      <p>New sites are checked automatically. Most ordinary sites are approved within a few seconds.</p>
      <label for="url">Site address</label>
      <input type="text" id="url" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="example.com">
      <button id="btn" type="button">Check this site</button>
      <div class="msg" id="msg"></div>
    </div>

    <div class="card raised ok" id="clean">
      <h3>Approved</h3>
      <p>This site checked out and is now allowed. Open it again to continue — you may need to wait a moment for the change to reach this phone.</p>
    </div>

    <div class="card raised no" id="blocked">
      <h3>Not allowed</h3>
      <p>This site isn't on the approved list. If you need it for a legitimate reason, ask the person who set up this phone — they can allow it.</p>
    </div>

    <div class="card raised err" id="error">
      <h3>Couldn't check this site</h3>
      <p id="errmsg"></p>
    </div>
  </div>

<script>
(function () {
  function id(x) { return document.getElementById(x); }

  // Gateway supplies cf_site_uri only when a full-URL HTTP block page injected it. Under DNS
  // filtering it is absent and the user types the site instead.
  // Squid's deny_info supplies ?url=; Gateway's HTTP block page supplied cf_site_uri. Accept both so
  // the page works under either enforcement layer.
  var params = new URLSearchParams(location.search);
  var raw = params.get('url') || params.get('cf_site_uri') || '';
  var prefill = '';
  try { prefill = raw ? new URL(raw).hostname : ''; } catch (e) { prefill = raw; }

  var cards = { start: id('start'), clean: id('clean'), blocked: id('blocked'), error: id('error') };
  var btn = id('btn'), msg = id('msg'), errmsg = id('errmsg'), input = id('url');

  if (prefill) {
    input.value = prefill;
    id('site').textContent = prefill;
  }
  function show(name) { for (var k in cards) cards[k].style.display = (k === name ? 'block' : 'none'); }

  function reset() { btn.disabled = false; btn.textContent = 'Check this site'; }

  async function check() {
    var site = input.value.trim();
    if (!site) { msg.textContent = 'Type a site address first.'; input.focus(); return; }

    btn.disabled = true; btn.textContent = 'Checking\u2026'; msg.textContent = '';
    try {
      var res = await fetch('/api/verdict', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: site }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      if (data.verdict === 'clean') { show('clean'); }
      else if (data.verdict === 'blocked') { show('blocked'); }
      else {
        errmsg.textContent = data.reason || "Couldn't check this site right now. Try again in a moment.";
        show('error'); reset();
      }
    } catch (e) {
      errmsg.textContent = e.message || "Couldn't reach the filtering server. Check your connection.";
      show('error'); reset();
    }
  }

  btn.addEventListener('click', check);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') check(); });
})();
</script>
</body>
</html>`;
}
