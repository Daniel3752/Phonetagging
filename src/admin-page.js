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
      <button data-tab="sites">Sites</button>
      <button data-tab="audit">Audit</button>
    </nav>

    <section data-panel="devices">
      <div class="card">
        <h2>Enrolled phones</h2>
        <div id="deviceTable"></div>
      </div>
      <div class="card">
        <h2>Add or update a phone</h2>
        <div class="row">
          <div><label for="dLabel">Label</label><input id="dLabel" placeholder="Cohen family — Dovid"></div>
          <div><label for="dHw">Headwind device id</label><input id="dHw" placeholder="42"></div>
        </div>
        <div class="row">
          <div><label for="dPolicy">Baseline policy</label><select id="dPolicy"></select></div>
          <div><label for="dTz">Time zone</label><input id="dTz" placeholder="America/New_York" value="UTC"></div>
        </div>
        <button id="saveDevice" type="button">Save phone</button>
        <div class="msg" id="deviceMsg"></div>
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
    id('deviceTable').innerHTML = table(['Phone', 'Baseline', 'Now running', 'Zone', 'Headwind'], state.devices, function (d) {
      return '<tr><td>' + esc(d.label) + '</td><td>' + esc(policyName(d.policy_id)) + '</td><td>' +
        (d.last_applied_policy_id ? esc(policyName(d.last_applied_policy_id)) : '<span class="empty">not applied</span>') +
        '</td><td>' + esc(d.timezone) + '</td><td>' +
        (d.headwind_device_id ? esc(d.headwind_device_id) : '<span class="empty">unlinked</span>') + '</td></tr>';
    });

    id('policyTable').innerHTML = table(['Policy', 'Headwind config', 'Apps'], state.policies, function (p) {
      var n = state.appRules.filter(function (r) { return r.policy_id === p.id; }).length;
      return '<tr><td>' + esc(p.name) + '</td><td>' +
        (p.headwind_configuration_id ? esc(p.headwind_configuration_id) : '<span class="empty">unmapped</span>') +
        '</td><td>' + n + ' rule' + (n === 1 ? '' : 's') + '</td></tr>';
    });

    id('appTable').innerHTML = table(['Policy', 'Package', 'State'], state.appRules, function (r) {
      return '<tr><td>' + esc(policyName(r.policy_id)) + '</td><td><code>' + esc(r.package_name) +
        '</code></td><td><span class="pill ' + esc(r.state) + '">' + esc(r.state) + '</span></td></tr>';
    });

    id('schedTable').innerHTML = table(['When', 'Days', 'Phones on', 'Switch to', 'Pri', ''], state.schedules, function (s) {
      var dev = s.device_id ? (state.devices.find(function (d) { return d.id === s.device_id; }) || {}).label : null;
      return '<tr><td>' + minutesToText(s.start_min) + '&ndash;' + minutesToText(s.end_min) +
        (s.end_min <= s.start_min ? ' <span class="empty">(+1d)</span>' : '') +
        '</td><td>' + esc(maskToDays(s.day_mask)) + '</td><td>' + esc(policyName(s.base_policy_id)) +
        (dev ? '<br><span class="empty">' + esc(dev) + ' only</span>' : '') +
        '</td><td>' + esc(policyName(s.active_policy_id)) + '</td><td>' + esc(s.priority) +
        '</td><td><button class="ghost" style="margin:0;padding:4px 10px" data-del="' + esc(s.id) + '">Delete</button></td></tr>';
    });

    fillSelect(id('dPolicy'), state.policies, 'id', function (p) { return p.name; });
    fillSelect(id('aPolicy'), state.policies, 'id', function (p) { return p.name; });
    fillSelect(id('sBase'), state.policies, 'id', function (p) { return p.name; });
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
      await fn();
      await refresh();
      say(msg, okText, true);
    } catch (e) {
      say(msg, e.message, false);
    } finally {
      btn.disabled = false;
    }
  }

  id('saveDevice').addEventListener('click', function () {
    submit('saveDevice', 'deviceMsg', function () {
      return api('/api/admin/devices', {
        label: id('dLabel').value.trim(),
        headwind_device_id: id('dHw').value.trim() || null,
        policy_id: id('dPolicy').value,
        timezone: id('dTz').value.trim() || 'UTC',
      });
    }, 'Phone saved.');
  });

  id('savePolicy').addEventListener('click', function () {
    submit('savePolicy', 'policyMsg', function () {
      return api('/api/admin/policies', {
        name: id('pName').value.trim(),
        headwind_configuration_id: id('pCfg').value.trim() || null,
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
