package com.getshmira.companion;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.RemoteException;
import android.util.Log;

import com.hmdm.IMdmApi;
import com.hmdm.IMdmApiCallback;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * Talks to the Headwind MDM agent ({@code com.hmdm.launcher}) over its plugin API,
 * {@link IMdmApi}, served by the agent's {@code PluginApiService} under the action
 * {@code com.hmdm.action.Connect}.
 * <p>
 * A "nudge" is one round trip: bind, read the API version, post a line to the Headwind
 * device log, ask for a forced configuration update, wait for it to complete, unbind.
 * Only one nudge is in flight at a time; a nudge requested while one is running marks
 * "rerun after" and the client runs exactly once more when the current one completes.
 * <p>
 * Threading: {@link #nudge} and {@link #shutdown} must be called on the main thread and
 * every completion is posted back to it, so the queue and the current run need no locks.
 * The binder calls themselves run on a private worker thread: the agent's legacy
 * {@code forceConfigUpdate()} does its work on the binder thread, and a blocked main
 * thread here would delay the very PACKAGE_ADDED broadcasts we exist for.
 */
final class AgentClient {

    private static final String TAG = Companion.TAG;

    static final String AGENT_PACKAGE = "com.hmdm.launcher";
    static final String AGENT_ACTION = "com.hmdm.action.Connect";

    /**
     * {@code Const.LOG_INFO} in the agent's source ({@code com.hmdm.launcher.Const}):
     * 1 = error, 2 = warn, 3 = info, 4 = debug, 5 = verbose.
     */
    static final int AGENT_LOG_INFO = 3;

    /** Agent API version that introduced {@code forceConfigUpdate()} (library 1.1.5). */
    static final int VERSION_FORCE_UPDATE = 115;

    /** Agent API version that introduced {@code forceConfigUpdateWithCallback()} (library 1.1.9). */
    static final int VERSION_CALLBACK = 119;

    /** Give up if the agent has not connected in this long (it exists but is not coming up). */
    static final long CONNECT_TIMEOUT_MS = 30_000L;

    /**
     * The agent calls {@code onConfigUpdateStart()} as soon as it accepts the request.
     * If nothing at all arrives within this window it dropped the request silently, which
     * its {@code ConfigUpdater.updateConfig()} does whenever a sync is already in progress.
     */
    static final long ACK_TIMEOUT_MS = 20_000L;

    /** After a silently dropped install nudge, try exactly once more after this delay. */
    static final long RETRY_DELAY_MS = 45_000L;

    /** Stop waiting for completion after this long; the agent carries on by itself. */
    static final long COMPLETION_TIMEOUT_MS = 5L * 60L * 1000L;

    /** Legacy (no-callback) path: how long to stay bound after {@code forceConfigUpdate()}. */
    static final long LEGACY_UNBIND_DELAY_MS = 5_000L;

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final HandlerThread workerThread;
    private final Handler worker;

    // Main-thread state.
    private final LinkedHashSet<String> queuedPackages = new LinkedHashSet<>();
    private final LinkedHashSet<String> queuedReasons = new LinkedHashSet<>();
    private boolean queuedRetry;
    private boolean rerunRequested;
    private Run current;
    private boolean shutDown;

    AgentClient(Context context) {
        this.context = context.getApplicationContext();
        this.workerThread = new HandlerThread("ShmiraCompanion-agent");
        this.workerThread.start();
        this.worker = new Handler(this.workerThread.getLooper());
    }

    /**
     * Asks the agent to re-apply its configuration. Coalesces with a nudge already in
     * flight (runs once more after it) rather than running concurrently.
     *
     * @param packages the packages whose install triggered this; empty for a periodic nudge
     * @param reason   short human text for the logs
     */
    void nudge(Collection<String> packages, String reason) {
        if (shutDown) {
            return;
        }
        queuedPackages.addAll(packages);
        queuedReasons.add(reason);
        if (current != null) {
            rerunRequested = true;
            Log.i(TAG, "nudge (" + reason + ") queued: one is already in flight, will run again after it");
            return;
        }
        begin();
    }

    /** Releases the agent binding and the worker thread. Called from WatchService.onDestroy. */
    void shutdown() {
        shutDown = true;
        rerunRequested = false;
        queuedPackages.clear();
        queuedReasons.clear();
        main.removeCallbacksAndMessages(null);
        Run run = current;
        current = null;
        if (run != null) {
            run.done = true;
            unbind(run);
        }
        workerThread.quitSafely();
    }

    // ----------------------------------------------------------------------------------
    // One nudge, start to finish (main thread unless stated).

    private void begin() {
        Run run = new Run(new ArrayList<>(queuedPackages), String.join(", ", queuedReasons),
                queuedRetry ? 2 : 1);
        queuedPackages.clear();
        queuedReasons.clear();
        queuedRetry = false;
        current = run;

        Intent intent = new Intent(AGENT_ACTION).setPackage(AGENT_PACKAGE);
        boolean accepted;
        try {
            accepted = context.bindService(intent, run, Context.BIND_AUTO_CREATE);
        } catch (RuntimeException e) {
            // SecurityException if a future agent guards its service, or an OEM oddity.
            Log.e(TAG, "bindService threw: " + e, e);
            accepted = false;
        }
        // Even a false return holds a connection record that unbindService must release.
        run.bound = true;
        if (!accepted) {
            Log.e(TAG, "cannot bind to the MDM agent (" + AGENT_PACKAGE
                    + " missing or its service not exported); will retry on the next nudge");
            finish(run, "agent not reachable");
            return;
        }
        Log.i(TAG, "binding to agent (" + run.reason + ", attempt " + run.attempt + ")");
        main.postDelayed(run.connectTimeout, CONNECT_TIMEOUT_MS);
        main.postDelayed(run.completionTimeout, COMPLETION_TIMEOUT_MS);
    }

    /** Worker thread: the actual binder calls for one run. */
    private void drive(Run run, IMdmApi api) {
        try {
            int version = api.getVersion();
            Log.i(TAG, "agent API version " + version);
            if (version < VERSION_FORCE_UPDATE) {
                Log.w(TAG, "agent API " + version + " cannot force a config update (needs >= "
                        + VERSION_FORCE_UPDATE + "); nothing to do");
                finish(run, "unsupported agent version " + version);
                return;
            }
            if (!run.packages.isEmpty()) {
                // Shows up in the Headwind server's device log under this package id.
                String message = "install detected: " + String.join(", ", run.packages)
                        + "; forcing config update" + (run.attempt > 1 ? " (retry)" : "");
                api.log(System.currentTimeMillis(), AGENT_LOG_INFO, context.getPackageName(), message);
            }
            if (version >= VERSION_CALLBACK) {
                Log.i(TAG, "forceConfigUpdateWithCallback (" + run.reason + ")");
                api.forceConfigUpdateWithCallback(run.callback);
                main.postDelayed(run.ackTimeout, ACK_TIMEOUT_MS);
            } else {
                Log.i(TAG, "forceConfigUpdate, no callback on API " + version + " (" + run.reason + ")");
                api.forceConfigUpdate();
                main.postDelayed(() -> finish(run, "legacy update requested"), LEGACY_UNBIND_DELAY_MS);
            }
        } catch (RemoteException e) {
            Log.e(TAG, "agent call failed: " + e, e);
            finish(run, "remote exception");
        } catch (RuntimeException e) {
            // SecurityException from a guarded API, or anything else the binder throws.
            Log.e(TAG, "agent call failed: " + e, e);
            finish(run, "error: " + e);
        }
    }

    private void onConnectTimeout(Run run) {
        if (run != current || run.done || run.connected) {
            return;
        }
        Log.w(TAG, "agent accepted the bind but never connected within "
                + CONNECT_TIMEOUT_MS / 1000 + "s");
        finish(run, "agent did not connect");
    }

    private void onAckTimeout(Run run) {
        if (run != current || run.done || run.acknowledged) {
            return;
        }
        Log.w(TAG, "agent did not acknowledge within " + ACK_TIMEOUT_MS / 1000
                + "s; it drops requests while a sync of its own is running");
        if (!run.packages.isEmpty() && run.attempt < 2) {
            Log.i(TAG, "will retry once in " + RETRY_DELAY_MS / 1000 + "s");
            final List<String> packages = run.packages;
            final String reason = run.reason;
            main.postDelayed(() -> {
                if (!shutDown) {
                    queuedRetry = true;
                    nudge(packages, reason + " (retry)");
                }
            }, RETRY_DELAY_MS);
        }
        finish(run, "not acknowledged");
    }

    /** Ends a run from any thread; the work happens on the main thread. */
    private void finish(final Run run, final String outcome) {
        main.post(() -> finishOnMain(run, outcome));
    }

    private void finishOnMain(Run run, String outcome) {
        if (run != current || run.done) {
            return; // a late event for a run that is already over
        }
        run.done = true;
        current = null;
        main.removeCallbacks(run.connectTimeout);
        main.removeCallbacks(run.ackTimeout);
        main.removeCallbacks(run.completionTimeout);
        unbind(run);
        Log.i(TAG, "nudge finished: " + outcome);
        if (!shutDown && rerunRequested) {
            rerunRequested = false;
            Log.i(TAG, "running once more for the nudge requested meanwhile");
            begin();
        }
    }

    private void unbind(Run run) {
        if (!run.bound) {
            return;
        }
        run.bound = false;
        try {
            context.unbindService(run);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "unbindService: " + e);
        }
    }

    // ----------------------------------------------------------------------------------

    /** Everything belonging to one nudge, so late callbacks from an old run are ignored. */
    private final class Run implements ServiceConnection {

        final List<String> packages;
        final String reason;
        final int attempt;

        boolean bound;
        boolean connected;
        boolean done;
        /** Set from binder threads by the callback, read on the main thread by the timeout. */
        volatile boolean acknowledged;

        final Runnable connectTimeout = () -> onConnectTimeout(this);
        final Runnable ackTimeout = () -> onAckTimeout(this);
        final Runnable completionTimeout =
                () -> finish(this, "timed out waiting for the agent; it carries on by itself");

        Run(List<String> packages, String reason, int attempt) {
            this.packages = packages;
            this.reason = reason;
            this.attempt = attempt;
        }

        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            if (this != current || done) {
                return;
            }
            connected = true;
            Log.i(TAG, "connected to agent");
            final IMdmApi api = IMdmApi.Stub.asInterface(binder);
            worker.post(() -> drive(this, api));
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            Log.w(TAG, "agent process went away");
            finish(this, "agent disconnected");
        }

        @Override
        public void onBindingDied(ComponentName name) {
            Log.w(TAG, "binding to agent died");
            finish(this, "binding died");
        }

        @Override
        public void onNullBinding(ComponentName name) {
            Log.e(TAG, "agent returned a null binder");
            finish(this, "null binding");
        }

        /**
         * Progress events from the agent (API 119+). They arrive on binder threads and are
         * declared oneway in the AIDL, so nothing here may block or throw. The unbind
         * happens on {@code onConfigUpdateComplete}: the agent removes blocklisted apps
         * during the app phase, which precedes that event; pending installs continue in the
         * agent afterwards and any later event lands harmlessly on a finished run.
         */
        final IMdmApiCallback.Stub callback = new IMdmApiCallback.Stub() {

            private void ack() {
                acknowledged = true;
            }

            @Override
            public void onConfigUpdateStart() {
                ack();
                Log.i(TAG, "agent: config update started");
            }

            @Override
            public void onConfigUpdateError(int type, String errorText) {
                ack();
                Log.e(TAG, "agent: config update failed (" + errorType(type) + "): " + errorText);
                finish(Run.this, "agent reported a " + errorType(type) + " error");
            }

            @Override
            public void onConfigLoaded() {
                ack();
                Log.i(TAG, "agent: configuration loaded");
            }

            @Override
            public void onPoliciesUpdated() {
                ack();
                Log.i(TAG, "agent: policies applied");
            }

            @Override
            public void onFileDownloading(String path) {
                ack();
                Log.d(TAG, "agent: downloading file " + path);
            }

            @Override
            public void onDownloadProgress(int progress, long total, long current) {
                // Far too chatty to log.
            }

            @Override
            public void onFileError(int type, String path) {
                ack();
                Log.w(TAG, "agent: file " + (type == 1 ? "download" : "install") + " error: " + path);
            }

            @Override
            public void onAppUpdateStart() {
                ack();
                Log.i(TAG, "agent: app phase started");
            }

            @Override
            public void onAppRemoving(String pkg, String appName) {
                ack();
                Log.i(TAG, "agent: removing " + pkg + " (" + appName + ")");
            }

            @Override
            public void onAppDownloading(String pkg, String appName) {
                ack();
                Log.i(TAG, "agent: downloading " + pkg + " (" + appName + ")");
            }

            @Override
            public void onAppInstalling(String pkg, String appName) {
                ack();
                Log.i(TAG, "agent: installing " + pkg + " (" + appName + ")");
            }

            @Override
            public void onAppError(int type, String pkg) {
                ack();
                Log.w(TAG, "agent: app " + (type == 1 ? "download" : "install") + " error: " + pkg);
            }

            @Override
            public void onAppInstallComplete(String pkg) {
                ack();
                Log.i(TAG, "agent: installed " + pkg);
            }

            @Override
            public void onConfigUpdateComplete() {
                ack();
                Log.i(TAG, "agent: config update complete");
                finish(Run.this, "config update complete");
            }

            @Override
            public void onAllAppInstallComplete() {
                ack();
                Log.i(TAG, "agent: all app installs complete");
            }

            private String errorType(int type) {
                switch (type) {
                    case 1:
                        return "server";
                    case 2:
                        return "network";
                    default:
                        return "type " + type;
                }
            }
        };
    }
}
