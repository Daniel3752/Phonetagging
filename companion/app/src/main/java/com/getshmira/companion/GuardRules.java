package com.getshmira.companion;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * The detection rules the accessibility guard runs on: which packages to watch, which activity
 * class names and which on-screen ids and texts mean "the Updates tab or a channel", and what
 * to click to get away. Parsed from the JSON the Worker serves at {@code /api/companion/policy}
 * (see {@code src/companion-rules.js} in the repository) or from the copy baked into the APK
 * ({@code res/raw/guard_rules.json}); the two are generated from one source.
 * <p>
 * Every matcher is either {@code {"contains": "..."}} (case-insensitive substring) or
 * {@code {"regex": "..."}} (a Java regular expression, case-insensitive, matched against the
 * whole string). A rule that does not parse is dropped with a log line rather than taking the
 * set down: a guard with one rule fewer beats no guard.
 */
final class GuardRules {

    private static final String TAG = Companion.TAG;

    /** One matcher. */
    static final class Matcher {
        final String contains;      // lower-cased, or null
        final Pattern regex;        // or null

        private Matcher(String contains, Pattern regex) {
            this.contains = contains;
            this.regex = regex;
        }

        boolean matches(CharSequence value) {
            if (value == null || value.length() == 0) {
                return false;
            }
            if (contains != null) {
                return value.toString().toLowerCase(Locale.ROOT).contains(contains);
            }
            return regex != null && regex.matcher(value).matches();
        }

        static Matcher parse(JSONObject o) {
            String c = o.optString("contains", null);
            if (c != null && !c.isEmpty()) {
                return new Matcher(c.toLowerCase(Locale.ROOT), null);
            }
            String r = o.optString("regex", null);
            if (r != null && !r.isEmpty()) {
                try {
                    return new Matcher(null, Pattern.compile(r, Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE));
                } catch (PatternSyntaxException e) {
                    Log.w(TAG, "guard rule regex rejected: " + r + " (" + e.getDescription() + ")");
                }
            }
            return null;
        }
    }

    final int version;
    final List<String> packages;
    final List<Matcher> channelActivities;
    final List<Matcher> updatesViewIds;
    final List<Matcher> updatesTexts;
    final List<Matcher> homeTexts;
    final List<Matcher> conversationTexts;
    final String toast;
    final long minActionIntervalMs;

    private GuardRules(int version, List<String> packages, List<Matcher> channelActivities,
                       List<Matcher> updatesViewIds, List<Matcher> updatesTexts, List<Matcher> homeTexts,
                       List<Matcher> conversationTexts, String toast, long minActionIntervalMs) {
        this.version = version;
        this.packages = Collections.unmodifiableList(packages);
        this.channelActivities = Collections.unmodifiableList(channelActivities);
        this.updatesViewIds = Collections.unmodifiableList(updatesViewIds);
        this.updatesTexts = Collections.unmodifiableList(updatesTexts);
        this.homeTexts = Collections.unmodifiableList(homeTexts);
        this.conversationTexts = Collections.unmodifiableList(conversationTexts);
        this.toast = toast;
        this.minActionIntervalMs = minActionIntervalMs;
    }

    /**
     * Parses {@code {"rules_version": n, "rules": {...}}}. Returns null when the document is not
     * usable at all (no packages, or not JSON), so the caller keeps whatever it had.
     */
    static GuardRules parse(String json) {
        if (json == null || json.isEmpty()) {
            return null;
        }
        try {
            JSONObject doc = new JSONObject(json);
            JSONObject rules = doc.optJSONObject("rules");
            if (rules == null) {
                rules = doc;   // a bare rules object is accepted too
            }
            List<String> packages = strings(rules.optJSONArray("packages"));
            if (packages.isEmpty()) {
                Log.w(TAG, "guard rules list no packages; ignoring the set");
                return null;
            }
            return new GuardRules(
                    doc.optInt("rules_version", 0),
                    packages,
                    matchers(rules.optJSONArray("channel_activities")),
                    matchers(rules.optJSONArray("updates_view_ids")),
                    matchers(rules.optJSONArray("updates_texts")),
                    matchers(rules.optJSONArray("home_texts")),
                    matchers(rules.optJSONArray("conversation_texts")),
                    rules.optString("toast", "This is turned off on this phone."),
                    Math.max(100L, rules.optLong("min_action_interval_ms", 400L)));
        } catch (JSONException e) {
            Log.w(TAG, "guard rules are not valid JSON: " + e);
            return null;
        }
    }

    boolean watchesPackage(CharSequence pkg) {
        if (pkg == null) {
            return false;
        }
        String p = pkg.toString();
        for (String w : packages) {
            if (w.equals(p)) {
                return true;
            }
        }
        return false;
    }

    static boolean any(List<Matcher> matchers, CharSequence value) {
        for (Matcher m : matchers) {
            if (m.matches(value)) {
                return true;
            }
        }
        return false;
    }

    private static List<String> strings(JSONArray a) {
        List<String> out = new ArrayList<>();
        if (a == null) {
            return out;
        }
        for (int i = 0; i < a.length(); i++) {
            String s = a.optString(i, null);
            if (s != null && !s.isEmpty()) {
                out.add(s);
            }
        }
        return out;
    }

    private static List<Matcher> matchers(JSONArray a) {
        List<Matcher> out = new ArrayList<>();
        if (a == null) {
            return out;
        }
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            Matcher m = o == null ? null : Matcher.parse(o);
            if (m != null) {
                out.add(m);
            }
        }
        return out;
    }
}
