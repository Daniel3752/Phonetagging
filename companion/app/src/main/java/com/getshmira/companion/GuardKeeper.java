package com.getshmira.companion;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.ContentObserver;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.Log;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Keeps {@link GuardService} switched on.
 * <p>
 * An accessibility service is enabled by a line in {@code Settings.Secure.ENABLED_ACCESSIBILITY_
 * SERVICES}. A person with the phone can remove it (Settings > Accessibility), and no Device
 * Owner restriction forbids that. Two things stop it: the guard itself backs out of its own
 * settings page (see GuardService), and this class watches the setting and puts the line back
 * the moment it disappears — which it can do only if the app holds WRITE_SECURE_SETTINGS, a
 * permission the platform lets adb grant to any app that declares it:
 * <pre>
 *   adb shell pm grant com.getshmira.companion android.permission.WRITE_SECURE_SETTINGS
 * </pre>
 * That is a one-off step in the phone's setup (NEW-PHONE.md). Without it the keeper can only
 * notice and complain: logcat, plus a line in the Headwind device log through the watch service.
 */
final class GuardKeeper {

    private static final String TAG = Companion.TAG;

    /** Also poll, in case an observer callback is missed. */
    static final long POLL_MS = 15L * 60L * 1000L;

    private final Context context;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final WatchService service;
    private ContentObserver observer;
    private boolean reportedNoPermission;

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            ensureEnabled("periodic check");
            handler.postDelayed(this, POLL_MS);
        }
    };

    GuardKeeper(WatchService service) {
        this.service = service;
        this.context = service.getApplicationContext();
    }

    void start() {
        observer = new ContentObserver(handler) {
            @Override
            public void onChange(boolean selfChange) {
                ensureEnabled("setting changed");
            }
        };
        try {
            context.getContentResolver().registerContentObserver(
                    Settings.Secure.getUriFor(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES), false, observer);
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot observe the accessibility setting: " + e);
        }
        handler.post(poll);
    }

    void stop() {
        handler.removeCallbacksAndMessages(null);
        if (observer != null) {
            try {
                context.getContentResolver().unregisterContentObserver(observer);
            } catch (RuntimeException ignored) {
                // never registered
            }
            observer = null;
        }
    }

    static ComponentName component(Context context) {
        return new ComponentName(context.getPackageName(), GuardService.class.getName());
    }

    /** Is the guard listed as enabled right now? */
    static boolean isEnabled(Context context) {
        String enabled = null;
        try {
            enabled = Settings.Secure.getString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot read the accessibility setting: " + e);
        }
        if (TextUtils.isEmpty(enabled)) {
            return false;
        }
        String flat = component(context).flattenToString();
        String shortFlat = component(context).flattenToShortString();
        for (String s : enabled.split(":")) {
            if (s.equalsIgnoreCase(flat) || s.equalsIgnoreCase(shortFlat)) {
                return true;
            }
        }
        return false;
    }

    static boolean canWriteSecureSettings(Context context) {
        return context.checkSelfPermission(android.Manifest.permission.WRITE_SECURE_SETTINGS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** Puts the guard back if it is off. Main thread. */
    void ensureEnabled(String why) {
        try {
            if (isEnabled(context)) {
                return;
            }
            if (!canWriteSecureSettings(context)) {
                if (!reportedNoPermission) {
                    reportedNoPermission = true;
                    String note = "the accessibility guard is OFF and the app lacks WRITE_SECURE_SETTINGS to turn it "
                            + "back on; run: adb shell pm grant " + context.getPackageName()
                            + " android.permission.WRITE_SECURE_SETTINGS";
                    Log.e(TAG, note);
                    service.reportNote(note);
                }
                return;
            }
            String current = Settings.Secure.getString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            List<String> parts = new ArrayList<>();
            if (!TextUtils.isEmpty(current)) {
                for (String s : current.split(":")) {
                    if (!s.isEmpty()) {
                        parts.add(s);
                    }
                }
            }
            parts.add(component(context).flattenToString());
            Settings.Secure.putString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, TextUtils.join(":", parts));
            Settings.Secure.putInt(context.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 1);
            Log.w(TAG, "guard was off (" + why + "); re-enabled it");
            service.reportNote("the accessibility guard had been switched off (" + why + "); re-enabled it");
        } catch (RuntimeException e) {
            // SecurityException if the grant was revoked, or anything else — never let it out.
            Log.e(TAG, "cannot re-enable the guard: " + e);
        }
    }

    /** For the log: the services currently enabled, one per line. */
    static String describe(Context context) {
        String enabled = Settings.Secure.getString(context.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        return TextUtils.isEmpty(enabled) ? "(none)" : Arrays.toString(enabled.split(":"));
    }
}
