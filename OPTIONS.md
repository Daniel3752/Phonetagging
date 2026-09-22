# Every option a phone can carry

A single reference for the levers you set per phone: which **tag** it is on, which **rung**,
and everything that follows from those two choices. Two other documents go deeper on the
mechanics — `README.md` for the standard ladder and the filtering architecture, `YESHIVA.md`
for the temporary yeshiva tag and the shiur lock. This page is the map: what each option means,
and — at the end — what is proven working versus what is still unconfirmed on a real device.

Every phone carries exactly two identity fields that decide its behaviour:

- **`tag`** — which ladder its rung is read on: `standard` or `yeshiva`.
- **`level`** (the rung) — 1 is strictest, higher is more open.

Change either on the Devices tab (Edit) or, for the yeshiva tag, the Yeshiva tab's buttons.
The app policy is **not** chosen by hand — it follows the tag and rung automatically.

---

## Tag 1 — `standard`: the five-rung AI-judged ladder

The ladder the system was built around. Each rung is a filtering **mode**, not just a larger
allowlist than the one below it. The load-bearing line is between rung 3 and rung 4: rungs 1–3
are **deny-by-default** (a site is hidden unless it is rated at or below the rung), rungs 4–5
are **allow-by-default** (a site shows unless a blocklist denies it).

| Rung | Name | Web behaviour | Images | Search |
|---|---|---|---|---|
| **1** | No browser | No web at all — apps only (`webMode 'none'`) | — | — |
| **2** | Text-only | Essential allowlist, deny-by-default | Stripped | Text search only |
| **3** | Essential | Essential allowlist, deny-by-default | Shown | Filtered image search |
| **4** | General | Allow-by-default; social + explicit blocked | Shown | Full |
| **5** | Open | Allow-by-default; only explicit blocked | Shown | Full |

How a site is judged on rungs 1–3: the worker fetches the homepage once, asks Gemini to rate it
1–5 on a modesty ladder, caches that rating forever, and reuses it for every phone. A device
sees a site if its rating is at or below the phone's rung.

Two rating concepts sit alongside the 1–5 ladder:

- **The doorway flag** — sites whose whole function is reaching content they do not control
  (search engines, image search, open user-content platforms). It overrides the rating, because
  such a site's own homepage always looks harmless while everything behind it does not.
- **Rating 6 = NEVER** — explicit. Refused on every rung and every tag, no exceptions.

---

## Tag 2 — `yeshiva`: the temporary four-rung tag

A deliberately simple profile for getting the yeshiva phones started before they migrate onto
the standard ladder. One browser profile at every rung that has one (blocklists only, images
blanked, no AI rating); the rungs differ in their **app** model. Migrating is one switch:
give a phone `tag = standard` and a rung 1–5.

| Rung | Name | Apps (Headwind) | Browser |
|---|---|---|---|
| **1** | Apps only | Allowlist — essentials; Chrome not on it | None |
| **2** | Apps + browser | Same allowlist, **with Chrome** | Yeshiva browser |
| **3** | Blocklist, no social | Everything except social, explicit/dating, other browsers, VPNs | Yeshiva browser |
| **4** | Blocklist | Everything except explicit/dating, other browsers, VPNs (social apps allowed) | Yeshiva browser |

**The yeshiva browser** (rungs 2–4) is one profile no matter the rung:

- **Blocklists only, no AI in the request path.** The explicit list (~36k domains) and the
  social list, plus anything an operator blocked by hand or already on file as NEVER. Everything
  else loads. No model call, ever.
- **Images blanked.** Every image is refused and replaced with a flat grey rectangle of the same
  shape, so layout survives but no picture arrives. Search result thumbnails are blanked too.
- **In-app pictures off on rungs 1–2.** Spotify artwork and Play Store icons/screenshots come
  from their own hosts, which are refused at the TLS handshake. Music still plays and the store
  still installs; the pictures never load. **Rungs 3 and 4 keep them.** Rung 3 was meant to block
  them too, but refusing Spotify's image hosts emptied the catalogue (see the status table), so it
  runs regular Spotify with pictures on until that is fixed.
