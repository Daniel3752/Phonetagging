package com.getshmira.companion;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Brings the watch service back after a reboot and after this app itself is updated.
 * <p>
 * Both broadcasts are protected (only the system can send them) and both are on
 * Android 12+'s list of exemptions for starting a foreground service from the background,
 * so {@code startForegroundService} is legitimate here on API 26 through 35.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            Log.i(Companion.TAG, "received " + action);
            Companion.startWatchService(context, action);
        } else {
            // The receiver is exported; anything but the two protected actions is noise.
            Log.w(Companion.TAG, "BootReceiver ignoring unexpected action " + action);
        }
    }
}
