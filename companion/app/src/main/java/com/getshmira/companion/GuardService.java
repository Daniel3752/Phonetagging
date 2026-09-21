package com.getshmira.companion;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Resources;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.List;

/**
 * The on-device half of the filter: an accessibility service that watches WhatsApp's screen and
 * closes the Updates tab (Status and Channels) and any channel screen, on phones whose policy says
 * so ({@link PolicyClient}). The network cannot do this — the feed rides the same pinned socket as
 * the chats — so it is done where the feed is drawn.
 * <p>
 * How a forbidden screen is recognised ({@link GuardRules}, served by the Worker so a WhatsApp
 * release that moves a button is an edit on the server, not a rebuild):
 * <ol>
 *   <li>the foreground activity's class name matches a channel/status activity
 *       (WhatsApp calls channels "newsletters" internally);</li>
 *   <li>a node on screen has a view id that only exists on those screens;</li>
 *   <li>a node that is a SELECTED tab, a heading, or lives in a tab bar / toolbar carries one of
 *       the tab's names ("Updates", "Channels", "Find channels", or the Hebrew) — never a plain
 *       message bubble, which is why a text alone is not enough;</li>
 *   <li>a conversation whose subtitle reads "N followers": a channel opened from a link.</li>
 * </ol>
 * What it does: click the Chats tab if it is on screen, else press Back; if the same screen is
 * still there after two tries, go Home. One short toast says why. Actions are rate-limited so a
 * screen that will not go away cannot spin the CPU.
 * <p>
 * It also guards ITSELF: opened in Settings (the accessibility page or the app's info page,
 * identified by this app's name on a settings package's screen), it presses Back, so the switch
 * cannot be reached from the phone. {@link GuardKeeper} re-enables the service if it is turned
 * off some other way.
 * <p>
 * Everything here runs on the main thread. Nothing may throw: an exception in an accessibility
 * callback kills the process that also hosts the install watcher.
 */
public class GuardService extends AccessibilityService {

    private static final String TAG = Companion.TAG;

    /** Inspect the screen at most this often per package event burst. */
    private static final long INSPECT_THROTTLE_MS = 250L;
    /** Walk at most this many nodes per inspection. WhatsApp's home is a few hundred. */
    private static final int MAX_NODES = 700;
    /** After this many consecutive actions on one screen without it changing, go Home. */
    private static final int STUBBORN_AFTER = 2;
    /** Forget the "stubborn" count once the screen has been quiet this long. */
    private static final long STUBBORN_RESET_MS = 4_000L;
    /** One toast per this interval at most. */
    private static final long TOAST_INTERVAL_MS = 3_000L;

    private static final String[] SETTINGS_PACKAGES = {
            "com.android.settings", "com.samsung.android.settings", "com.miui.securitycenter",
            "com.android.permissioncontroller",
    };

    private final Handler handler = new Handler(Looper.getMainLooper());
    private GuardRules rules;
    private boolean enforcing = true;
    private CharSequence lastWindowClass;
    private CharSequence lastWindowPackage;
    private long lastInspectAt;
    private long lastActionAt;
    private long lastToastAt;
    private int consecutiveActions;
    private boolean inspectPending;
    private final SharedPreferences.OnSharedPreferenceChangeListener policyWatch =
            (prefs, key) -> reloadPolicy("policy changed");