- **Search screened by keyword.** A keyword hit refuses at rating 5 or above (5 = immodest,
  6 = explicit). Image search off. Not model-judged. Known gap: a text search for explicit
  material that dodges the keyword list returns text results (the sites themselves are then on
  the explicit list).
- **Chrome must be recent.** Google will not serve the text-only results mode (`udm=14`) to a
  browser older than the feature, and the phone then shows the block page on every search.
  Update Chrome through the Play Store as part of setup, and check `chrome://version` first when
  "every search is blocked".

A YouTube variant exists for rung 3 (`yeshiva_rung_3_yt`) that leaves YouTube installed.

---

## The shiur lock (yeshiva tag only)

"The entire phone besides essential items doesn't work during shiur." Two halves:

- **Web:** the phone's effective policy becomes `web_mode = 'none'` inside each window; the
  block page reads "The phone is locked right now — it's shiur time." Applies within about a
  minute of the window starting. **This is the half that runs today.**
- **Apps:** intended to confine the phone to essentials (phone, contacts, messages, WhatsApp,
  clock, settings, the agent, WireGuard). **Not built yet** — see the status section: Headwind's
  Remove uninstalls a Play app permanently, so it cannot express a temporary swap. Kiosk or
  Managed Launcher is the supported path and has not been chosen.

The windows, Sunday–Thursday, in the phone's local time (`Asia/Jerusalem`):

| Window | Covers |
|---|---|
| 07:30–08:35 | Shachris |
| 09:15–13:45 | First seder, selichos, mincha |
| 15:35–19:15 | Second seder, review, halacha + mussar |
| 20:15–22:00 | Maariv, night seder |

**Fleet toggle** (Yeshiva tab → Shiur lock): **Timetable** (default), **Off** (bein hazmanim /
trips — windows ignored), **Locked now** (every yeshiva phone locked until you switch back).

**Per phone** (Yeshiva tab → the phone → Shiur lock on/off): off exempts that one phone from the
timetable and from "Locked now". Per-phone off beats the fleet toggle.

**Amud-class boys** (second seder from 16:15): add a device-specific window 15:35–16:15,
priority 200, switching to the phone's own rung policy, so the lock resumes at 16:15.

---

## What is working, and what is not (as of 2026-09-22)

**Offline logic — all green.** The full test suite passes, including every yeshiva check: all
four rungs, image blanking, the keyword threshold, the in-app-picture allowlist, the shiur web
lock and its toggles, and migration on and off the tag. The rules that decide behaviour are
sound and covered.

**On real devices:**

| Area | Status |
|---|---|
| Standard rungs 1–5 (web filtering) | The live path since 25 Aug 2026; the daily fleet runs on it |
| Yeshiva rungs 1, 2, 4 (web) | Enrolled and running on live phones |
| **Yeshiva rung 3 — Spotify** | Enrolled and running. Blocking in-app pictures on rung 3 had emptied Spotify's catalogue (playlists and podcasts showed no songs), so **rung 3 now keeps in-app pictures on — regular Spotify** — until the host set responsible is found (`NEXT-SESSION.md`). The browser's own image blanking is unaffected. |
| Shiur lock — web half | Working; the proxy enforces it |
| Shiur lock — **app half** | **Not built.** Headwind Remove uninstalls a Play app permanently, so it cannot take an app away for a window and give it back. Needs kiosk / Managed Launcher / app-suspension; none chosen yet. Do not map a Shiur configuration that lists a Play app as Remove. |
| Chrome honouring the pushed proxy | A documented Android managed policy; confirm per phone at `chrome://policy` |
| Image blanking on Android Chrome | Unproven on a device; verify with the Wikipedia grey-box test |
| Scheduler config swap on the live agent | Tested against a fake Headwind; not yet watched on a real agent |

**Restrictions that complete the allowlist rungs** (yeshiva 1–2, in the configuration's MDM
Settings): `no_install_apps`, and removing the Play Store (`com.android.vending`). Rungs 3–4
need the store. Note that rungs 1 and 2 enforce via the blocklist, not the allowlist — Push apps
never removes an app merely for being absent from an allowlist.

Bottom line: **standard rungs and all four yeshiva rungs are usable now; yeshiva rung 3 runs
regular Spotify (in-app pictures on) until the catalogue-emptying host is found; the shiur lock
protects the web but not yet the apps.**
