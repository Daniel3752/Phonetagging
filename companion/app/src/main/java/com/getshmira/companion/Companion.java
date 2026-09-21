package com.getshmira.companion;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Shared constants and the one, defensive way to start the watch service.
 */
final class Companion {

    /** Logcat tag for everything this app prints: {@code adb logcat -s ShmiraCompanion}. */
    static final String TAG = "ShmiraCompanion";

    /** The Worker that answers /api/companion/policy. Reached through the tunnel (squid splices it). */
    static final String WORKER_URL = "https://phone-url-filter.daniel08-madar.workers.dev";

    /** The WireGuard tunnel's /24: a phone's address on it is its identity (WIREGUARD.md). */
    static final int[] TUNNEL_NET = {10, 66, 0};

    private Companion() {
    }

    /**
     * Starts {@link WatchService} as a foreground service.
     * <p>
     * Valid on API 26 through 35 from the places this app calls it: a resumed activity
     * (the app is in the foreground) and the BOOT_COMPLETED / MY_PACKAGE_REPLACED
     * receivers, which Android 12+ exempts from the background foreground-service-start
     * restriction. Never throws: a refusal (the activity path while the phone is locked or
     * the screen is off, a background-restricted app, an OEM oddity) is logged and reported
     * as false so the caller can try again later.
     *
     * @return true if the start was accepted by the system
     */
    static boolean startWatchService(Context context, String reason) {
        Intent intent = new Intent(context, WatchService.class)
                .putExtra(WatchService.EXTRA_REASON, reason);
        try {
            // API 26-30 refuse silently by returning null (or a "?"/"!!" package) instead of
            // throwing; API 31+ throw. Treat both as "not started".
            ComponentName started = context.startForegroundService(intent);
            String pkg = started == null ? null : started.getPackageName();
            if (pkg == null || pkg.startsWith("?") || pkg.startsWith("!")) {
                Log.e(TAG, "startForegroundService refused (" + reason + "): " + started);
                return false;
            }
            Log.i(TAG, "startForegroundService accepted (" + reason + ")");
            return true;
        } catch (SecurityException | IllegalStateException e) {
            // ForegroundServiceStartNotAllowedException (API 31+) is an IllegalStateException.
            Log.e(TAG, "could not start WatchService (" + reason + "): " + e, e);
            return false;
        }
    }
}
