// The page Cloudflare Gateway redirects a blocked phone to. Gateway appends policy context as a
// query string (the block policy has "Send policy context" on) — cf_site_uri is the full URL that
// got blocked. The page offers a "Check this site" button that calls /api/verdict; a clean site is
// added to the allowlist and the user just reloads, anything else stays blocked.
//
// Self-contained HTML (no external assets) so it works even though every other host is blocked.
export function renderBlockPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site blocked</title>
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
</style>
</head>
<body>
  <div class="wrap">
    <p class="eyebrow">Site blocked</p>
    <h1>This site isn't on the approved list</h1>
    <p class="site" id="site"></p>

    <div class="card" id="start">
      <p>New sites are checked automatically. Most ordinary sites are approved within a few seconds. Tap below to check this one.</p>
      <button id="btn" type="button">Check this site</button>
      <div class="msg" id="msg"></div>
    </div>

    <div class="card raised ok" id="clean">
      <h3>Approved</h3>
      <p>This site checked out and is now allowed. Reload the page to continue.</p>
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
  var params = new URLSearchParams(location.search);
  var site = params.get('cf_site_uri') || '';
  document.getElementById('site').textContent = site || '(unknown site)';

  var cards = { start: id('start'), clean: id('clean'), blocked: id('blocked'), error: id('error') };
  var btn = id('btn'), msg = id('msg'), errmsg = id('errmsg');
  function id(x) { return document.getElementById(x); }
  function show(name) { for (var k in cards) cards[k].style.display = (k === name ? 'block' : 'none'); }

  btn.addEventListener('click', async function () {
    if (!site) {
      errmsg.textContent = "This page is missing the site address — ask whoever set up filtering to turn on 'Send policy context' for the block page.";
      show('error'); return;
    }
    btn.disabled = true; btn.textContent = 'Checking…'; msg.textContent = '';
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
        show('error'); btn.disabled = false; btn.textContent = 'Check this site';
      }
    } catch (e) {
      errmsg.textContent = e.message || "Couldn't reach the filtering server. Check your connection.";
      show('error'); btn.disabled = false; btn.textContent = 'Check this site';
    }
  });
})();
</script>
</body>
</html>`;
}
