package com.getshmira.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;

/**
 * Fetches the phone's on-device policy from the Worker and keeps the last good answer.
 * <p>
 * The phone identifies itself by its WireGuard tunnel address, read off the VPN interface, and
 * the Worker answers with the rung's flags plus the guard's detection rules
 * ({@code /api/companion/policy}). Everything is cached in SharedPreferences so the guard has an
 * answer from the first event after a reboot, and refreshed on a timer and whenever the network
 * comes back. Until the first successful fetch, and whenever the tunnel address cannot be read,
 * the policy is BLOCK: an unknown phone must not be the one phone with the feed open.
 * <p>
 * Rules: the APK's built-in copy is used until the Worker serves a HIGHER rules_version, after
 * which the served copy is kept (and survives reboots) — so the operator can tune detection to a
 * new WhatsApp release by editing the Worker, without rebuilding the app.
 */
final class PolicyClient {

    private static final String TAG = Companion.TAG;

    static final String PREFS = "policy";
    static final String KEY_BLOCK_UPDATES = "whatsapp_block_updates";
    static final String KEY_KNOWN = "known_device";
    static final String KEY_FETCHED_AT = "fetched_at";
    static final String KEY_USER = "user";
    static final String KEY_RULES_JSON = "rules_json";
    static final String KEY_RULES_VERSION = "rules_version";

    /** Ask again this often while the service lives. */
    static final long REFRESH_MS = 60L * 60L * 1000L;
    /** And sooner after a failure. */
    static final long RETRY_MS = 5L * 60L * 1000L;

    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 15_000;
    private static final int MAX_BODY = 256 * 1024;

    private final Context context;
    private final SharedPreferences prefs;
    private final HandlerThread thread;
    private final Handler worker;
    private volatile boolean stopped;
    private ConnectivityManager.NetworkCallback networkCallback;

    PolicyClient(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.thread = new HandlerThread("ShmiraCompanion-policy");
        this.thread.start();
        this.worker = new Handler(this.thread.getLooper());
    }

    // ----------------------------------------------------------------------------------
    // What the guard reads. Cheap, any thread.

