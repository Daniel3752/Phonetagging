package com.getshmira.companion;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.WindowManager;

/**
 * Invisible launcher entry point (translucent theme, nothing drawn, touches pass through).
 * <p>
 * It exists so that Headwind's "run after install" and "run at boot" can start this app,
 * and so that a person can tap the icon: either way it starts {@link WatchService} and
 * goes away.
 * <p>
 * The start can be refused. Android 12+ only lets an app in the TOP state start a
 * foreground service from an activity, and Headwind launches this activity during a
 * background sync, typically while the phone is locked in a pocket. Shown over the
 * keyguard (showWhenLocked in the manifest) a locked-but-lit phone counts as top; a phone
 * with the screen off does not. So on refusal the activity does not finish: it stays,
 * invisible and untouchable, and tries again each time it is resumed (the screen coming
 * on brings it back over the lock screen) and on a slow timer, for up to ten minutes.
 * After that it gives up and leaves the next boot, or the next MDM launch, to try again.
 */
public class MainActivity extends Activity {

    private static final String TAG = Companion.TAG;

    /** Retry cadence while the start is refused. */
    private static final long RETRY_MS = 15_000L;

    /** Give up after this long; the boot receiver and the MDM's next launch remain. */
    private static final long GIVE_UP_MS = 10L * 60L * 1000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private long createdAt;
    private boolean started;

    private final Runnable retry = new Runnable() {
        @Override
        public void run() {
            tryStart("retry");
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Nothing is drawn, so never take input either: an invisible window that swallowed
        // touches would block the launcher underneath while we wait.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
        createdAt = System.currentTimeMillis();
        Log.i(TAG, "MainActivity launched");
    }

    @Override
    protected void onResume() {
        super.onResume();
        tryStart("activity resumed");
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(retry);
        super.onDestroy();
    }

    private void tryStart(String why) {
        if (started || isFinishing()) {
            return;
        }
        handler.removeCallbacks(retry);
        if (Companion.startWatchService(this, why)) {
            started = true;
            finish();
            return;
        }
        long waited = System.currentTimeMillis() - createdAt;
        if (waited >= GIVE_UP_MS) {
            Log.w(TAG, "giving up starting the service from the activity after "
                    + waited / 1000 + "s; the boot receiver or the next MDM launch will try again");
            finish();
            return;
        }
        Log.w(TAG, "service start refused (" + why + "); waiting for the phone to be usable");
        handler.postDelayed(retry, RETRY_MS);
    }
}
