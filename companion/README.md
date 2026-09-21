# Shmira companion

A tiny Android app, installed by Headwind MDM next to its own agent, with two jobs:

1. **Notice an app install the moment it completes and make the agent re-apply its
   configuration**, so a blocklisted app is gone within seconds instead of at the agent's next
   sync (the install watcher, below).
2. **Close WhatsApp's Updates tab — Status and Channels — and any channel screen, on phones whose
   rung says so** (the accessibility guard, [further down](#the-accessibility-guard-whatsapp-updates)).
   The network cannot do this: the feed rides the same pinned socket as the chats. So it is done
   where the feed is drawn.

Package `com.getshmira.companion`, no UI, no dependencies beyond the Android platform.

## Why it exists

The stock Headwind agent (`com.hmdm.launcher`, the Device Owner) only enforces its app policy
(uninstalling blocklisted apps, suspending `locked_packages`) when it fetches its configuration:
at boot, on an MQTT push, or when something calls its `forceConfigUpdate`. Nothing on the phone
reacts to an app being installed. Until the next sync a boy can install and use anything.

Since Android 8 an app cannot receive `PACKAGE_ADDED` from a manifest receiver, so someone has to
be awake to hear it. That is this app.

## How it works

```
Play / sideload installs X
        │  PACKAGE_ADDED (or PACKAGE_REPLACED) broadcast
        ▼
WatchService  (foreground service, runtime receiver)
        │  waits 3 s for the burst to settle, then one "nudge"
        ▼
AgentClient   binds  Intent("com.hmdm.action.Connect").setPackage("com.hmdm.launcher")
        │     IMdmApi api = IMdmApi.Stub.asInterface(binder)
        │     api.getVersion()
        │     api.log(now, LOG_INFO, "com.getshmira.companion", "install detected: X; forcing config update")
        │     api.forceConfigUpdateWithCallback(callback)     (agent API >= 119)
        │     api.forceConfigUpdate()                         (agent API 115-118)
        ▼
Headwind agent fetches its configuration, applies policies, removes X
        │  callback: onConfigUpdateStart ... onAppRemoving(X) ... onConfigUpdateComplete
        ▼
AgentClient marks the run complete; the binding to the agent stays up for the service's lifetime
```

- **`WatchService`** runs as a foreground service (type `specialUse`) with a small persistent
  notification, "Shmira is protecting this phone". It registers a runtime receiver for
  `ACTION_PACKAGE_ADDED` and `ACTION_PACKAGE_REPLACED` (data scheme `package`), ignores events about
  itself, and ignores `PACKAGE_ADDED` with `EXTRA_REPLACING` because the `REPLACED` event that
  follows is the one trigger per update. Events are debounced: one nudge 3 seconds after the last
  event, so a burst of Play updates costs one configuration fetch. It also nudges every 6 hours as
  a safety net (first one 2 minutes after the service starts), so a missed broadcast is bounded.
  Six hours, not minutes: a forced update runs with the agent's "user interaction" flag, which
  bypasses the configuration's app-update window and Wi-Fi-only download rule, so the safety net
  must not turn into a schedule of its own.
- **`AgentClient`** is the plugin-API client. The two AIDL files under `app/src/main/aidl/com/hmdm`
  are copied verbatim from the agent's source (see `NOTICE`). Only one nudge is in flight at a time;
  a nudge requested meanwhile makes it run exactly once more when the current one completes. Every
  `RemoteException` is caught and logged; if the bind fails (agent missing) it logs and tries again
  on the next nudge. It never crashes the service.
  - **The binding is persistent.** This app is the agent's only plugin client, and its bind is what
    keeps the agent's `PluginApiService` alive. The agent runs a forced update with that service as
    its Context and hangs the receiver that drives its install/remove chain on it, so unbinding
    mid-update would tear the chain down and leave the user restrictions the agent releases at the
    start of an update un-reapplied. The client binds once, keeps the proxy, rebinds only if the
    binding dies, and unbinds only when the service is destroyed.
  - **No nudge without a validated network.** The agent releases its restrictions before it fetches
    and re-applies them only after a successful fetch, so an offline forced update would leave the
    phone briefly unrestricted for nothing (sideload in airplane mode, say). An offline nudge is
    held and fires when connectivity returns; a network error reported by the agent re-queues it.
  - Agent API 119+ (`forceConfigUpdateWithCallback`): progress events are logged and the run ends
    on `onConfigUpdateComplete` or `onConfigUpdateError`. The agent removes blocklisted apps during
    its app phase, which precedes `onConfigUpdateComplete`.
  - Agent API 115-118 (`forceConfigUpdate`): fire and consider the run over 5 seconds later.
  - Older: logged as unsupported.
- **`MainActivity`** is an invisible entry activity: it starts the service and finishes. It exists
  so Headwind's *Run after install* / *Run at boot* can start the app. It is in category `INFO`,
  not `LAUNCHER`, so no app drawer shows an icon for it, yet `getLaunchIntentForPackage` (which
  the agent uses) still finds it. To start it by hand:
  `adb shell am start -n com.getshmira.companion/.MainActivity`.
  Android 12+ only lets a TOP app start a foreground service from an activity, and Headwind launches
  this one during a background sync, usually with the phone locked in a pocket. So it is shown over
  the lock screen (`showWhenLocked`), which makes a locked-but-lit phone count as top, and when the
  start is still refused (screen off) it stays, invisible and untouchable, and tries again each time
  it is resumed and every 15 s, for up to 10 minutes, before leaving it to the boot receiver.
- **`BootReceiver`** starts the service on `BOOT_COMPLETED` and after the app itself is updated
  (`MY_PACKAGE_REPLACED`). Both are exempt from Android 12+'s restriction on starting foreground
  services from the background. `GuardService` also starts it when the system binds the guard,
  which happens at every boot on a phone where the guard is enabled.
- **`PolicyClient`** and **`GuardKeeper`** live inside `WatchService` (the thing that is always
  running): the policy fetch for the guard, and the watch on the accessibility setting.

Everything is logged with `android.util.Log`, tag `ShmiraCompanion`, and the install line is also
sent to the Headwind server's device log through `IMdmApi.log()`.

| Timing | Value |
|---|---|
| Debounce after the last package event | 3 s |
| Safety-net nudge | every 6 h (first 2 min after start) |
| Give up waiting for completion | 5 min (bookkeeping only; the agent carries on, the binding stays) |
| Activity start refused (phone locked, screen off) | retry every 15 s for 10 min |
| Policy refresh | hourly; 5 min after a failure; at once when the network comes back |
| Guard: inspect / act / go Home | every 250 ms at most / every 400 ms at most / after 2 actions with no change |
| Guard keeper: re-check the accessibility setting | on every change, and every 15 min |

## The accessibility guard (WhatsApp Updates)

`GuardService` is an `AccessibilityService` that watches WhatsApp (`com.whatsapp`,
`com.whatsapp.w4b`) and, on a phone whose policy says so, closes the Updates tab (Status and
Channels), the channel directory, a channel opened as a conversation, and the status viewer.

**What decides whether it acts.** `PolicyClient` reads the phone's tunnel address off the VPN
interface (`10.66.0.x`, the same identity the proxy uses) and asks the Worker
`GET /api/companion/policy?user=<address>`. The answer follows the rung: `whatsappUpdates` in
`src/levels.js` — closed on yeshiva rungs 1-3 and standard 1-4, open on yeshiva 4 (the rung that
permits the social apps) and standard 5. It is cached, refreshed hourly and whenever the network
comes back, and **fails closed**: until the first answer, when the address cannot be read, or for
a phone the Worker does not know, the tab is closed.

**How it recognises the screens** (`GuardRules`, from `src/companion-rules.js`, served in the
same answer so a WhatsApp release that moves a button is an edit on the Worker, not a rebuild;
the APK carries the same defaults in `res/raw/guard_rules.json` and takes a served set whenever
its `rules_version` is higher):

1. the foreground activity's class name says so — everything WhatsApp calls a *newsletter* is a
   channel (`NewsletterInfoActivity`, `NewsletterDirectoryActivity`, …), plus the status viewer
   and composers (`StatusPlaybackActivity`, `…StatusComposerActivity`);
2. a **visible** node carries a view id that exists only there (`newsletter*`, `updates_list`,
   `find_channels_btn`, `status_playback*`, …). Visible, because WhatsApp's tab pager can keep
   an off-screen tab in the node tree;
3. a **selected** tab, or a title/heading, reads "Updates", "Channels", "Find channels" (or the
   Hebrew). Never an unselected tab: the bottom bar shows "Updates" on every screen, and a guard
   that matched it would throw the person out of their chats (a known bug in another kosher
   shield's history);
4. a conversation whose subtitle reads "N followers": a channel opened from a link.

The Updates tab itself is a fragment inside `HomeActivity` and its tab items carry no WhatsApp
ids, so rules 2 and 3 are what catch it; rule 1 catches the screens that are their own activity.
WhatsApp is moving status to the top of the Chats tab and channels behind a filter there
(2026 betas), which is why the rules key on the feed's own ids and classes rather than the tab
alone, and why `status_list`/`status_row` are deliberately NOT rules — they would soon match on
the Chats tab.

**What it does.** Click the Chats tab if it is on screen, else press Back; if the same screen is
still there after two tries, go Home. One short toast says why. At most one inspection per
250 ms and one action per 400 ms, so a stubborn screen cannot spin the CPU. It never sees anything
outside the watched packages (the service's package list is set from the rules at runtime).

**It guards itself.** Opened in Settings (its accessibility page, its app-info page, or any
settings screen with this app's name as the title), the guard presses Back, so the switch cannot
be reached from the phone. And `GuardKeeper` in the watch service observes
`Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES` and puts the service back the moment it goes
missing — which it can do only with `WRITE_SECURE_SETTINGS`, a permission Android lets **adb**
grant to any app that declares it (it is `signature|privileged|development`):

```sh
adb shell pm grant com.getshmira.companion android.permission.WRITE_SECURE_SETTINGS
adb shell am start -n com.getshmira.companion/.MainActivity   # or reboot
```

That is the whole enabling step: with the grant in place the keeper enables the guard itself
within seconds of the service starting, and re-enables it after any attempt to switch it off.
Without the grant the keeper can only complain (logcat, and a line in the Headwind device log),
and the guard has to be enabled once by hand — Settings → Accessibility → Shmira, or

```sh
adb shell settings put secure enabled_accessibility_services com.getshmira.companion/com.getshmira.companion.GuardService
adb shell settings put secure accessibility_enabled 1
```

(the first line REPLACES the list of enabled services; the keeper appends instead). Android 13's
"restricted setting" for sideloaded apps does not apply: Headwind installs through a session, as
every Device Owner does, and session installs are exempt.

**Verifying on the phone:**

```sh
adb shell settings get secure enabled_accessibility_services   # contains …/com.getshmira.companion.GuardService
adb logcat -s ShmiraCompanion
```

Expected after the service starts:

```
accessibility guard is enabled; WRITE_SECURE_SETTINGS granted; enabled services: [...]
policy for 10.66.0.3: known, whatsapp updates blocked, rules v3
GuardService connected
guard: service connected — whatsapp updates BLOCKED, rules v3 ([com.whatsapp, com.whatsapp.w4b])
```

Open WhatsApp and tap Updates: the Chats tab comes back at once, with the toast
`Channels and Status are turned off on this phone.` and a line `guard: closed tab "Updates" (chats tab)`.
Open a channel link: `guard: closed activity com.whatsapp.newsletter…NewsletterInfoActivity (back)`.

**Tuning for a new WhatsApp build.** `adb shell setprop log.tag.ShmiraGuardDump DEBUG` makes the
guard log every visible node with an id or a text (`adb logcat -s ShmiraGuardDump`); read the ids
and labels off the screens that should be closed, put them in `src/companion-rules.js`, bump
`COMPANION_RULES_VERSION`, run `node scripts/build-companion-rules.mjs`, deploy the Worker. Every
phone picks the new set up within the hour; a rebuild is only needed to change the code.

**Limits.** It is a guard, not a wall: the person sees the Updates tab for the fraction of a
second before it closes, and a channel's name and last-message preview are in the list it
closes. A WhatsApp redesign can hide the feed from these rules until the rules are updated (the
dump above is the tool). Status shown at the top of the Chats tab (2026 betas) is not closed —
only viewing a status is.

## Building

Prerequisites: an Android SDK with platform 34 and a build-tools release (set `ANDROID_HOME`, or
write `sdk.dir=/path/to/sdk` into `companion/local.properties`), Gradle 8.14.3 on `PATH` (there is
deliberately no wrapper) and JDK 17 or newer.

```sh
cd companion
gradle assembleRelease
# -> app/build/outputs/apk/release/app-release.apk
```

Signing: `app/build.gradle` reads `companion/keystore.properties` if it exists, with the keys
`storeFile` (relative to `companion/`), `storePassword`, `keyAlias` and `keyPassword`; see
`keystore.properties.example`. The keystore lives under `companion/signing/`. Both are git-ignored.
Without the properties file the build still succeeds but produces `app-release-unsigned.apk`, which
no phone will install.

**Keep the keystore forever and back it up.** Android, and therefore Headwind, will only update an
installed app with an APK signed by the same key; lose it and every phone needs a manual uninstall
before it can take the next version.

`gradle assembleDebug` gives a debug-signed APK for a quick `adb install` on a test phone.

## Putting it on a phone through Headwind

1. **Upload the APK.** Headwind web panel → *Applications* → *Add* → upload
   `app-release.apk`. The server reads the package id (`com.getshmira.companion`) and version
   from the file; give it the name *Shmira companion*.
2. **Add it to every configuration** the phones use. *Configurations* → configuration →
   *Applications* tab → find *Shmira companion* → set:
   - **Action: Install**
   - **Run after install: on** (the agent launches it right after installing, which starts the
     service without waiting for a reboot)
   - **Run at boot: on** (belt and braces next to the app's own boot receiver)
   - **Show icon: off** (nothing to see; the icon only invites a tap)
   - Save the configuration.
3. **Wait for the sync or push it.** The agent installs the companion at its next configuration
   fetch (or immediately if MQTT push is on and the panel sends it), then launches it. If the phone
   is locked with the screen off at that moment, the launched activity waits until the screen comes
   on (up to 10 minutes) before the service can start; a reboot also starts it. Check with
   `adb logcat -s ShmiraCompanion` that "running in the foreground" appears.
4. **Updates**: bump `versionCode`/`versionName` (and `BuildInfo.VERSION`), build, upload the new
   APK as a new version of the same application, and select that version in the configurations.
   The agent updates the app; the `MY_PACKAGE_REPLACED` receiver restarts the service on the new
   code.
5. **The guard's grant, once per phone, with the cable in** (NEW-PHONE.md step 9b):
   `adb shell pm grant com.getshmira.companion android.permission.WRITE_SECURE_SETTINGS`, then
   start the app or reboot. The keeper does the rest.

## Verifying on the phone

With the phone on USB and debugging enabled:

```sh
adb logcat -s ShmiraCompanion
```

Expected on start:

```
WatchService created (API 34, samsung SM-...)
running in the foreground
listening for package installs and updates
```

Now install an app the phone's policy blocks (from Play, or `adb install blocked.apk`). Within a
few seconds:

```
PACKAGE_ADDED com.example.blocked
nudging agent for [com.example.blocked]
binding to agent (install detected, attempt 1)
connected to agent
agent API version 119
forceConfigUpdateWithCallback (install detected)
agent: config update started
agent: configuration loaded
agent: policies applied
agent: removing com.example.blocked (Blocked App)
agent: config update complete
nudge finished: config update complete
```

and the app is gone from the launcher. On the Headwind server, *Devices* → the device → *Logs*
shows a line from `com.getshmira.companion`: `install detected: com.example.blocked; forcing config
update`. (The device log shows only levels the configuration's remote-log setting allows; the line
is sent at *Info*.)

The persistent notification appears in the shade on Android 12 and below. On Android 13+ it needs
`POST_NOTIFICATIONS`, which this app never asks for (it has no UI), so the notification may be
hidden while the service still runs; *Settings → Apps → Shmira* shows it as active.

## Known limits

- **OEM battery killers.** Samsung's *Put unused apps to sleep* / *Deep sleeping apps* can stop the
  service after some days of "non-use"; add Shmira to *Never sleeping apps* (Settings → Battery →
  Background usage limits), or have the MDM disable that feature. Xiaomi/Huawei/Oppo have their own
  autostart and battery-saver lists. When the service is dead the phone falls back to the agent's
  own sync cadence.
- **A boy can uninstall or force-stop it** unless the MDM restricts that. A force-stopped app is put
  in Android's *stopped* state and receives no broadcasts at all, `BOOT_COMPLETED` included, so a
  reboot does **not** bring it back; only an explicit launch does (Headwind's *Run at boot* / *Run
  after install*, which start `MainActivity`), or a reinstall. The cheap mitigation on the stock
  agent is the `no_control_apps` restriction in the configuration's MDM Settings: it removes
  *Force stop*, *Uninstall*, *Disable* and *Clear data* from Settings for every app on the phone
  (Play's own Uninstall button is unaffected; `no_uninstall_apps` closes that one too, for every
  app). A Device Owner could also call `setUserControlDisabledPackages` for this package alone,
  which greys out Force stop without touching other apps, but the stock Headwind agent does not
  expose that; it would need the agent fork. With *Install* set in the configuration the agent
  reinstalls a removed companion at its next sync and relaunches it.
- **It does not start itself on a locked phone.** Headwind launches the app right after installing
  it, and Android 12+ refuses a foreground-service start from an activity that is behind the
  keyguard with the screen off. The activity waits and retries for ten minutes (see `MainActivity`),
  and a reboot starts it regardless (`BOOT_COMPLETED` carries an exemption), but on a phone that is
  installed-to while locked and not rebooted within ten minutes, the service simply is not running.
  Verified on the S22: `adb shell dumpsys activity services com.getshmira.companion` printed
  nothing until `adb shell am start -n com.getshmira.companion/.MainActivity` was run with the
  screen on. **Reboot the phone after the companion is installed**, and check the service with that
  dumpsys line before trusting it.
- **The 6-hour timer slips in deep sleep.** It is a `Handler` timer, not an alarm, so it runs late
  under Doze. It is a safety net, not the primary path.
- **Agent version.** The plugin API needs at least version 115 (`forceConfigUpdate`, library 1.1.5);
  progress logging and a precise unbind need 119 (`forceConfigUpdateWithCallback`), which is what
  this repository's fork of the agent reports.
- **`QUERY_ALL_PACKAGES`.** Needed on Android 11+ so package-visibility filtering does not hide
  `PACKAGE_ADDED` for apps this one cannot otherwise "see". Google Play restricts that permission;
  this app is distributed by the MDM, not Play, so that policy does not apply.