    /** Block WhatsApp's Updates tab and channels on this phone? Defaults to true until told otherwise. */
    static boolean blockWhatsappUpdates(Context context) {
        return context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_BLOCK_UPDATES, true);
    }

    /** The served rules if any were ever received, else null (the caller falls back to the APK's copy). */
    static String servedRulesJson(Context context) {
        return context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_RULES_JSON, null);
    }

    static int servedRulesVersion(Context context) {
        return context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getInt(KEY_RULES_VERSION, 0);
    }

    // ----------------------------------------------------------------------------------

    /**
     * Starts the refresh loop: one fetch now, then hourly (or every five minutes after a failure),
     * and one as soon as a validated network appears — the tunnel coming up after a reboot is
     * when the first answer is usually possible at all. (The guard learns of a changed answer
     * through the SharedPreferences it reads; nothing else needs telling.)
     */
    void start() {
        worker.post(this::loop);
        try {
            ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
            if (cm != null) {
                networkCallback = new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                        refreshSoon();
                    }
                };
                cm.registerNetworkCallback(new NetworkRequest.Builder()
                        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                        .build(), networkCallback);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "policy: cannot watch the network (" + e + "); the timer alone will refresh");
            networkCallback = null;
        }
    }

    /** A fetch as soon as possible (the network came back, the service restarted). */
    void refreshSoon() {
        worker.removeCallbacksAndMessages(null);
        worker.post(this::loop);
    }

    void shutdown() {
        stopped = true;
        worker.removeCallbacksAndMessages(null);
        if (networkCallback != null) {
            try {
                ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
                if (cm != null) {
                    cm.unregisterNetworkCallback(networkCallback);
                }
            } catch (RuntimeException ignored) {
                // never registered, or already gone
            }
            networkCallback = null;
        }
        thread.quitSafely();
    }

    private void loop() {
        if (stopped) {
            return;
        }
        boolean ok;
        try {
            ok = fetchOnce();
        } catch (RuntimeException e) {
            // Nothing in a fetch may take the service down.
            Log.e(TAG, "policy fetch threw: " + e, e);
            ok = false;
        }
        worker.postDelayed(this::loop, ok ? REFRESH_MS : RETRY_MS);
    }

    /** Worker thread. Returns true on a good answer. */
    private boolean fetchOnce() {
        String user = tunnelAddress();
        if (user == null) {
            // No tunnel address to identify with. The Worker would answer "unknown: block", which
            // is also what the cached default says, so do not overwrite a known phone's cached
            // policy with it; just try again later. The guard keeps enforcing the last answer.
            Log.w(TAG, "policy: no tunnel address on any interface; keeping the cached policy ("
                    + (prefs.getBoolean(KEY_BLOCK_UPDATES, true) ? "block" : "allow") + ")");
            return false;
        }
        String url = Companion.WORKER_URL + "/api/companion/policy?user=" + user;
        String body;
        try {
            body = get(url);
        } catch (IOException e) {
            Log.w(TAG, "policy fetch failed: " + e);
            return false;
        }
        JSONObject doc;
        try {
            doc = new JSONObject(body);
        } catch (JSONException e) {
            Log.w(TAG, "policy answer is not JSON: " + e);
            return false;
        }
        boolean known = doc.optBoolean("known_device", false);
        JSONObject wa = doc.optJSONObject("whatsapp");
        boolean block = wa == null || wa.optBoolean("block_updates", true);
        int version = doc.optInt("rules_version", 0);
        JSONObject rules = doc.optJSONObject("rules");

        boolean changed = false;
        SharedPreferences.Editor ed = prefs.edit();
        if (prefs.getBoolean(KEY_BLOCK_UPDATES, true) != block || !prefs.contains(KEY_BLOCK_UPDATES)) {
            ed.putBoolean(KEY_BLOCK_UPDATES, block);
            changed = true;
        }
        ed.putBoolean(KEY_KNOWN, known);
        ed.putString(KEY_USER, user);
        ed.putLong(KEY_FETCHED_AT, System.currentTimeMillis());
        if (rules != null && version > prefs.getInt(KEY_RULES_VERSION, 0)) {
            // Only a set that parses replaces the current one.
            String json = doc.toString();
            if (GuardRules.parse(json) != null) {
                ed.putString(KEY_RULES_JSON, json);
                ed.putInt(KEY_RULES_VERSION, version);
                changed = true;
                Log.i(TAG, "policy: guard rules updated to version " + version);
            }
        }
        ed.apply();
        Log.i(TAG, "policy for " + user + ": " + (known ? "known" : "UNKNOWN phone") + ", whatsapp updates "
                + (block ? "blocked" : "allowed") + ", rules v" + version);
        if (!known) {
            Log.w(TAG, "policy: this tunnel address is not on the Worker's books; enforcing the strictest policy");
        }
        if (changed) {
            Log.i(TAG, "policy changed; the guard picks it up from its preferences");
        }
        return true;
    }

    private static String get(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(CONNECT_TIMEOUT_MS);
            c.setReadTimeout(READ_TIMEOUT_MS);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "shmira-companion/" + BuildInfo.VERSION);
            c.setUseCaches(false);
            int code = c.getResponseCode();
            if (code != 200) {
                throw new IOException("HTTP " + code);
            }
            try (InputStream in = c.getInputStream();
                 BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                StringBuilder sb = new StringBuilder();
                char[] buf = new char[4096];
                int n;
                while ((n = r.read(buf)) > 0) {
                    sb.append(buf, 0, n);
                    if (sb.length() > MAX_BODY) {
                        throw new IOException("answer too large");
                    }
                }
                return sb.toString();
            }
        } finally {
            c.disconnect();
        }
    }

    // ----------------------------------------------------------------------------------
    // The phone's identity: its address on the WireGuard tunnel.

    /**
     * 10.66.0.x from the VPN (tunnel) interface, or null when no tunnel address is up. Only the
     * VPN network's addresses count, never Wi-Fi's: a Wi-Fi network numbered 10.66.0.0/24 by
     * whoever runs its router must not let a phone claim another phone's identity — and its
     * policy — while the tunnel is down.
     */
    String tunnelAddress() {
        String a = fromVpnLinkProperties();
        if (a == null) {
            a = fromTunInterfaces();
        }
        return a;
    }

    private static boolean isTunnelAddress(InetAddress addr) {
        if (!(addr instanceof Inet4Address)) {
            return false;
        }
        byte[] b = addr.getAddress();
        return b.length == 4 && (b[0] & 0xff) == Companion.TUNNEL_NET[0] && (b[1] & 0xff) == Companion.TUNNEL_NET[1]
                && (b[2] & 0xff) == Companion.TUNNEL_NET[2];
    }

    /** The VPN network's link addresses, via ConnectivityManager (needs ACCESS_NETWORK_STATE only). */
    private String fromVpnLinkProperties() {
        try {
            ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
            if (cm == null) {
                return null;
            }
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                    continue;
                }
                LinkProperties lp = cm.getLinkProperties(n);
                if (lp == null) {
                    continue;
                }
                for (LinkAddress la : lp.getLinkAddresses()) {
                    if (isTunnelAddress(la.getAddress())) {
                        return la.getAddress().getHostAddress();
                    }
                }
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot read the VPN link addresses: " + e);
        }
        return null;
    }

    /** Fallback: walk the interfaces, but only the tunnel ones (tun0 / wg0 on Android). */
    private static String fromTunInterfaces() {
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            if (ifs == null) {
                return null;
            }
            for (NetworkInterface nif : Collections.list(ifs)) {
                String name = nif.getName() == null ? "" : nif.getName();
                if (!(name.startsWith("tun") || name.startsWith("wg"))) {
                    continue;
                }
                List<InetAddress> addrs = Collections.list(nif.getInetAddresses());
                for (InetAddress a : addrs) {
                    if (isTunnelAddress(a)) {
                        return a.getHostAddress();
                    }
                }
            }
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "cannot enumerate interfaces: " + e);
        }
        return null;
    }
}
