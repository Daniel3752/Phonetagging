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
    </div>

    <div class="card raised ok" id="clean">
      <h3>Approved</h3>
      <p>This site checked out and is now allowed. Reload the page to continue.</p>
    </div>

    <div class="card raised no" id="blocked">
      <h3>Not allowed</h3>
      <p id="blockedreason"></p>
      <p>If you need it for a legitimate reason, ask the person who set up this phone &mdash; they can allow it.</p>
    </div>

    <div class="card raised err" id="error">
      <h3>Couldn't check this site</h3>
      <p id="errmsg"></p>
      <button id="retry" type="button">Try again</button>
    </div>
  </div>

<script>
(function () {
  function id(x) { return document.getElementById(x); }

  var params = new URLSearchParams(location.search);
  var site = params.get('cf_site_uri') || '';
  id('site').textContent = site || '(unknown site)';

  var cards = { start: id('start'), clean: id('clean'), blocked: id('blocked'), error: id('error') };
  var btn = id('btn'), retry = id('retry'), errmsg = id('errmsg');
  var blockedreason = id('blockedreason');
  var DEFAULT_BLOCKED = "This site isn't on the approved list.";

  function show(name) { for (var k in cards) cards[k].style.display = (k === name ? 'block' : 'none'); }

  function fail(message) {
    errmsg.textContent = message;
    // The retry button lives inside the error card. It used to live in the start card, which show()
    // hides — so a failed check left no way to try again without reloading the block page.
    show('error');
    btn.disabled = false;
    btn.textContent = 'Check this site';
  }

  async function check() {
    if (!site) {
      fail("This page is missing the site address — ask whoever set up filtering to turn on 'Send policy context' for the block page.");
      return;
    }
    show('start');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      var res = await fetch('/api/verdict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: site }),
      });
      // A non-JSON body means something other than the worker answered (captive portal, proxy
      // error). Don't let JSON.parse throw an unhelpful SyntaxError at the user.
      var text = await res.text();
      var data;
      try { data = JSON.parse(text); } catch (_) { data = null; }
      if (!data) {
        fail("Couldn't reach the filtering server. Check your connection and try again.");
        return;
      }
      if (data.verdict === 'clean') { show('clean'); return; }
      if (data.verdict === 'blocked') {
        // Carries the useful case too: "not a readable web page", which tells the user why tapping
        // check again will never help and that the operator is the only route.
        blockedreason.textContent = data.reason || DEFAULT_BLOCKED;
        show('blocked');
        return;
      }
      fail(data.reason || data.error || "Couldn't check this site right now. Try again in a moment.");
    } catch (e) {
      fail((e && e.message) || "Couldn't reach the filtering server. Check your connection.");
    }
  }

  btn.addEventListener('click', check);
  retry.addEventListener('click', check);
})();
</script>
</body>
</html>`;
}
