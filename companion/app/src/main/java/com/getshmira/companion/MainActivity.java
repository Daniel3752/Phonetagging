package com.getshmira.companion;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;

/**
 * Invisible launcher entry point (translucent theme, nothing drawn).
 * <p>
 * It exists so that Headwind's "run after install" and "run at boot" can start this app,
 * and so that a person can tap the icon: either way it starts {@link WatchService} and
 * goes away immediately.
 */
public class MainActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i(Companion.TAG, "MainActivity launched");
        Companion.startWatchService(this, "activity");
        finish();
    }
}
