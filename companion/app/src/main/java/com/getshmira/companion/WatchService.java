package com.getshmira.companion;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * The one job of this app: notice an app install the moment it completes and make the
 * Headwind MDM agent re-apply its configuration, so a blocklisted app is gone within
 * seconds instead of at the agent's next sync.
 * <p>
 * Since Android 8, PACKAGE_ADDED / PACKAGE_REPLACED cannot be received by a manifest
 * receiver (other than for one's own package), so this is a foreground service that
 * registers a runtime receiver and stays alive. Every callback here runs on the main
 * thread, so the pending set and the handler need no locking.
 */
public class WatchService extends Service {

    private static final String TAG = Companion.TAG;

    /** Intent extra saying who started us; purely for the log. */
    static final String EXTRA_REASON = "com.getshmira.companion.REASON";

    private static final String CHANNEL_ID = "protection";
    private static final int NOTIFICATION_ID = 1;

    /** Coalesce a burst of package events into one nudge this long after the last event. */
    static final long DEBOUNCE_MS = 3_000L;

    /** Safety net: nudge regardless, so a missed broadcast costs at most this much. */
    static final long PERIODIC_MS = 30L * 60L * 1000L;

    /**
     * First safety-net nudge after the service comes up. Catches installs that happened
     * while the service was down (after a crash, a force-stop, or before the first launch)
     * without duplicating the agent's own boot-time sync, which it is probably still doing.
     */
    static final long FIRST_PERIODIC_MS = 2L * 60L * 1000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final LinkedHashSet<String> pendingPackages = new LinkedHashSet<>();
    private AgentClient agent;
    private BroadcastReceiver packageReceiver;
    private boolean foreground;

    private final Runnable debouncedNudge = new Runnable() {
        @Override
        public void run() {
            List<String> packages = new ArrayList<>(pendingPackages);
            pendingPackages.clear();
            Log.i(TAG, "nudging agent for " + packages);
            agent.nudge(packages, "install detected");
        }
    };

    private final Runnable periodicNudge = new Runnable() {
        @Override
        public void run() {
            Log.i(TAG, "periodic safety-net nudge");
            agent.nudge(Collections.<String>emptyList(), "periodic safety-net check");
            handler.postDelayed(this, PERIODIC_MS);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        Log.i(TAG, "WatchService created (API " + Build.VERSION.SDK_INT + ", "
                + Build.MANUFACTURER + " " + Build.MODEL + ")");
        foreground = goForeground();
        if (!foreground) {
            // Without foreground status Android 8+ kills a background service within a
            // minute anyway, and an unfulfilled startForegroundService() ends in an ANR.
            // Bow out cleanly; the next boot or MDM launch tries again.
            Log.e(TAG, "not running: could not become a foreground service");
            stopSelf();
            return;
        }
        agent = new AgentClient(this);
        registerPackageReceiver();
        handler.postDelayed(periodicNudge, FIRST_PERIODIC_MS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String reason = intent == null ? "restart by system" : intent.getStringExtra(EXTRA_REASON);
        Log.i(TAG, "onStartCommand (" + reason + ")");
        if (!foreground) {
            return START_NOT_STICKY;
        }
        // If Android kills the process, ask to be restarted (with a null intent).
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "WatchService destroyed");
        handler.removeCallbacksAndMessages(null);
        if (packageReceiver != null) {
            try {
                unregisterReceiver(packageReceiver);
            } catch (IllegalArgumentException ignored) {
                // already unregistered
            }
            packageReceiver = null;
        }
        if (agent != null) {
            agent.shutdown();
            agent = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /**
     * Creates the low-importance channel and promotes this service to the foreground with a
     * minimal persistent notification. On API 33+ the notification may not be displayed
     * without POST_NOTIFICATIONS (never requested: this app has no UI); the service still
     * runs, which is what matters.
     */
    private boolean goForeground() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(getString(R.string.channel_description));
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_shield)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(R.string.notification_text))
                .setCategory(Notification.CATEGORY_SERVICE)
                .setOngoing(true)
                .setShowWhen(false)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // API 34+ checks the type against the manifest and its per-type permission.
                startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                // API 26-33: the two-argument form uses whatever the manifest declares.
                startForeground(NOTIFICATION_ID, notification);
            }
            Log.i(TAG, "running in the foreground");
            return true;
        } catch (SecurityException | IllegalStateException e) {
            // ForegroundServiceStartNotAllowedException (API 31+) and the API 34
            // ForegroundServiceType*Exceptions are all IllegalStateExceptions.
            Log.e(TAG, "startForeground refused: " + e, e);
            return false;
        }
    }

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    private void registerPackageReceiver() {
        packageReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                onPackageEvent(intent);
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_PACKAGE_ADDED);
        filter.addAction(Intent.ACTION_PACKAGE_REPLACED);
        filter.addDataScheme("package");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Android 13/14 want an explicit export flag. These are protected broadcasts
            // that only the system can send, so exporting the receiver gives nothing away,
            // and RECEIVER_EXPORTED is the flag that is guaranteed to receive them.
            registerReceiver(packageReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(packageReceiver, filter);
        }
        Log.i(TAG, "listening for package installs and updates");
    }

    private void onPackageEvent(Intent intent) {
        if (intent == null) {
            return;
        }
        String action = intent.getAction();
        Uri data = intent.getData();
        String pkg = data == null ? null : data.getSchemeSpecificPart();
        if (action == null || pkg == null || pkg.isEmpty()) {
            return;
        }
        if (pkg.equals(getPackageName())) {
            Log.d(TAG, "ignoring " + action + " for ourselves");
            return;
        }
        if (Intent.ACTION_PACKAGE_ADDED.equals(action)
                && intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)) {
            // An update sends PACKAGE_ADDED(replacing) and then PACKAGE_REPLACED;
            // one trigger per update is enough, and the REPLACED one always follows.
            Log.d(TAG, "ignoring PACKAGE_ADDED for update of " + pkg + " (PACKAGE_REPLACED follows)");
            return;
        }
        Log.i(TAG, action.substring(action.lastIndexOf('.') + 1) + " " + pkg);
        pendingPackages.add(pkg);
        handler.removeCallbacks(debouncedNudge);
        handler.postDelayed(debouncedNudge, DEBOUNCE_MS);
    }
}
