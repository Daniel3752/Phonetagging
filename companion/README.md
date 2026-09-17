# Shmira companion

A tiny Android app, installed by Headwind MDM next to its own agent, with one job: **notice an
app install the moment it completes and make the agent re-apply its configuration**, so a
blocklisted app is gone within seconds instead of at the agent's next sync.

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
AgentClient unbinds
```

- **`WatchService`** runs as a foreground service (type `specialUse`) with a small persistent
  notification, "Shmira is protecting this phone". It registers a runtime receiver for
  `ACTION_PACKAGE_ADDED` and `ACTION_PACKAGE_REPLACED` (data scheme `package`), ignores events about
  itself, and ignores `PACKAGE_ADDED` with `EXTRA_REPLACING` because the `REPLACED` event that
  follows is the one trigger per update. Events are debounced: one nudge 3 seconds after the last
  event, so a burst of Play updates costs one configuration fetch. It also nudges every 30 minutes
  as a safety net (first one 2 minutes after the service starts), so a missed broadcast is bounded.
- **`AgentClient`** is the plugin-API client. The two AIDL files under `app/src/main/aidl/com/hmdm`
  are copied verbatim from the agent's source (see `NOTICE`). Only one nudge is in flight at a time;
  a nudge requested meanwhile makes it run exactly once more when the current one completes. Every
  `RemoteException` is caught and logged; if the bind fails (agent missing) it logs and tries again
  on the next nudge. It never crashes the service.
  - Agent API 119+ (`forceConfigUpdateWithCallback`): progress events are logged and the client
    unbinds on `onConfigUpdateComplete` or `onConfigUpdateError`. The agent removes blocklisted apps
    during its app phase, which precedes `onConfigUpdateComplete`.
  - Agent API 115-118 (`forceConfigUpdate`): fire and unbind 5 seconds later.
  - Older: logged as unsupported.
  - The agent **silently drops** a forced update while a sync of its own is already running
    (`ConfigUpdater.updateConfig()` returns when `configInitializing` is set). The agent calls
    `onConfigUpdateStart` immediately when it does accept, so if no event arrives within 20 seconds
    the client treats the request as dropped and, for an install-triggered nudge, retries once
    45 seconds later.
- **`MainActivity`** is an invisible launcher activity: it starts the service and finishes. It exists
  so Headwind's *Run after install* / *Run at boot* can start the app, and so a person can tap it.
- **`BootReceiver`** starts the service on `BOOT_COMPLETED` and after the app itself is updated
  (`MY_PACKAGE_REPLACED`). Both are exempt from Android 12+'s restriction on starting foreground
  services from the background.

Everything is logged with `android.util.Log`, tag `ShmiraCompanion`, and the install line is also
sent to the Headwind server's device log through `IMdmApi.log()`.

| Timing | Value |
|---|---|
| Debounce after the last package event | 3 s |
| Safety-net nudge | every 30 min (first 2 min after start) |
| Agent acknowledgement timeout | 20 s, then one retry after 45 s |
| Give up waiting for completion | 5 min (the agent carries on by itself) |

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
   fetch (or immediately if MQTT push is on and the panel sends it), then launches it. From then on
   the service is running.
4. **Updates**: bump `versionCode`/`versionName`, build, upload the new APK as a new version of the
   same application, and select that version in the configurations. The agent updates the app; the
   `MY_PACKAGE_REPLACED` receiver restarts the service on the new code.

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
- **A boy can uninstall or force-stop it** unless the MDM's uninstall restriction is on. With
  *Install* set in the configuration the agent reinstalls it at its next sync and relaunches it
  (*Run after install*); a force-stopped service comes back at the next boot or MDM launch. In the
  gap, again, the agent's own schedule applies.
- **The agent drops requests while it is busy.** A nudge that lands during the agent's own sync gets
  no callback; the client retries once after 45 s. If the agent is still busy then, the 30-minute
  safety net or the agent's next scheduled sync catches up. In practice the sync that was running
  usually removes the app anyway.
- **The 30-minute timer slips in deep sleep.** It is a `Handler` timer, not an alarm, so it runs
  late under Doze. It is a safety net, not the primary path.
- **Agent version.** The plugin API needs at least version 115 (`forceConfigUpdate`, library 1.1.5);
  progress logging and a precise unbind need 119 (`forceConfigUpdateWithCallback`), which is what
  this repository's fork of the agent reports.
- **`QUERY_ALL_PACKAGES`.** Needed on Android 11+ so package-visibility filtering does not hide
  `PACKAGE_ADDED` for apps this one cannot otherwise "see". Google Play restricts that permission;
  this app is distributed by the MDM, not Play, so that policy does not apply.
