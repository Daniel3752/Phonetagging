// Detection rules for the companion's accessibility guard, served by /api/companion/policy.
//
// The guard watches WhatsApp's screen and closes the Updates tab (Status and Channels) and any
// channel screen reached another way (a forwarded channel link, a search result). It recognises
// them by the foreground activity's class name and by what is on screen — view ids and texts —
// and WhatsApp changes all three from release to release. Baking the rules into the APK would
// mean a rebuild, a re-sign and a fleet update every time WhatsApp moves a button; serving them
// from here means editing this file and deploying the Worker. The APK carries the same defaults
// (companion/app/src/main/res/raw/guard_rules.json) so a phone that has never reached the Worker
// still guards, and it replaces them with the served set whenever rules_version is higher.
//
// Every string is matched case-insensitively. `contains` matches anywhere in the string,
// `regex` is a Java regular expression on the whole string. A screen is "the Updates tab" when
// the package is WhatsApp's AND (a class matches `channel_activities`, OR a node whose view id
// matches `updates_view_ids` is on screen, OR a node whose text matches `updates_texts` is a
// SELECTED tab / a screen title). Keep the texts to words that only ever appear on those screens:
// "Updates" as the selected tab title, "Channels", "Find channels". Chat texts must never match.
//
// Bump COMPANION_RULES_VERSION on every change or phones keep their cached copy.

export const COMPANION_RULES_VERSION = 3;

// Sources (2026-09-21): decompiled WhatsApp 2.24.6.77 and 2.24.24.78 (manifests, the full id table,
// strings.xml), the October-2025 activity list, Tether's kosher-MDM accessibility shield and the
// KDroid kosher database rules, and WABetaInfo on the 2026 layout. WhatsApp reshuffles package
// paths between builds (newsletter.ui.directory → newsletter.directory.ui), so class rules match
// the simple class name or the `newsletter` token, never a full path.
export const COMPANION_RULES = {
  packages: ['com.whatsapp', 'com.whatsapp.w4b'],
  // Screens that are their own activity — the cheapest catch, from the window-state event's class
  // name. Everything WhatsApp calls a "newsletter" is a channel: NewsletterInfoActivity,
  // NewsletterDirectoryActivity ("Find channels"), NewsletterDirectoryCategoriesActivity,
  // NewsletterSettingsActivity, NewsletterCreationActivity, ViewNewsletterProfilePhoto,
  // ShareNewsletterInviteLinkActivity, the newsletterenforcements screens. Status has its viewer
  // and composers. The Updates TAB is not an activity (UpdatesFragment inside HomeActivity), so
  // it is caught by the rules below, not here.
  channel_activities: [
    { contains: 'newsletter' },
    { contains: 'StatusPlayback' },
    { contains: 'MyStatuses' },
    { contains: 'MutedStatuses' },
    { contains: 'StatusComposer' },
    { contains: 'StatusPrivacy' },
    { contains: 'statusmuting' },
  ],
  // View ids (resource names, without the package) that exist only on the Updates tab, the
  // channel screens, a channel opened as a conversation, or the status viewer — and are VISIBLE.
  // Off-screen tab pages can sit in the node tree, so the guard also requires isVisibleToUser.
  // CONSERVATIVE on purpose: the bottom bar is on every screen and its items carry no WhatsApp
  // ids at all (Material's navigation_bar_item_*), and "status" alone is too common (message
  // delivery status). Left out deliberately: status_list / status_row, which WhatsApp is moving
  // to the top of the Chats tab in 2026 — a match there would bounce the person out of the chats.
  // What is left blocks the CONSUMPTION of the feed wherever WhatsApp puts its entry points.
  updates_view_ids: [
    { regex: '.*newsletter.*' },                          // every channel row, list, banner, pill, count
    { regex: '^updates_list$' },                          // the Updates tab's one list (status + channels)
    { regex: '^(find_channels_btn|see_all_status_list|status_pager|status_fullscreen)$' },
    { regex: '^status_playback.*' },                      // the status viewer
    { regex: '^directory_categories.*' },                 // "Find channels" categories
    { regex: '^menu_?item_(discover|add|create)_newsletter.*' },
    { regex: '^menuitem_(see_all_statuses|status_privacy)$' },
  ],
  // Texts that name the tab, matched only on a SELECTED tab (itself, its parent or grandparent)
  // or a title/heading — never on the unselected "Updates" label the bottom bar shows on every
  // screen (Tether's shield records exactly that bug). Verified in strings.xml (2.24.6.77) for
  // English; the Hebrew is from an Israeli walkthrough of the feature, verify on a phone.
  updates_texts: [
    { regex: '^(updates|channels|find channels|explore channels|channel updates|recent updates|viewed updates|muted updates)$' },
    { regex: '^(עדכונים|ערוצים|חיפוש ערוצים|מצא ערוצים)$' },
  ],
  // The tab to go back to: the Chats item on the same bottom bar, by its label.
  home_texts: [
    { regex: '^(chats|צ\'אטים|צ׳אטים|שיחות)$' },
  ],
  // A channel opened as a conversation: the header subtitle carries the follower count, and the
  // per-message "Forward" pill is newsletter-only (caught by the id rule above as well).
  conversation_texts: [
    { regex: '^[0-9.,kmKM+ ]+\\s*(followers|עוקבים)$' },
    { regex: '^(followers|עוקבים)$' },
  ],
  // What the guard shows the person when it acts.
  toast: 'Channels and Status are turned off on this phone.',
  // Never act more often than this on one screen (ms), so a stubborn screen does not spin the CPU.
  min_action_interval_ms: 400,
};
