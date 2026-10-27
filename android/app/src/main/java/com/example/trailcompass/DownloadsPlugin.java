package com.example.trailcompass;

import android.Manifest;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.lang.ref.WeakReference;

/**
 * Route planning in the background (DownloadService and its notification)
 * and the phone's network type, for the "Wi-Fi only" download setting.
 * The JS side is src/services/downloads-plugin.ts.
 */
@CapacitorPlugin(
    name = "Downloads",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class DownloadsPlugin extends Plugin {

    /** For DownloadService, which receives the notification's buttons. */
    private static WeakReference<DownloadsPlugin> current = new WeakReference<>(null);

    private ConnectivityManager.NetworkCallback networkCallback;
    private String lastNetwork;

    @Override
    public void load() {
        current = new WeakReference<>(this);
        DownloadNotifications.createChannels(getContext());
        watchNetwork();
    }

    @Override
    protected void handleOnDestroy() {
        if (current.get() == this) current = new WeakReference<>(null);
        unwatchNetwork();
        // The web view doing the planning is gone, so the notification goes too.
        DownloadService.stop(getContext());
    }

    /** A Pause, Resume or Stop tap, for the JS "action" listener. */
    static void dispatchAction(String action) {
        DownloadsPlugin plugin = current.get();
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("action", action);
        plugin.notifyListeners("action", data);
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsAnswered");
            return;
        }
        resolveNotifications(call);
    }

    @PermissionCallback
    private void notificationsAnswered(PluginCall call) {
        resolveNotifications(call);
    }

    private void resolveNotifications(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        call.resolve(result);
    }

    @PluginMethod
    public void startService(PluginCall call) {
        try {
            DownloadService.start(getContext(), DownloadNotifications.Content.from(call));
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("Couldn't start the background service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        // Never brings back a notification the rider stopped.
        if (DownloadService.isActive()) {
            DownloadNotifications.showProgress(getContext(), DownloadNotifications.Content.from(call));
        }
        call.resolve();
    }

    @PluginMethod
    public void finish(PluginCall call) {
        DownloadService.stop(getContext());
        if (Boolean.TRUE.equals(call.getBoolean("notify", true))) {
            DownloadNotifications.showResult(
                getContext(),
                call.getString("title", "Route planning finished"),
                call.getString("text", ""),
                Boolean.TRUE.equals(call.getBoolean("ok", true))
            );
        }
        call.resolve();
    }

    @PluginMethod
    public void stopService(PluginCall call) {
        DownloadService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getNetwork(PluginCall call) {
        JSObject result = new JSObject();
        result.put("type", networkType());
        call.resolve(result);
    }

    private void watchNetwork() {
        ConnectivityManager manager = getContext().getSystemService(ConnectivityManager.class);
        if (manager == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                reportNetwork();
            }

            @Override
            public void onLost(@NonNull Network network) {
                reportNetwork();
            }

            @Override
            public void onCapabilitiesChanged(@NonNull Network network, @NonNull NetworkCapabilities capabilities) {
                reportNetwork();
            }
        };
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                manager.registerDefaultNetworkCallback(networkCallback);
            } else {
                NetworkRequest request = new NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build();
                manager.registerNetworkCallback(request, networkCallback);
            }
        } catch (RuntimeException e) {
            // No callback: JS keeps the type it read with getNetwork().
            networkCallback = null;
        }
    }

    private void unwatchNetwork() {
        ConnectivityManager manager = getContext().getSystemService(ConnectivityManager.class);
        if (manager == null || networkCallback == null) return;
        try {
            manager.unregisterNetworkCallback(networkCallback);
        } catch (RuntimeException ignored) {
            // Already unregistered.
        }
        networkCallback = null;
    }

    private synchronized void reportNetwork() {
        String type = networkType();
        if (type.equals(lastNetwork)) return;
        lastNetwork = type;
        JSObject data = new JSObject();
        data.put("type", type);
        notifyListeners("network", data);
    }

    /** wifi (or ethernet), cellular, other, or none. */
    private String networkType() {
        Context context = getContext();
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        if (manager == null) return "unknown";
        Network network = manager.getActiveNetwork();
        if (network == null) return "none";
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
        if (capabilities == null) return "none";
        // From Android 9 a VPN also reports the transport underneath it.
        if (
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        ) {
            return "wifi";
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "cellular";
        return "other";
    }
}
