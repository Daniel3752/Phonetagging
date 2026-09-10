// The operator console, served at /admin.
//
// Self-contained HTML with no external assets, for the same reason the request page is: the
// operator may well be using a phone that is itself behind the default-deny filter, where the
// worker's own host is the only thing that resolves.
//
// The page holds no secrets. The operator pastes the OPERATOR_KEY, which is kept in sessionStorage
// (cleared when the tab closes) and sent as a bearer token on every API call — the worker is what
// enforces access, not this page.
export function renderAdminPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phone filter — operator console</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 20px; line-height: 1.55;
    background: #0e1733; color: #eef0f6;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-family: Georgia, serif; color: #f5eed4; font-size: 1.5rem; margin: 0 0 4px; }
  .sub { color: #8fa0c8; font-size: .9rem; margin: 0 0 24px; }
  h2 { font-family: Georgia, serif; color: #f5eed4; font-size: 1.1rem; margin: 0 0 12px; }
  .card { background: #16224a; border: 1px solid #26356b; border-radius: 14px; padding: 20px; margin-bottom: 16px; }
  label { display: block; font-size: .8rem; color: #8fa0c8; margin: 10px 0 4px; }
  input, select {
    width: 100%; padding: 10px 12px; font-size: .95rem;
    border-radius: 9px; border: 1px solid #33447f; background: #0e1733; color: #eef0f6;
  }
  input:focus, select:focus { outline: 2px solid #e8c96b; outline-offset: 1px; }
  button {
    padding: 10px 16px; font-size: .95rem; font-weight: 600; margin-top: 14px;
    border: 0; border-radius: 9px; cursor: pointer; background: #e8c96b; color: #1a1400;
  }
  button.ghost { background: transparent; color: #b9c2de; border: 1px solid #33447f; }
  button:disabled { opacity: .55; cursor: default; }
  nav { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
  nav button { margin: 0; background: #16224a; color: #b9c2de; border: 1px solid #26356b; font-weight: 500; }
  nav button.on { background: #e8c96b; color: #1a1400; border-color: #e8c96b; }
  table { width: 100%; border-collapse: collapse; font-size: .88rem; margin-top: 8px; }
  th { text-align: left; color: #8fa0c8; font-weight: 600; border-bottom: 1px solid #26356b; padding: 8px 6px; }
  td { padding: 8px 6px; border-bottom: 1px solid #1c2a57; vertical-align: top; word-break: break-word; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .row > * { flex: 1 1 160px; }
  .pill { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: .74rem; font-weight: 600; }
  .pill.allowed, .pill.clean { background: #1d4030; color: #a8dcab; }
  .pill.blocked { background: #46231f; color: #f0a9a9; }
  .pill.hidden { background: #3c3520; color: #e8c96b; }
  .msg { margin-top: 10px; font-size: .88rem; min-height: 1.2em; }
  .msg.err { color: #e08a8a; }
  .msg.ok { color: #a8dcab; }
  .empty { color: #6b7ba8; font-style: italic; font-size: .88rem; }
  .days { display: flex; gap: 4px; }
  .days label { display: flex; flex-direction: column; align-items: center; gap: 3px; margin: 0; font-size: .7rem; }
  .days input { width: auto; }
  code { background: #0e1733; padding: 1px 5px; border-radius: 4px; font-size: .85em; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Operator console</h1>
  <p class="sub">App control, site approvals and schedules for every managed phone.</p>

  <div class="card" id="auth">
    <h2>Operator key</h2>
    <input type="password" id="key" placeholder="OPERATOR_KEY" autocomplete="current-password">
    <button id="unlock" type="button">Unlock</button>
    <div class="msg err" id="authmsg"></div>
  </div>

  <div id="app" style="display:none">
    <nav>
      <button data-tab="devices" class="on">Devices</button>
      <button data-tab="apps">Policies &amp; apps</button>
      <button data-tab="schedules">Schedules</button>
      <button data-tab="yeshiva">Yeshiva</button>
      <button data-tab="sites">Sites</button>
      <button data-tab="searches">Searches</button>
      <button data-tab="audit">Audit</button>
    </nav>

    <section data-panel="devices">
      <div class="card">
        <h2>Enrolled phones</h2>
        <div id="deviceTable"></div>
      </div>
      <div class="card">
        <h2 id="deviceFormTitle">Add a phone</h2>
        <div class="row">
          <div><label for="dLabel">Label</label><input id="dLabel" placeholder="Cohen family — Dovid"></div>
          <div><label for="dHw">Headwind device id</label><input id="dHw" placeholder="42"></div>
        </div>
        <div class="row">
          <div><label for="dPolicy">Baseline policy</label><select id="dPolicy"></select></div>
          <div><label for="dTz">Time zone</label><input id="dTz" placeholder="America/New_York" value="UTC"></div>
        </div>
        <div class="row">
          <div><label for="dTag">Tag (ladder)</label><select id="dTag"></select></div>
          <div><label for="dLevel">Rung</label><select id="dLevel"></select></div>
          <div><label for="dProxy">Proxy login / tunnel IP</label><input id="dProxy" placeholder="10.66.0.4"></div>
        </div>
        <p class="empty" style="margin:0 0 12px">Leave the login blank to derive it from the label. A
          password is generated automatically and kept on re-save. After saving, run the
          <code>htpasswd</code> line shown below on the proxy — the phone has no web until that
          account exists, and a phone with no login falls back to the strictest rung.</p>
        <button id="saveDevice" type="button">Save phone</button>
        <button id="cancelEdit" type="button" class="ghost" style="display:none">Cancel</button>
        <div class="msg" id="deviceMsg"></div>
        <div id="deviceCreds"></div>
      </div>
    </section>

    <section data-panel="apps" style="display:none">
      <div class="card">
        <h2>Policies</h2>
        <div id="policyTable"></div>
        <div class="row">
          <div><label for="pName">New policy name</label><input id="pName" placeholder="evening"></div>
          <div><label for="pCfg">Headwind configuration id</label><input id="pCfg" placeholder="3"></div>
        </div>
        <div class="row">
          <div><label for="pDefault">Apps not listed are</label>
            <select id="pDefault">
              <option value="allowed">allowed (a blocklist)</option>
              <option value="blocked">blocked (an allowlist)</option>
            </select>
          </div>
          <div><label for="pWeb">Browser while this policy is in force</label>
            <select id="pWeb">
              <option value="">the phone's rung decides</option>
              <option value="none">off (a lockdown policy)</option>
            </select>
          </div>
        </div>
        <button id="savePolicy" type="button">Save policy</button>
        <div class="msg" id="policyMsg"></div>
      </div>
      <div class="card">
        <h2>App rules</h2>
        <p class="sub" style="margin:0 0 10px">
          <strong>blocked</strong> prevents install and removes the app.
          <strong>hidden</strong> keeps it installed but conceals it — this is how apps the phone
          shipped with get disabled. <strong>allowed</strong> permits it explicitly.
        </p>
        <div id="appTable"></div>
        <div class="row">
          <div><label for="aPolicy">Policy</label><select id="aPolicy"></select></div>
          <div><label for="aPkg">Package name</label><input id="aPkg" placeholder="com.instagram.android"></div>
          <div><label for="aState">State</label>
            <select id="aState">
              <option value="blocked">blocked</option>
              <option value="hidden">hidden</option>
              <option value="allowed">allowed</option>
              <option value="remove">remove rule</option>
            </select>
          </div>
        </div>
        <button id="saveApp" type="button">Save rule</button>
        <div class="msg" id="appMsg"></div>
      </div>
    </section>

    <section data-panel="schedules" style="display:none">
      <div class="card">
        <h2>Time windows</h2>
        <p class="sub" style="margin:0 0 10px">
          Inside a window the phone switches to the chosen policy; outside every window it runs its
          baseline. Times are the phone's own local time. A window whose end is earlier than its
          start crosses midnight, and belongs to the day it started.
        </p>
        <div id="schedTable"></div>
      </div>
      <div class="card">
        <h2>Add a window</h2>
        <div class="row">
          <div><label for="sBase">Applies to phones on</label><select id="sBase"></select></div>
          <div><label for="sActive">Switch to</label><select id="sActive"></select></div>
        </div>
        <div class="row">
          <div><label for="sDevice">Just one phone (optional)</label><select id="sDevice"></select></div>
          <div><label for="sPriority">Priority</label><input id="sPriority" type="number" value="0"></div>
        </div>
        <div class="row">
          <div><label for="sStart">From</label><input id="sStart" placeholder="22:00"></div>
          <div><label for="sEnd">Until</label><input id="sEnd" placeholder="06:00"></div>
        </div>
        <label>Days</label>
        <div class="days" id="sDays"></div>
        <button id="saveSched" type="button">Save window</button>
        <button id="applyNow" type="button" class="ghost">Apply now</button>
        <div class="msg" id="schedMsg"></div>
      </div>
    </section>

    <section data-panel="yeshiva" style="display:none">
      <div class="card">
        <h2>The yeshiva temp tag</h2>
        <p class="sub" style="margin:0 0 10px">
          A phone on this tag gets one browser profile at every rung that has one: the explicit and
          social blocklists, every image blanked, no AI rating. The rungs differ in their apps.
          Put a phone on it from the Devices form (Tag = Yeshiva) or with the buttons below; migrate
          it off by giving it the Standard tag and a rung. Details in <code>YESHIVA.md</code>.
        </p>
        <div id="yeshivaLadder"></div>
      </div>
      <div class="card">
        <h2>Phones on the tag</h2>
        <p class="sub" style="margin:0 0 10px">Shiur lock <strong>off</strong> exempts that phone from the
          timetable and from "Locked now"; it stays on its rung. The fleet switch below still governs
          every phone that is on.</p>
        <div id="yeshivaDevices"></div>
      </div>
      <div class="card">
        <h2>Shiur lock</h2>
        <p class="sub" style="margin:0 0 10px">
          <strong>Timetable</strong> locks every yeshiva phone inside the windows below.
          <strong>Off</strong> ignores the windows (bein hazmanim, a trip). <strong>Locked now</strong>
          locks every yeshiva phone immediately, whatever the clock says, until you switch back. The
          web side follows within a minute; the apps on the next scheduler run (this runs it).
        </p>
        <div id="shiurToggle"></div>
        <div class="msg" id="shiurToggleMsg"></div>
      </div>
      <div class="card">
        <h2>Shiur timetable</h2>
        <p class="sub" style="margin:0 0 10px">
          Inside these windows every yeshiva phone switches to the shiur policy: only the essentials
          (phone, WhatsApp, messages, clock) and no web — the block page says so. Times are the phone's
          local time (set each yeshiva phone's zone to <code>Asia/Jerusalem</code>). One row covers every
          rung. A boy who needs an exception gets a window of his own under Schedules, on his phone only,
          with a higher priority and his rung's policy as the target.
        </p>
        <div id="shiurTable"></div>
        <div class="row">
          <div><label for="yStart">From</label><input id="yStart" placeholder="15:35"></div>
          <div><label for="yEnd">Until</label><input id="yEnd" placeholder="19:15"></div>
          <div><label for="yPriority">Priority</label><input id="yPriority" type="number" value="100"></div>
        </div>
        <label>Days</label>
        <div class="days" id="yDays"></div>
        <button id="saveShiur" type="button">Add window</button>
        <button id="applyNowY" type="button" class="ghost">Apply now</button>
        <div class="msg" id="shiurMsg"></div>
      </div>
      <div class="card">
        <h2>Headwind configurations for the tag</h2>
        <p class="sub" style="margin:0 0 10px">
          The app side is enforced by Headwind. Create one configuration per row in the panel
          (Background mode for the rungs, kiosk mode with the essentials for Shiur), then paste each
          configuration's id here. Until a row has an id the scheduler cannot switch phones to it and
          reports "no Headwind configuration mapped" — the web side works regardless.
        </p>
        <div id="yeshivaPolicies"></div>
        <div class="msg" id="yeshivaMsg"></div>
      </div>
    </section>

    <section data-panel="sites" style="display:none">
      <div class="card">
        <h2>Approve or revoke a site</h2>
        <div class="row">
          <div><label for="siteHost">Site</label><input id="siteHost" placeholder="example.com"></div>
        </div>
        <button id="allowSite" type="button">Allow</button>
        <button id="revokeSite" type="button" class="ghost">Revoke</button>
        <div class="msg" id="siteMsg"></div>
      </div>
      <div class="card">
        <h2>Recent decisions</h2>
        <div id="siteTable"></div>
      </div>
    </section>

    <section data-panel="searches" style="display:none">
      <div class="card">
        <h2>Re-rate a search</h2>
        <div class="row">
          <div><label for="qText">Search words</label><input id="qText" placeholder="volcano facts"></div>
          <div><label for="qLevel">Allow from rung</label><select id="qLevel"></select></div>
        </div>
        <button id="saveQuery" type="button">Save rating</button>
        <div class="msg" id="queryMsg"></div>
      </div>
      <div class="card">
        <h2>What is being searched for</h2>
        <p class="empty">Most-tried first. This is the view that shows what people are actually
          reaching for — a list of approved sites never will.</p>
        <div id="searchTable"></div>
      </div>
    </section>

    <section data-panel="audit" style="display:none">
      <div class="card">
        <h2>Audit log</h2>
        <div id="auditTable"></div>
      </div>
    </section>
  </div>
</div>

<script>
(function () {
  var KEY_NAME = 'operator_key';
  function id(x) { return document.getElementById(x); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function key() { try { return sessionStorage.getItem(KEY_NAME) || ''; } catch (e) { return window.__k || ''; } }
  function setKey(v) { try { sessionStorage.setItem(KEY_NAME, v); } catch (e) { window.__k = v; } }

  async function api(path, body) {
    var res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'Authorization': 'Bearer ' + key() },
                             body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
    return data;
  }

  function say(el, text, ok) {
    el.textContent = text;
    el.className = 'msg ' + (ok ? 'ok' : 'err');
  }

  function table(cols, rows, render) {
    if (!rows.length) return '<p class="empty">Nothing yet.</p>';
    return '<table><thead><tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows.map(render).join('') + '</tbody></table>';
  }

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function maskToDays(mask) {
    var out = [];
    for (var i = 0; i < 7; i++) if (mask & (1 << i)) out.push(DAYS[i]);
    return out.length === 7 ? 'every day' : out.join(' ');
  }
  function minutesToText(m) {
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  // --- rendering -------------------------------------------------------------------------------
  var state = { devices: [], policies: [], appRules: [], schedules: [] };

  function policyName(pid) {
    var p = state.policies.find(function (x) { return x.id === pid; });
    return p ? p.name : pid;
  }

  function fillSelect(el, items, valueKey, labelFn, includeBlank) {
    el.innerHTML = (includeBlank ? '<option value="">(all phones)</option>' : '') +
      items.map(function (i) {
        return '<option value="' + esc(i[valueKey]) + '">' + esc(labelFn(i)) + '</option>';
      }).join('');
  }

  function render() {
    id('deviceTable').innerHTML = table(['Phone', 'Tag · rung', 'Proxy login', 'Password', 'Baseline', 'Now running', 'Zone', ''], state.devices, function (d) {
      return '<tr><td>' + esc(d.label) + '</td><td>' + esc(tagName(d.tag)) + ' · ' + esc(levelName(d.level, d.tag)) + '</td><td>' +
        (d.proxy_user ? esc(d.proxy_user) : '<span class="empty">none — strictest</span>') +
        '</td><td>' +
        // Shown, not hidden. Chrome asks whoever holds the phone for this, so it is not a secret
        // that can be kept from them — and the operator needs to read it back when Chrome forgets.
        (d.proxy_password ? '<code>' + esc(d.proxy_password) + '</code>' : '<span class="empty">—</span>') +
        '</td><td>' + esc(policyName(d.policy_id)) + '</td><td>' +
        (d.last_applied_policy_id ? esc(policyName(d.last_applied_policy_id)) : '<span class="empty">not applied</span>') +
        '</td><td>' + esc(d.timezone) + '</td><td style="white-space:nowrap">' +
        '<button class="ghost" style="margin:0 6px 0 0;padding:4px 10px" data-dev-edit="' + esc(d.id) + '">Edit</button>' +
        '<button class="ghost" style="margin:0;padding:4px 10px" data-dev-del="' + esc(d.id) + '">Delete</button>' +
        '</td></tr>';
    });

    // The ladders come from the server (levels.js) rather than being written out here, so the
    // console can never show rung names that differ from what is actually enforced.
    fillTags('dTag');
    fillLevels('dLevel', id('dTag').value, false);   // a phone's rung on the chosen ladder
    fillLevels('qLevel', 'standard', true);           // a site/search rating: 2-6, Never included

    id('policyTable').innerHTML = table(['Policy', 'Model', 'Headwind config', 'Apps', ''], state.policies, function (p) {
      var n = state.appRules.filter(function (r) { return r.policy_id === p.id; }).length;
      return '<tr><td>' + esc(p.name) + '</td><td>' + esc(policyModel(p)) + '</td><td>' +
        (p.headwind_configuration_id ? esc(p.headwind_configuration_id) : '<span class="empty">unmapped</span>') +
        '</td><td>' + n + ' rule' + (n === 1 ? '' : 's') + '</td><td style="white-space:nowrap">' +
        (p.headwind_configuration_id
          ? '<button class="ghost" style="margin:0;padding:4px 10px" data-push-apps="' + esc(p.id) + '" title="Write these app rules into the Headwind configuration">Push apps</button>'
          : '<span class="empty">map a config first</span>') +
        '</td></tr>';
    });

    renderYeshiva();

    id('appTable').innerHTML = table(['Policy', 'Package', 'State'], state.appRules, function (r) {
      return '<tr><td>' + esc(policyName(r.policy_id)) + '</td><td><code>' + esc(r.package_name) +
        '</code></td><td><span class="pill ' + esc(r.state) + '">' + esc(r.state) + '</span></td></tr>';
    });

    id('schedTable').innerHTML = table(['When', 'Days', 'Phones on', 'Switch to', 'Pri', ''], state.schedules, function (s) {
      var dev = s.device_id ? (state.devices.find(function (d) { return d.id === s.device_id; }) || {}).label : null;
      return '<tr><td>' + minutesToText(s.start_min) + '&ndash;' + minutesToText(s.end_min) +
        (s.end_min <= s.start_min ? ' <span class="empty">(+1d)</span>' : '') +
        '</td><td>' + esc(maskToDays(s.day_mask)) + '</td><td>' + esc(baseName(s.base_policy_id)) +
        (dev ? '<br><span class="empty">' + esc(dev) + ' only</span>' : '') +
        '</td><td>' + esc(policyName(s.active_policy_id)) + '</td><td>' + esc(s.priority) +
        '</td><td><button class="ghost" style="margin:0;padding:4px 10px" data-del="' + esc(s.id) + '">Delete</button></td></tr>';
    });

    fillSelect(id('dPolicy'), state.policies, 'id', function (p) { return p.name; });
    fillSelect(id('aPolicy'), state.policies, 'id', function (p) { return p.name; });
    // A window's base may be a whole tag ("every yeshiva phone") as well as one baseline policy.
    fillSelect(id('sBase'), (state.tags || []).map(function (t) {
      return { id: 'tag:' + t.id, name: 'every phone on ' + t.name };
    }).concat(state.policies), 'id', function (p) { return p.name; });
    fillSelect(id('sActive'), state.policies, 'id', function (p) { return p.name; });
    fillSelect(id('sDevice'), state.devices, 'id', function (d) { return d.label; }, true);
  }

  async function refresh() {
    state = await api('/api/admin/state');
    render();
  }

  async function refreshSites() {
    var d = await api('/api/admin/verdicts');
    id('siteTable').innerHTML = table(['Site', 'Verdict', 'Why', 'By'], d.verdicts, function (v) {
      return '<tr><td>' + esc(v.hostname) + '</td><td><span class="pill ' + esc(v.verdict) + '">' +
        esc(v.verdict) + '</span></td><td>' + esc(v.reason || '') + '</td><td>' + esc(v.source) + '</td></tr>';
    });
  }

  async function refreshAudit() {
    var d = await api('/api/admin/audit');
    id('auditTable').innerHTML = table(['When', 'Who', 'What', 'Detail'], d.entries, function (e) {
      return '<tr><td>' + esc(new Date(e.at).toLocaleString()) + '</td><td>' + esc(e.actor) +
        '</td><td>' + esc(e.action) + '</td><td>' + esc(e.detail || '') + '</td></tr>';
    });
  }

  // --- wiring ----------------------------------------------------------------------------------
  id('sDays').innerHTML = DAYS.map(function (d, i) {
    return '<label>' + d + '<input type="checkbox" data-day="' + i + '" checked></label>';
  }).join('');

  document.querySelectorAll('nav button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('nav button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      var tab = b.dataset.tab;
      if (b.dataset.tab === 'searches') loadSearches();
      document.querySelectorAll('[data-panel]').forEach(function (p) {
        p.style.display = p.dataset.panel === tab ? 'block' : 'none';
      });
      if (tab === 'sites') refreshSites().catch(function () {});
      if (tab === 'audit') refreshAudit().catch(function () {});
    });
  });

  id('unlock').addEventListener('click', async function () {
    setKey(id('key').value.trim());
    try {
      await refresh();
      id('auth').style.display = 'none';
      id('app').style.display = 'block';
    } catch (e) {
      say(id('authmsg'), e.message, false);
    }
  });
  id('key').addEventListener('keydown', function (e) { if (e.key === 'Enter') id('unlock').click(); });

  async function submit(btnId, msgId, fn, okText) {
    var btn = id(btnId), msg = id(msgId);
    btn.disabled = true;
    try {
      // A handler may return a string to replace the generic success text with specifics.
      var out = await fn();
      await refresh();
      say(msg, typeof out === 'string' ? out : okText, true);
    } catch (e) {
      say(msg, e.message, false);
    } finally {
      btn.disabled = false;
    }
  }

  function tagDef(tag) {
    return (state.tags || []).filter(function (t) { return t.id === (tag || 'standard'); })[0] || null;
  }
  function tagName(tag) {
    var t = tagDef(tag);
    return t ? t.name.replace(/ \(.*\)$/, '') : String(tag || 'standard');
  }
  function ladder(tag) {
    var t = tagDef(tag);
    return t ? t.levels : (state.levels || []);
  }
  function levelName(n, tag) {
    var l = ladder(tag).filter(function (x) { return x.level === n; })[0];
    return l ? n + ' \u00b7 ' + l.name : String(n == null ? '?' : n);
  }
  function policyModel(p) {
    return (p.app_default === 'blocked' ? 'allowlist' : 'blocklist') + (p.web_mode === 'none' ? ', web off' : '');
  }
  function baseName(base) {
    if (typeof base === 'string' && base.indexOf('tag:') === 0) return 'every phone on ' + tagName(base.slice(4));
    return policyName(base);
  }
  function fillTags(elId) {
    var el = id(elId);
    if (!el || el.dataset.filled) return;
    el.innerHTML = (state.tags || []).map(function (t) {
      return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>';
    }).join('');
    el.value = 'standard';
    el.dataset.filled = '1';
  }
  // The policy that pairs with a tag + rung, by the id convention policy.js uses.
  function pairedPolicyId(tag, level) {
    var t = tagDef(tag);
    return t ? t.policyPrefix + '_' + level : null;
  }
  function syncPairedPolicy() {
    var pid = pairedPolicyId(id('dTag').value, Number(id('dLevel').value));
    if (pid && state.policies.some(function (p) { return p.id === pid; })) id('dPolicy').value = pid;
  }

  function renderYeshiva() {
    var y = tagDef('yeshiva');
    if (!y) return;
    id('yeshivaLadder').innerHTML = table(['Rung', 'Apps', 'Browser'], y.levels, function (l) {
      return '<tr><td>' + esc(l.level + ' \u00b7 ' + l.name) + '</td><td>' +
        esc(l.appModel === 'allowlist' ? 'only the listed apps' : 'everything except the listed apps') +
        '</td><td>' + esc(l.webMode === 'none' ? 'none' : 'blocklists only, images blanked') + '</td></tr>';
    });

    var phones = state.devices.filter(function (d) { return d.tag === 'yeshiva'; });
    id('yeshivaDevices').innerHTML = table(['Phone', 'Rung', 'Shiur lock', 'Now running', 'Zone', 'Move to'], phones, function (d) {
      var moves = y.levels.map(function (l) {
        return l.level === d.level ? '' :
          '<button class="ghost" style="margin:0 6px 0 0;padding:4px 10px" data-y-move="' + esc(d.id) + '" data-y-level="' + l.level + '">' + l.level + '</button>';
      }).join('');
      var lockOn = Number(d.shiur_lock) !== 0;
      return '<tr><td>' + esc(d.label) + '</td><td>' + esc(levelName(d.level, 'yeshiva')) + '</td><td>' +
        '<span class="pill ' + (lockOn ? 'allowed' : 'blocked') + '">' + (lockOn ? 'on' : 'off') + '</span> ' +
        '<button class="ghost" style="margin:0 0 0 6px;padding:4px 10px" data-y-lock="' + esc(d.id) + '" data-y-on="' + (lockOn ? '0' : '1') + '">' +
        (lockOn ? 'turn off' : 'turn on') + '</button></td><td>' +
        (d.last_applied_policy_id ? esc(policyName(d.last_applied_policy_id)) : '<span class="empty">not applied</span>') +
        '</td><td>' + esc(d.timezone) + (d.timezone !== 'Asia/Jerusalem' ? ' <span class="empty">(shiur times are local — is this right?)</span>' : '') +
        '</td><td style="white-space:nowrap">' + moves +
        '<button class="ghost" style="margin:0;padding:4px 10px" data-y-move="' + esc(d.id) + '" data-y-tag="standard" data-y-level="4">standard 4</button></td></tr>';
    });

    var mode = (state.settings && state.settings.shiur_lock_mode) || 'schedule';
    id('shiurToggle').innerHTML = [['schedule', 'Timetable'], ['off', 'Off'], ['on', 'Locked now']].map(function (m) {
      return '<button type="button" class="' + (m[0] === mode ? '' : 'ghost') + '" style="margin:0 8px 0 0" data-shiur-mode="' + m[0] + '"' +
        (m[0] === mode ? ' disabled' : '') + '>' + m[1] + '</button>';
    }).join('') + '<span class="empty" style="margin-left:8px">now: ' + esc(mode === 'on' ? 'locked' : mode === 'off' ? 'off' : 'following the timetable') + '</span>';

    var windows = state.schedules.filter(function (s) { return s.base_policy_id === 'tag:yeshiva'; });
    id('shiurTable').innerHTML = table(['When', 'Days', 'Switch to', 'Pri', ''], windows, function (s) {
      return '<tr><td>' + minutesToText(s.start_min) + '&ndash;' + minutesToText(s.end_min) +
        '</td><td>' + esc(maskToDays(s.day_mask)) + '</td><td>' + esc(policyName(s.active_policy_id)) +
        '</td><td>' + esc(s.priority) +
        '</td><td><button class="ghost" style="margin:0;padding:4px 10px" data-del="' + esc(s.id) + '">Delete</button></td></tr>';
    });

    var policies = state.policies.filter(function (p) { return p.id.indexOf('yeshiva_') === 0; });
    id('yeshivaPolicies').innerHTML = table(['Policy', 'Model', 'Apps', 'Headwind configuration id', ''], policies, function (p) {
      var n = state.appRules.filter(function (r) { return r.policy_id === p.id; }).length;
      return '<tr><td>' + esc(p.name) + '</td><td>' + esc(policyModel(p)) + '</td><td>' + n +
        '</td><td><input data-y-cfg="' + esc(p.id) + '" value="' + esc(p.headwind_configuration_id || '') + '" placeholder="unmapped" style="max-width:120px"></td>' +
        '<td><button class="ghost" style="margin:0;padding:4px 10px" data-y-save="' + esc(p.id) + '">Save</button></td></tr>';
    });
  }

  // withNever distinguishes the two kinds of select that share this ladder. A SITE or SEARCH rating
  // may be Never (6) — blocked at every rung. A PHONE's rung may not: 6 is not a rung, and the
  // clamp on the way in turns it into rung 1, which is 'no web at all'. Offering it on the device
  // form is how a phone ends up unable to load anything while the console reads as though the
  // operator chose the strictest filtering — which is exactly what happened to a live phone.
  function fillLevels(elId, tag, withNever) {
    var el = id(elId);
    if (!el) return;
    if (el.dataset.filled === (tag || 'standard')) return;
    var keep = el.value;
    el.innerHTML = ladder(tag).map(function (l) {
      return '<option value="' + l.level + '">' + esc(l.level + ' \u00b7 ' + l.name) + '</option>';
    }).join('') + (withNever ? '<option value="6">Never (blocked everywhere)</option>' : '');
    el.value = keep && ladder(tag).some(function (l) { return String(l.level) === keep; }) ? keep : '2';
    el.dataset.filled = tag || 'standard';
  }

  function loadSearches() {
    api('/api/admin/searches', null, 'GET').then(function (r) {
      id('searchTable').innerHTML = table(['Search', 'Allowed from', 'Times tried', 'Source'],
        r.searches || [], function (q) {
          return '<tr><td>' + esc(q.query_sample || '') + '</td><td>' + esc(levelName(q.level)) +
            '</td><td>' + esc(q.hit_count) + '</td><td>' + esc(q.source) + '</td></tr>';
        });
    }).catch(function () {});
  }

  // Which phone the form is editing. Null means "save" creates a new phone; otherwise the save
  // carries the id and the server updates that row in place (keeping its password), instead of
  // minting a second phone with the same label — which is what happened before there was any way
  // to edit at all.
  var editingId = null;

  function editDevice(d) {
    editingId = d.id;
    id('dLabel').value = d.label || '';
    id('dHw').value = d.headwind_device_id || '';
    id('dPolicy').value = d.policy_id || '';
    id('dTz').value = d.timezone || 'UTC';
    id('dTag').value = d.tag || 'standard';
    fillLevels('dLevel', id('dTag').value, false);
    id('dLevel').value = String(d.level);
    id('dProxy').value = d.proxy_user || '';
    id('deviceFormTitle').textContent = 'Editing: ' + (d.label || d.id);
    id('saveDevice').textContent = 'Update phone';
    id('cancelEdit').style.display = '';
    id('deviceCreds').innerHTML = '';
    say(id('deviceMsg'), '', true);
    id('deviceFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function clearDeviceForm() {
    editingId = null;
    id('dLabel').value = '';
    id('dHw').value = '';
    id('dTz').value = 'UTC';
    id('dTag').value = 'standard';
    fillLevels('dLevel', 'standard', false);
    id('dLevel').value = '2';
    id('dProxy').value = '';
    id('deviceFormTitle').textContent = 'Add a phone';
    id('saveDevice').textContent = 'Save phone';
    id('cancelEdit').style.display = 'none';
  }

  id('cancelEdit').addEventListener('click', function () {
    clearDeviceForm();
    say(id('deviceMsg'), '', true);
  });

  // Changing the tag swaps the rung list to that ladder; tag + rung pick the paired app policy;
  // a yeshiva phone almost certainly lives in Israel, where the shiur windows are written.
  id('dTag').addEventListener('change', function () {
    fillLevels('dLevel', id('dTag').value, false);
    if (id('dTag').value === 'yeshiva' && (id('dTz').value === 'UTC' || !id('dTz').value)) id('dTz').value = 'Asia/Jerusalem';
    syncPairedPolicy();
  });
  id('dLevel').addEventListener('change', syncPairedPolicy);

  id('yDays').innerHTML = DAYS.map(function (d, i) {
    return '<label>' + d + '<input type="checkbox" data-day="' + i + '"' + (i <= 4 ? ' checked' : '') + '></label>';
  }).join('');

  id('saveShiur').addEventListener('click', function () {
    submit('saveShiur', 'shiurMsg', function () {
      var mask = 0;
      document.querySelectorAll('#yDays input:checked').forEach(function (c) {
        mask |= (1 << Number(c.dataset.day));
      });
      return api('/api/admin/schedules', {
        base_policy_id: 'tag:yeshiva',
        active_policy_id: 'yeshiva_shiur',
        device_id: null,
        day_mask: mask,
        start: id('yStart').value.trim(),
        end: id('yEnd').value.trim(),
        priority: Number(id('yPriority').value) || 100,
      });
    }, 'Window saved. The web side applies within a minute; apps on the next scheduler run.');
  });

  id('applyNowY').addEventListener('click', function () { id('applyNow').click(); });

  document.addEventListener('click', function (e) {
    var ds = e.target && e.target.dataset;
    if (!ds) return;
    if (ds.yMove) {
      submit('saveShiur', 'yeshivaMsg', function () {
        return api('/api/admin/devices/level', {
          id: ds.yMove, level: Number(ds.yLevel), tag: ds.yTag || 'yeshiva',
        }).then(function () {
          // The baseline policy follows the rung, or the scheduler keeps applying the old one.
          var d = state.devices.find(function (x) { return x.id === ds.yMove; });
          var pid = pairedPolicyId(ds.yTag || 'yeshiva', Number(ds.yLevel));
          if (!d || !pid || !state.policies.some(function (p) { return p.id === pid; })) return;
          return api('/api/admin/devices', {
            id: d.id, label: d.label, headwind_device_id: d.headwind_device_id, policy_id: pid,
            timezone: d.timezone, level: Number(ds.yLevel), tag: ds.yTag || 'yeshiva', proxy_user: d.proxy_user,
          });
        });
      }, 'Phone moved.');
    }
    if (ds.shiurMode) {
      var btn = e.target, msg = id('shiurToggleMsg');
      btn.disabled = true;
      api('/api/admin/settings', { key: 'shiur_lock_mode', value: ds.shiurMode }).then(function () {
        return api('/api/admin/apply', {});
      }).then(function (r) {
        return refresh().then(function () {
          say(msg, 'Saved. Apps: ' + r.changed + ' changed, ' + r.unchanged + ' already correct, ' + r.failed + ' failed' +
            (r.errors && r.errors.length ? ': ' + r.errors.join('; ') : '.'), r.failed === 0);
        });
      }).catch(function (err) { say(msg, err.message, false); btn.disabled = false; });
      return;
    }
    if (ds.yLock) {
      submit('saveShiur', 'yeshivaMsg', function () {
        return api('/api/admin/devices/shiur', { id: ds.yLock, on: ds.yOn === '1' }).then(function () {
          return api('/api/admin/apply', {});
        });
      }, 'Shiur lock ' + (ds.yOn === '1' ? 'on' : 'off') + ' for that phone. Web follows within a minute; apps were re-applied.');
      return;
    }
    if (ds.ySave) {
      var input = document.querySelector('[data-y-cfg="' + ds.ySave + '"]');
      var p = state.policies.find(function (x) { return x.id === ds.ySave; });
      if (!p || !input) return;
      submit('saveShiur', 'yeshivaMsg', function () {
        return api('/api/admin/policies', {
          id: p.id, name: p.name, headwind_configuration_id: input.value.trim() || null,
          app_default: p.app_default, web_mode: p.web_mode || null,
        });
      }, 'Configuration id saved.');
    }
  });

  document.addEventListener('click', function (e) {
    var ds = e.target && e.target.dataset;
    if (!ds) return;
    if (ds.devEdit) {
      var d = state.devices.find(function (x) { return x.id === ds.devEdit; });
      if (d) editDevice(d);
      return;
    }
    if (ds.pushApps) {
      var pol = state.policies.find(function (x) { return x.id === ds.pushApps; });
      if (!pol) return;
      if (!confirm('Push ' + state.appRules.filter(function (r) { return r.policy_id === pol.id; }).length +
        ' app rules from "' + pol.name + '" into Headwind configuration ' + pol.headwind_configuration_id + '?\\n\\n' +
        'Blocked apps become Remove (uninstalled on every phone on that configuration at its next sync). ' +
        'Entries for other apps already in the configuration are left alone.')) return;
      submit('savePolicy', 'policyMsg', function () {
        return api('/api/admin/policies/push-apps', { id: pol.id }).then(function (r) {
          var msg = 'Pushed to configuration ' + r.configurationId + ': ' + r.remove + ' remove, ' + r.install + ' install, ' +
            r.icon + ' icon-only' + (r.created.length ? ', ' + r.created.length + ' created in the catalogue' : '') +
            (r.errors.length ? '. ERRORS: ' + r.errors.join('; ') : '') + '. Phones pick it up at their next sync (reboot forces it).';
          if (r.errors.length) throw new Error(msg);
          return msg;
        });
      }, 'Pushed.');
      return;
    }
    if (ds.devDel) {
      var victim = state.devices.find(function (x) { return x.id === ds.devDel; });
      var name = victim ? victim.label : ds.devDel;
      // A phone's row is its identity to the filter: with the row gone it falls to the strictest
      // rung on the next request, and its time windows are removed with it. Ask.
      if (!confirm('Delete "' + name + '"?\\n\\nThe phone will fall back to the strictest rung (no web) until it is added again, and its schedules are removed.')) return;
      submit('saveDevice', 'deviceMsg', function () {
        if (editingId === ds.devDel) clearDeviceForm();
        return api('/api/admin/devices/delete', { id: ds.devDel });
      }, 'Phone deleted.');
    }
  });

  id('saveDevice').addEventListener('click', function () {
    submit('saveDevice', 'deviceMsg', function () {
      return api('/api/admin/devices', {
        id: editingId || undefined,
        label: id('dLabel').value.trim(),
        headwind_device_id: id('dHw').value.trim() || null,
        policy_id: id('dPolicy').value,
        timezone: id('dTz').value.trim() || 'UTC',
        level: Number(id('dLevel').value),
        tag: id('dTag').value,
        proxy_user: id('dProxy').value.trim() || null,
      }).then(function (r) {
        // The one step the worker cannot do itself. Put it in front of the operator at the moment
        // they need it, rather than in a document they will be reading on a different screen.
        if (r && r.htpasswd) {
          id('deviceCreds').innerHTML =
            '<p style="margin:0 0 8px"><strong>' + esc(r.proxy_user) + '</strong> &nbsp; ' +
            '<code>' + esc(r.proxy_password) + '</code></p>' +
            '<p class="empty" style="margin:0 0 6px">Run this on the proxy, then set the phone:</p>' +
            '<pre><code>' + esc(r.htpasswd) + '</code></pre>' +
            '<pre><code>adb shell settings put global http_proxy ' +
            esc(location.hostname === 'localhost' ? 'mdm.getshmira.com:3128' : 'mdm.getshmira.com:3128') +
            '</code></pre>';
        }
        clearDeviceForm();
        return r;
      });
    }, 'Phone saved.');
  });

  id('saveQuery').addEventListener('click', function () {
    submit('saveQuery', 'queryMsg', function () {
      return api('/api/admin/searches/level', {
        query: id('qText').value.trim(),
        level: Number(id('qLevel').value),
      }).then(function (r) { loadSearches(); return r; });
    }, 'Rating saved.');
  });

  id('savePolicy').addEventListener('click', function () {
    submit('savePolicy', 'policyMsg', function () {
      return api('/api/admin/policies', {
        name: id('pName').value.trim(),
        headwind_configuration_id: id('pCfg').value.trim() || null,
        app_default: id('pDefault').value,
        web_mode: id('pWeb').value || null,
      });
    }, 'Policy saved.');
  });

  id('saveApp').addEventListener('click', function () {
    submit('saveApp', 'appMsg', function () {
      return api('/api/admin/apps', {
        policy_id: id('aPolicy').value,
        package_name: id('aPkg').value.trim(),
        state: id('aState').value,
      });
    }, 'Rule saved.');
  });

  id('saveSched').addEventListener('click', function () {
    submit('saveSched', 'schedMsg', function () {
      var mask = 0;
      document.querySelectorAll('#sDays input:checked').forEach(function (c) {
        mask |= (1 << Number(c.dataset.day));
      });
      return api('/api/admin/schedules', {
        base_policy_id: id('sBase').value,
        active_policy_id: id('sActive').value,
        device_id: id('sDevice').value || null,
        day_mask: mask,
        start: id('sStart').value.trim(),
        end: id('sEnd').value.trim(),
        priority: Number(id('sPriority').value) || 0,
      });
    }, 'Window saved.');
  });

  // Not routed through submit(): a scheduler run reports a summary rather than a fixed success
  // message, and a run with failures should read as a failure even though the call itself was 200.
  id('applyNow').addEventListener('click', async function () {
    var btn = id('applyNow'), msg = id('schedMsg');
    btn.disabled = true;
    try {
      var r = await api('/api/admin/apply', {});
      await refresh();
      say(msg, r.changed + ' changed, ' + r.unchanged + ' already correct, ' + r.failed + ' failed' +
        (r.errors && r.errors.length ? ': ' + r.errors.join('; ') : '.'), r.failed === 0);
    } catch (e) {
      say(msg, e.message, false);
    } finally {
      btn.disabled = false;
    }
  });

  document.addEventListener('click', function (e) {
    var delId = e.target && e.target.dataset && e.target.dataset.del;
    if (!delId) return;
    submit('saveSched', 'schedMsg', function () {
      return api('/api/admin/schedules/delete', { id: delId });
    }, 'Window deleted.');
  });

  id('allowSite').addEventListener('click', function () {
    submit('allowSite', 'siteMsg', async function () {
      await api('/api/admin/allow', { url: id('siteHost').value.trim() });
      await refreshSites();
    }, 'Site allowed.');
  });

  id('revokeSite').addEventListener('click', function () {
    submit('revokeSite', 'siteMsg', async function () {
      await api('/api/admin/revoke', { url: id('siteHost').value.trim() });
      await refreshSites();
    }, 'Site revoked.');
  });
})();
</script>
</body>
</html>`;
}
