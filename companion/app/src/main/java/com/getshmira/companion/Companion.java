package com.getshmira.companion;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Shared constants and the one, defensive way to start the watch service.
 */
final class Companion {

    /** Logcat tag for everything this app prints: {@code adb logcat -s ShmiraCompanion}. */
    static final String TAG = "ShmiraCompanion";

    private Companion() {
    }

    /**
     * Starts {@link WatchService} as a foreground service.
     * <p>
     * Valid on API 26 through 35 from the places this app calls it: a visible activity
     * (the app is in the foreground) and the BOOT_COMPLETED / MY_PACKAGE_REPLACED
     * receivers, which Android 12+ exempts from the background foreground-service-start
     * restriction. Never throws: an OEM or a future Android that refuses the start is
     * logged, not crashed, and the next boot or MDM launch tries again.
     *
     * @return true if the start was accepted by the system
     */
    static boolean startWatchService(Context context, String reason) {
        Intent intent = new Intent(context, WatchService.class)
                .putExtra(WatchService.EXTRA_REASON, reason);
        try {
            context.startForegroundService(intent);
            Log.i(TAG, "startForegroundService requested (" + reason + ")");
            return true;
        } catch (SecurityException | IllegalStateException e) {
            // ForegroundServiceStartNotAllowedException (API 31+) is an IllegalStateException.
            Log.e(TAG, "could not start WatchService (" + reason + "): " + e, e);
            return false;
        }
    }
}