    private final Runnable inspect = new Runnable() {
        @Override
        public void run() {
            inspectPending = false;
            try {
                inspectScreen();
            } catch (RuntimeException e) {
                Log.e(TAG, "guard inspection failed: " + e, e);
            }
        }
    };

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        Log.i(TAG, "GuardService connected");
        reloadPolicy("service connected");
        // Make sure the watcher (which refreshes the policy) is up whenever the guard is.
        Companion.startWatchService(this, "guard connected");
        try {
            getSharedPreferences(PolicyClient.PREFS, Context.MODE_PRIVATE)
                    .registerOnSharedPreferenceChangeListener(policyWatch);
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot watch the policy prefs: " + e);
        }
    }

    @Override
    public void onDestroy() {
        try {
            getSharedPreferences(PolicyClient.PREFS, Context.MODE_PRIVATE)
                    .unregisterOnSharedPreferenceChangeListener(policyWatch);
        } catch (RuntimeException ignored) {
            // never registered
        }
        handler.removeCallbacksAndMessages(null);
        Log.i(TAG, "GuardService destroyed");
        super.onDestroy();
    }

    @Override
    public void onInterrupt() {
        // Nothing continuous to interrupt.
    }

    /** Re-reads the policy flag and the rules, and tells the system which packages to send. */
    private void reloadPolicy(String why) {
        try {
            enforcing = PolicyClient.blockWhatsappUpdates(this);
            GuardRules served = GuardRules.parse(PolicyClient.servedRulesJson(this));
            GuardRules builtIn = GuardRules.parse(readRaw(R.raw.guard_rules));
            if (served != null && (builtIn == null || served.version >= builtIn.version)) {
                rules = served;
            } else {
                rules = builtIn;
            }
            if (rules == null) {
                Log.e(TAG, "guard: no usable rules at all; the guard is idle");
                return;
            }
            AccessibilityServiceInfo info = getServiceInfo();
            if (info != null) {
                // The watched packages plus the settings apps (for the self-guard). An empty list
                // would mean every package, which is far more events than this needs.
                String[] pkgs = new String[rules.packages.size() + SETTINGS_PACKAGES.length];
                for (int i = 0; i < rules.packages.size(); i++) {
                    pkgs[i] = rules.packages.get(i);
                }
                System.arraycopy(SETTINGS_PACKAGES, 0, pkgs, rules.packages.size(), SETTINGS_PACKAGES.length);
                info.packageNames = pkgs;
                setServiceInfo(info);
            }
            Log.i(TAG, "guard: " + why + " — whatsapp updates " + (enforcing ? "BLOCKED" : "allowed")
                    + ", rules v" + rules.version + " (" + rules.packages + ")");
        } catch (RuntimeException e) {
            Log.e(TAG, "guard: reloading the policy failed: " + e, e);
        }
    }

    private String readRaw(int id) {
        try (InputStream in = getResources().openRawResource(id);
             BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            char[] buf = new char[4096];
            int n;
            while ((n = r.read(buf)) > 0) {
                sb.append(buf, 0, n);
            }
            return sb.toString();
        } catch (IOException | Resources.NotFoundException e) {
            Log.e(TAG, "guard: cannot read the built-in rules: " + e);
            return null;
        }
    }

    // ----------------------------------------------------------------------------------

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        try {
            if (event == null) {
                return;
            }
            CharSequence pkg = event.getPackageName();
            if (pkg == null) {
                return;
            }
            if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
                lastWindowPackage = pkg;
                lastWindowClass = event.getClassName();
                consecutiveActions = 0;
            }
            if (isSettingsPackage(pkg)) {
                scheduleInspect();
                return;
            }
            if (rules == null || !enforcing || !rules.watchesPackage(pkg)) {
                return;
            }
            scheduleInspect();
        } catch (RuntimeException e) {
            Log.e(TAG, "guard event failed: " + e, e);
        }
    }

    private void scheduleInspect() {
        if (inspectPending) {
            return;
        }
        long now = SystemClock.uptimeMillis();
        long wait = Math.max(0L, INSPECT_THROTTLE_MS - (now - lastInspectAt));
        inspectPending = true;
        handler.postDelayed(inspect, wait);
    }

    private static boolean isSettingsPackage(CharSequence pkg) {
        String p = pkg.toString();
        for (String s : SETTINGS_PACKAGES) {
            if (s.equals(p)) {
                return true;
            }
        }
        return false;
    }

    private void inspectScreen() {
        lastInspectAt = SystemClock.uptimeMillis();
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) {
            return;
        }
        try {
            CharSequence pkg = root.getPackageName();
            if (pkg == null) {
                return;
            }
            if (isSettingsPackage(pkg)) {
                guardOwnSettings(root);
                return;
            }
            if (rules == null || !enforcing || !rules.watchesPackage(pkg)) {
                return;
            }
            String reason = forbiddenReason(root);
            if (reason == null) {
                if (lastActionAt != 0 && SystemClock.uptimeMillis() - lastActionAt > STUBBORN_RESET_MS) {
                    consecutiveActions = 0;
                }
                return;
            }
            act(root, reason);
        } finally {
            recycle(root);
        }
    }

    /** Why this screen is forbidden, or null if it is fine. */
    private String forbiddenReason(AccessibilityNodeInfo root) {
        CharSequence cls = lastWindowClass;
        if (cls != null && lastWindowPackage != null && rules.watchesPackage(lastWindowPackage)
                && GuardRules.any(rules.channelActivities, cls)) {
            return "activity " + cls;
        }
        // One bounded, breadth-first walk over the tree.
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        int seen = 0;
        String found = null;
        try {
            while (!queue.isEmpty() && seen < MAX_NODES && found == null) {
                AccessibilityNodeInfo n = queue.poll();
                if (n == null) {
                    continue;
                }
                seen++;
                found = matchNode(n);
                if (found == null) {
                    int count = n.getChildCount();
                    for (int i = 0; i < count && seen + queue.size() < MAX_NODES; i++) {
                        AccessibilityNodeInfo c = n.getChild(i);
                        if (c != null) {
                            queue.add(c);
                        }
                    }
                }
                if (n != root) {
                    recycle(n);
                }
            }
        } finally {
            for (AccessibilityNodeInfo n : queue) {
                if (n != root) {
                    recycle(n);
                }
            }
        }
        return found;
    }

    private String matchNode(AccessibilityNodeInfo n) {
        // Off-screen pages of WhatsApp's tab pager can sit in the tree with the visible one; the
        // Updates tab's list must not count while the person is looking at the chats.
        if (!n.isVisibleToUser()) {
            return null;
        }
        dumpForTuning(n);
        String id = n.getViewIdResourceName();
        if (id != null) {
            // "com.whatsapp:id/foo" -> "foo"
            int slash = id.indexOf('/');
            String bare = slash >= 0 ? id.substring(slash + 1) : id;
            if (GuardRules.any(rules.updatesViewIds, bare)) {
                return "view id " + bare;
            }
        }
        CharSequence text = n.getText();
        CharSequence desc = n.getContentDescription();
        if (isTabLike(n, id)) {
            if (GuardRules.any(rules.updatesTexts, trim(text)) || GuardRules.any(rules.updatesTexts, trim(desc))) {
                return "tab \"" + (text != null ? text : desc) + "\"";
            }
        }
        if (GuardRules.any(rules.conversationTexts, trim(text)) || GuardRules.any(rules.conversationTexts, trim(desc))) {
            return "channel conversation (\"" + (text != null ? text : desc) + "\")";
        }
        return null;
    }

    /**
     * Tuning aid: with {@code adb shell setprop log.tag.ShmiraGuardDump DEBUG} every visible node
     * with a view id or text is logged, so the ids and labels of a new WhatsApp build can be read
     * off a phone and turned into rules (src/companion-rules.js) without a debugger. Off (one
     * cheap check) otherwise.
     */
    private static void dumpForTuning(AccessibilityNodeInfo n) {
        if (!Log.isLoggable("ShmiraGuardDump", Log.DEBUG)) {
            return;
        }
        String id = n.getViewIdResourceName();
        CharSequence text = n.getText();
        CharSequence desc = n.getContentDescription();
        if (id == null && text == null && desc == null) {
            return;
        }
        Log.d("ShmiraGuardDump", (n.getClassName() == null ? "" : n.getClassName()) + " id=" + id
                + " text=" + text + " desc=" + desc + (n.isSelected() ? " SELECTED" : "")
                + (isHeading(n) ? " HEADING" : "") + (n.isClickable() ? " clickable" : ""));
    }

    /**
     * A node whose text may be trusted as the name of the screen the person is ON: the SELECTED
     * tab (itself, or its parent or grandparent — WhatsApp's tab label is a child of the tab), a
     * heading, or a toolbar / title / header view by its own or its parent's view id. NOT an
     * unselected tab: the bottom bar shows "Updates" on every screen, and treating that label as
     * a hit would bounce the person out of the Chats tab. And not a message bubble, which is none
     * of these.
     */
    private static boolean isTabLike(AccessibilityNodeInfo n, String id) {
        if (n.isSelected()) {
            return true;
        }
        if (isHeading(n)) {
            return true;
        }
        if (looksLikeTitle(id)) {
            return true;
        }
        AccessibilityNodeInfo p = n.getParent();
        if (p == null) {
            return false;
        }
        try {
            if (p.isSelected() || looksLikeTitle(p.getViewIdResourceName())) {
                return true;
            }
            AccessibilityNodeInfo gp = p.getParent();
            if (gp == null) {
                return false;
            }
            try {
                return gp.isSelected();
            } finally {
                recycle(gp);
            }
        } finally {
            recycle(p);
        }
    }

    /** A toolbar, action bar, screen title or section header — never a tab or navigation item. */
    private static boolean looksLikeTitle(String id) {
        if (id == null) {
            return false;
        }
        String s = id.toLowerCase();
        if (s.contains("tab") || s.contains("navigation") || s.contains("nav_") || s.contains("bottom")) {
            return false;
        }
        return s.contains("toolbar") || s.contains("action_bar") || s.contains("title") || s.contains("header");
    }

    /** AccessibilityNodeInfo.isHeading() exists from API 28; this app runs from 26. */
    private static boolean isHeading(AccessibilityNodeInfo n) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && n.isHeading();
    }

    private static boolean looksStructural(String id) {
        if (id == null) {
            return false;
        }
        String s = id.toLowerCase();
        return s.contains("tab") || s.contains("toolbar") || s.contains("navigation") || s.contains("action_bar")
                || s.contains("title") || s.contains("header") || s.contains("nav_");
    }

    private static CharSequence trim(CharSequence s) {
        return s == null ? null : s.toString().trim();
    }

    // ----------------------------------------------------------------------------------

    private void act(AccessibilityNodeInfo root, String reason) {
        long now = SystemClock.uptimeMillis();
        if (now - lastActionAt < rules.minActionIntervalMs) {
            // Too soon; look again shortly rather than hammer the UI.
            scheduleInspect();
            return;
        }
        lastActionAt = now;
        consecutiveActions++;
        String how;
        if (consecutiveActions > STUBBORN_AFTER) {
            performGlobalAction(GLOBAL_ACTION_HOME);
            how = "home";
            consecutiveActions = 0;
        } else if (clickHomeTab(root)) {
            how = "chats tab";
        } else {
            performGlobalAction(GLOBAL_ACTION_BACK);
            how = "back";
        }
        Log.i(TAG, "guard: closed " + reason + " (" + how + ")");
        if (now - lastToastAt > TOAST_INTERVAL_MS) {
            lastToastAt = now;
            try {
                Toast.makeText(this, rules.toast, Toast.LENGTH_SHORT).show();
            } catch (RuntimeException e) {
                Log.w(TAG, "toast failed: " + e);
            }
        }
        // Check the result soon: a stubborn screen gets the next step.
        handler.postDelayed(inspect, rules.minActionIntervalMs + 50L);
        inspectPending = true;
    }

    /** Finds the Chats tab by its text and clicks it (or its nearest clickable ancestor). */
    private boolean clickHomeTab(AccessibilityNodeInfo root) {
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        int seen = 0;
        boolean clicked = false;
        try {
            while (!queue.isEmpty() && seen < MAX_NODES && !clicked) {
                AccessibilityNodeInfo n = queue.poll();
                if (n == null) {
                    continue;
                }
                seen++;
                if (n.isVisibleToUser() && (GuardRules.any(rules.homeTexts, trim(n.getText()))
                        || GuardRules.any(rules.homeTexts, trim(n.getContentDescription())))) {
                    clicked = clickNodeOrAncestor(n);
                }
                if (!clicked) {
                    int count = n.getChildCount();
                    for (int i = 0; i < count && seen + queue.size() < MAX_NODES; i++) {
                        AccessibilityNodeInfo c = n.getChild(i);
                        if (c != null) {
                            queue.add(c);
                        }
                    }
                }
                if (n != root) {
                    recycle(n);
                }
            }
        } finally {
            for (AccessibilityNodeInfo n : queue) {
                if (n != root) {
                    recycle(n);
                }
            }
        }
        return clicked;
    }

    private static boolean clickNodeOrAncestor(AccessibilityNodeInfo n) {
        AccessibilityNodeInfo cur = n;
        for (int depth = 0; cur != null && depth < 4; depth++) {
            if (cur.isClickable() && cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                if (cur != n) {
                    recycle(cur);
                }
                return true;
            }
            AccessibilityNodeInfo p = cur.getParent();
            if (cur != n) {
                recycle(cur);
            }
            cur = p;
        }
        if (cur != null && cur != n) {
            recycle(cur);
        }
        return false;
    }

    // ----------------------------------------------------------------------------------
    // Self-guard: this app's own pages in Settings.

    private void guardOwnSettings(AccessibilityNodeInfo root) {
        String me = getString(R.string.app_name);
        if (me == null || me.isEmpty()) {
            return;
        }
        // The app's name as a screen title or list header on a settings screen. WhatsApp's own
        // name never appears there, and this app's name appears only on its accessibility page,
        // its app-info page and the accessibility list — the first two are what to block.
        if (!titleMentions(root, me)) {
            return;
        }
        long now = SystemClock.uptimeMillis();
        if (now - lastActionAt < 400L) {
            scheduleInspect();
            return;
        }
        lastActionAt = now;
        performGlobalAction(GLOBAL_ACTION_BACK);
        Log.i(TAG, "guard: closed this app's own settings page");
        if (now - lastToastAt > TOAST_INTERVAL_MS) {
            lastToastAt = now;
            try {
                Toast.makeText(this, getString(R.string.guard_self_toast), Toast.LENGTH_SHORT).show();
            } catch (RuntimeException e) {
                Log.w(TAG, "toast failed: " + e);
            }
        }
        handler.postDelayed(inspect, 500L);
        inspectPending = true;
    }

    /** Is the app's name the title / a heading of this settings screen (not merely a list row)? */
    private static boolean titleMentions(AccessibilityNodeInfo root, String name) {
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        int seen = 0;
        boolean hit = false;
        try {
            while (!queue.isEmpty() && seen < 200 && !hit) {
                AccessibilityNodeInfo n = queue.poll();
                if (n == null) {
                    continue;
                }
                seen++;
                CharSequence t = n.getText();
                if (t != null && t.toString().trim().equalsIgnoreCase(name)) {
                    String id = n.getViewIdResourceName();
                    // A title/heading, or a collapsing toolbar title; a list row is neither.
                    if (isHeading(n) || looksStructural(id) || (id != null && id.contains("entity_header"))) {
                        hit = true;
                    }
                }
                if (!hit) {
                    int count = n.getChildCount();
                    for (int i = 0; i < count && seen + queue.size() < 200; i++) {
                        AccessibilityNodeInfo c = n.getChild(i);
                        if (c != null) {
                            queue.add(c);
                        }
                    }
                }
                if (n != root) {
                    recycle(n);
                }
            }
        } finally {
            for (AccessibilityNodeInfo n : queue) {
                if (n != root) {
                    recycle(n);
                }
            }
        }
        return hit;
    }

    @SuppressWarnings("deprecation")
    private static void recycle(AccessibilityNodeInfo n) {
        // A no-op since API 33; still required below it to return the node to the pool.
        try {
            n.recycle();
        } catch (RuntimeException ignored) {
            // already recycled, or a node the system owns
        }
    }
}
