package com.getshmira.companion;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
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
 * The binding is held for the lifetime of the service, not per request. This app is the
 * agent's only plugin client, and a bind with BIND_AUTO_CREATE is what keeps the agent's
 * PluginApiService alive: the agent runs a forced update with that service as its Context
 * and registers the receiver that carries its install/remove chain on it, so unbinding
 * while an update is in flight tears that receiver down and strands the update with the
 * user restrictions it released at the start. So: bind once, keep the proxy, rebind only
 * if the binding dies, and unbind only in {@link #shutdown}.
 * <p>
 * A "nudge" is one request: read the API version, post a line to the Headwind device log,
 * ask for a forced configuration update, and wait for it to complete (or time out, which
 * is bookkeeping only; the agent carries on). Only one nudge is in flight at a time; a
 * nudge requested meanwhile makes the client run exactly once more when the current one
 * completes. A nudge is never sent without a validated network: the agent releases its
 * user restrictions before fetching and only re-applies them after a successful fetch, so
 * an offline forced update would leave the phone briefly unrestricted for nothing. The
 * request waits and fires when a network comes back.
 * <p>
 * Threading: {@link #nudge} and {@link #shutdown} must be called on the main thread and
 * every completion is posted back to it, so the queue and the current run need no locks.
 * The binder calls run on a private worker thread: the agent's legacy
 * {@code forceConfigUpdate()} does its work on the caller's binder thread, and a blocked
 * main thread here would delay the very PACKAGE_ADDED broadcasts we exist for.
 */
final class AgentClient {

    private static final String TAG = Companion.TAG;

    static final String AGENT_PACKAGE = "com.hmdm.launcher";
    static final String AGENT_ACTION = "com.hmdm.action.Connect";

    /**
     * {@code Const.LOG_*} in the agent's source ({@code com.hmdm.launcher.Const}):
     * 1 = error, 2 = warn, 3 = info, 4 = debug, 5 = verbose.
     */
    static final int AGENT_LOG_WARN = 2;
    static final int AGENT_LOG_INFO = 3;

    /** Agent API version that introduced {@code forceConfigUpdate()} (library 1.1.5). */
    static final int VERSION_FORCE_UPDATE = 115;

    /** Agent API version that introduced {@code forceConfigUpdateWithCallback()} (library 1.1.9). */
    static final int VERSION_CALLBACK = 119;

    /** Give up on a bind if the agent has not connected in this long. */
    static final long CONNECT_TIMEOUT_MS = 30_000L;

    /** Stop waiting for completion after this long. Bookkeeping only: the agent carries on. */
    static final long COMPLETION_TIMEOUT_MS = 5L * 60L * 1000L;

    /** Legacy (no-callback) path: consider the run over this long after the request. */
    static final long LEGACY_DONE_DELAY_MS = 5_000L;

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final HandlerThread workerThread;
    private final Handler worker;

    // Main-thread state.
    private final LinkedHashSet<String> queuedPackages = new LinkedHashSet<>();
    private final LinkedHashSet<String> queuedReasons = new LinkedHashSet<>();
    private boolean rerunRequested;
    private Run current;
    private volatile boolean shutDown;

    // The persistent binding (main thread), and the proxy the worker uses.
    private final Connection connection = new Connection();
    private boolean bound;
    private volatile IMdmApi api;
    private final Runnable connectTimeout = this::onConnectTimeout;

    // Waiting for a validated network before sending a queued nudge.
    private ConnectivityManager.NetworkCallback networkCallback;

    /** A one-line health note (e.g. "background-restricted") sent to the server log once. */
    private volatile String statusNote;
    private volatile boolean statusNoteSent;

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

    /** Something worth telling the operator once, through the Headwind device log. */
    void setStatusNote(String note) {
        statusNote = note;
        statusNoteSent = false;
    }

    /** Releases the agent binding and the worker thread. Called from WatchService.onDestroy. */
    void shutdown() {
        shutDown = true;
        rerunRequested = false;
        queuedPackages.clear();
        queuedReasons.clear();
        main.removeCallbacksAndMessages(null);
        stopWaitingForNetwork();
        Run run = current;
        current = null;
        if (run != null) {
            run.done = true;
        }
        unbind();
        // quit(), not quitSafely(): a drive() still queued must not run against a dead client.
        workerThread.quit();
    }

    // ----------------------------------------------------------------------------------
    // One nudge, start to finish (main thread unless stated).

    private void begin() {
        if (shutDown || current != null || (queuedPackages.isEmpty() && queuedReasons.isEmpty())) {
            return;
        }
        if (!hasValidatedNetwork()) {
            Log.i(TAG, "no validated network; holding the nudge until one comes back");
            waitForNetwork();
            return;
        }
        Run run = new Run(new ArrayList<>(queuedPackages), String.join(", ", queuedReasons));
        queuedPackages.clear();
        queuedReasons.clear();
        current = run;
        main.postDelayed(run.completionTimeout, COMPLETION_TIMEOUT_MS);

        IMdmApi live = api;
        if (live != null) {
            run.driven = true;
            worker.post(() -> drive(run, live));
        } else {
            ensureBound();   // drive() runs from onServiceConnected
        }
    }

    private void ensureBound() {
        if (bound) {
            return;
        }
        Intent intent = new Intent(AGENT_ACTION).setPackage(AGENT_PACKAGE);
        boolean accepted;
        try {
            accepted = context.bindService(intent, connection, Context.BIND_AUTO_CREATE);
        } catch (RuntimeException e) {
            // SecurityException if a future agent guards its service, or an OEM oddity.
            Log.e(TAG, "bindService threw: " + e, e);
            accepted = false;
        }
        if (!accepted) {
            // Even a false return holds a connection record that unbindService must release.
            try {
                context.unbindService(connection);
            } catch (IllegalArgumentException ignored) {
                // nothing was registered
            }
            Log.e(TAG, "cannot bind to the MDM agent (" + AGENT_PACKAGE
                    + " missing or its service not exported); will retry on the next nudge");
            if (current != null) {
                finish(current, "agent not reachable");
            }
            return;
        }
        bound = true;
        Log.i(TAG, "binding to agent");
        main.postDelayed(connectTimeout, CONNECT_TIMEOUT_MS);
    }

    private void unbind() {
        if (!bound) {
            return;
        }
        bound = false;
        api = null;
        main.removeCallbacks(connectTimeout);
        try {
            context.unbindService(connection);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "unbindService: " + e);
        }
    }

    private void onConnectTimeout() {
        if (!bound || api != null) {
            return;
        }
        Log.w(TAG, "agent accepted the bind but never connected within "
                + CONNECT_TIMEOUT_MS / 1000 + "s; will bind again on the next nudge");
        unbind();
        if (current != null) {
            finish(current, "agent did not connect");
        }
    }

    /** Worker thread: the actual binder calls for one run. */
    private void drive(Run run, IMdmApi api) {
        if (shutDown || run.done) {
            return;
        }
        try {
            int version = api.getVersion();
            Log.i(TAG, "agent API version " + version);
            if (version < VERSION_FORCE_UPDATE) {
                Log.w(TAG, "agent API " + version + " cannot force a config update (needs >= "
                        + VERSION_FORCE_UPDATE + "); nothing to do");
                finish(run, "unsupported agent version " + version);
                return;
            }
            String note = statusNote;
            if (note != null && !statusNoteSent) {
                api.log(System.currentTimeMillis(), AGENT_LOG_WARN, context.getPackageName(), note);
                statusNoteSent = true;
            }
            if (!run.packages.isEmpty()) {
                // Shows up in the Headwind server's device log under this package id.
                String message = "install detected: " + String.join(", ", run.packages)
                        + "; forcing config update";
                api.log(System.currentTimeMillis(), AGENT_LOG_INFO, context.getPackageName(), message);
            }
            if (shutDown || run.done) {
                return;
            }
            if (version >= VERSION_CALLBACK) {
                Log.i(TAG, "forceConfigUpdateWithCallback (" + run.reason + ")");
                api.forceConfigUpdateWithCallback(run.callback);
            } else {
                Log.i(TAG, "forceConfigUpdate, no callback on API " + version + " (" + run.reason + ")");
                api.forceConfigUpdate();
                main.postDelayed(() -> finish(run, "legacy update requested"), LEGACY_DONE_DELAY_MS);
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
        main.removeCallbacks(run.completionTimeout);
        Log.i(TAG, "nudge finished: " + outcome);
        if (shutDown) {
            return;
        }
        if (rerunRequested || !queuedPackages.isEmpty()) {
            rerunRequested = false;
            Log.i(TAG, "running once more for the nudge requested meanwhile");
            begin();
        }
    }

    /** Puts a run's packages back in the queue, e.g. after the agent hit a network error. */
    private void requeue(Run run, String why) {
        if (shutDown) {
            return;
        }
        queuedPackages.addAll(run.packages);
        queuedReasons.add(run.reason + " (" + why + ")");
    }

    // ----------------------------------------------------------------------------------
    // Network gate.

    private boolean hasValidatedNetwork() {
        ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
        if (cm == null) {
            return true; // cannot tell; do not hold the nudge forever
        }
        Network network = cm.getActiveNetwork();
        NetworkCapabilities caps = network == null ? null : cm.getNetworkCapabilities(network);
        return caps != null
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    private void waitForNetwork() {
        if (networkCallback != null) {
            return;
        }
        ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
        if (cm == null) {
            return;
        }
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                main.post(() -> {
                    stopWaitingForNetwork();
                    if (!shutDown) {
                        Log.i(TAG, "network is back; sending the held nudge");
                        begin();
                    }
                });
            }
        };
        NetworkRequest request = new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                .build();
        try {
            cm.registerNetworkCallback(request, networkCallback);
        } catch (RuntimeException e) {
            // Too many callbacks registered, or a security oddity: fall back to a plain retry.
            Log.w(TAG, "registerNetworkCallback failed: " + e + "; retrying in 60s");
            networkCallback = null;
            main.postDelayed(this::begin, 60_000L);
        }
    }

    private void stopWaitingForNetwork() {
        if (networkCallback == null) {
            return;
        }
        ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
        if (cm != null) {
            try {
                cm.unregisterNetworkCallback(networkCallback);
            } catch (RuntimeException ignored) {
                // already gone
            }
        }
        networkCallback = null;
    }

    // ----------------------------------------------------------------------------------

    /** The one, persistent connection to the agent's plugin service. */
    private final class Connection implements ServiceConnection {

        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            main.removeCallbacks(connectTimeout);
            IMdmApi live = IMdmApi.Stub.asInterface(binder);
            api = live;
            Log.i(TAG, "connected to agent");
            Run run = current;
            if (run != null && !run.done && !run.driven) {
                run.driven = true;
                worker.post(() -> drive(run, live));
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            // The agent's process died. The binding survives and Android reconnects when
            // the service comes back; anything in flight is lost.
            api = null;
            Log.w(TAG, "agent process went away; will reconnect");
            if (current != null) {
                finish(current, "agent disconnected");
            }
        }

        @Override
        public void onBindingDied(ComponentName name) {
            Log.w(TAG, "binding to agent died (agent updated or removed); rebinding on the next nudge");
            unbind();
            if (current != null) {
                finish(current, "binding died");
            }
        }

        @Override
        public void onNullBinding(ComponentName name) {
            Log.e(TAG, "agent returned a null binder");
            unbind();
            if (current != null) {
                finish(current, "null binding");
            }
        }
    }

    /** Everything belonging to one nudge, so late callbacks from an old run are ignored. */
    private final class Run {

        final List<String> packages;
        final String reason;

        /** Main thread: drive() has been posted for this run. */
        boolean driven;
        /** Set on the main thread, read on the worker: the run is over, do nothing more. */
        volatile boolean done;

        final Runnable completionTimeout =
                () -> finish(this, "timed out waiting for the agent; it carries on by itself");

        Run(List<String> packages, String reason) {
            this.packages = packages;
            this.reason = reason;
        }

        /**
         * Progress events from the agent (API 119+). They arrive on binder threads and are
         * declared oneway in the AIDL, so nothing here may block or throw. The run ends on
         * {@code onConfigUpdateComplete}; the binding stays.
         */
        final IMdmApiCallback.Stub callback = new IMdmApiCallback.Stub() {

            @Override
            public void onConfigUpdateStart() {
                Log.i(TAG, "agent: config update started");
            }

            @Override
            public void onConfigUpdateError(int type, String errorText) {
                Log.e(TAG, "agent: config update failed (" + errorType(type) + "): " + errorText);
                if (type == 2) {
                    // Network: the agent could not fetch. Keep the packages and go again when
                    // a validated network is back, rather than dropping the trigger.
                    main.post(() -> {
                        if (Run.this == current && !done) {
                            requeue(Run.this, "after network error");
                        }
                    });
                }
                finish(Run.this, "agent reported a " + errorType(type) + " error");
            }

            @Override
            public void onConfigLoaded() {
                Log.i(TAG, "agent: configuration loaded");
            }

            @Override
            public void onPoliciesUpdated() {
                Log.i(TAG, "agent: policies applied");
            }

            @Override
            public void onFileDownloading(String path) {
                Log.d(TAG, "agent: downloading file " + path);
            }

            @Override
            public void onDownloadProgress(int progress, long total, long current) {
                // Far too chatty to log.
            }

            @Override
            public void onFileError(int type, String path) {
                Log.w(TAG, "agent: file " + (type == 1 ? "download" : "install") + " error: " + path);
            }

            @Override
            public void onAppUpdateStart() {
                Log.i(TAG, "agent: app phase started");
            }

            @Override
            public void onAppRemoving(String pkg, String appName) {
                Log.i(TAG, "agent: removing " + pkg + " (" + appName + ")");
            }

            @Override
            public void onAppDownloading(String pkg, String appName) {
                Log.i(TAG, "agent: downloading " + pkg + " (" + appName + ")");
            }

            @Override
            public void onAppInstalling(String pkg, String appName) {
                Log.i(TAG, "agent: installing " + pkg + " (" + appName + ")");
            }

            @Override
            public void onAppError(int type, String pkg) {
                Log.w(TAG, "agent: app " + (type == 1 ? "download" : "install") + " error: " + pkg);
            }

            @Override
            public void onAppInstallComplete(String pkg) {
                Log.i(TAG, "agent: installed " + pkg);
            }

            @Override
            public void onConfigUpdateComplete() {
                Log.i(TAG, "agent: config update complete");
                finish(Run.this, "config update complete");
            }

            @Override
            public void onAllAppInstallComplete() {
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
