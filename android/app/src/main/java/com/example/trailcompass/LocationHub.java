package com.example.trailcompass;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import androidx.core.content.ContextCompat;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * The phone's position for the whole app, from the source the rider picks
 * in settings:
 *
 * - gps: satellites only. Works with no mobile data and without Google's
 *   location services; the first fix after a long break can take a minute.
 * - assisted: satellites plus Wi-Fi and mobile networks. A quicker first
 *   fix and better in towns; uses a little data.
 * - saver: networks only. About 100 m, light on the battery; needs data.
 *
 * RideLocationPlugin passes fixes to the web view and RideRecorderService
 * records them. Updates run while anyone listens. Call from the main thread.
 */
final class LocationHub {

    interface Listener {
        void onFix(Location location, int satellites);
    }

    static final String GPS = "gps";
    static final String ASSISTED = "assisted";
    static final String SAVER = "saver";

    private static final long GPS_INTERVAL_MS = 1_000;
    private static final long SAVER_INTERVAL_MS = 5_000;
    /** While satellites give fixes, a network fix this soon after is ignored. */
    private static final long GPS_PREFERRED_MS = 10_000;

    private static final Set<Listener> listeners = new CopyOnWriteArraySet<>();
    private static String source = ASSISTED;
    private static LocationManager manager;
    private static boolean requesting;
    private static long lastGpsFixAt;
    private static int satellites;
    private static GnssStatus.Callback gnssCallback;

    private static final LocationListener updates = new LocationListener() {
        @Override
        public void onLocationChanged(Location location) {
            deliver(location);
        }

        // Abstract before Android 11: these must be overridden.
        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {}

        @Override
        public void onProviderEnabled(String provider) {}

        @Override
        public void onProviderDisabled(String provider) {}
    };

    private LocationHub() {}

    static boolean hasPermission(Context context) {
        return (
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED
        );
    }

    static synchronized String getSource() {
        return source;
    }

    static int getSatellites() {
        return satellites;
    }

    /** Whether a provider is switched on in the phone's settings. */
    static boolean isEnabled(Context context, String provider) {
        LocationManager lm = locationManager(context);
        try {
            return lm != null && lm.getAllProviders().contains(provider) && lm.isProviderEnabled(provider);
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** @throws SecurityException without location permission. */
    static synchronized void addListener(Context context, Listener listener) {
        if (!hasPermission(context)) throw new SecurityException("Location permission denied");
        listeners.add(listener);
        if (!requesting) start(context);
    }

    static synchronized void removeListener(Listener listener) {
        listeners.remove(listener);
        if (listeners.isEmpty()) stop();
    }

    static synchronized void setSource(Context context, String next) {
        String picked = GPS.equals(next) || SAVER.equals(next) ? next : ASSISTED;
        if (picked.equals(source)) return;
        source = picked;
        if (requesting) {
            stop();
            start(context);
        }
    }

    private static LocationManager locationManager(Context context) {
        if (manager == null) manager = (LocationManager) context.getApplicationContext().getSystemService(Context.LOCATION_SERVICE);
        return manager;
    }

    private static void start(Context context) {
        LocationManager lm = locationManager(context);
        if (lm == null || !hasPermission(context)) return;
        Looper looper = Looper.getMainLooper();
        boolean gps = !SAVER.equals(source);
        boolean network = !GPS.equals(source);
        try {
            if (gps && lm.getAllProviders().contains(LocationManager.GPS_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, GPS_INTERVAL_MS, 0, updates, looper);
            }
            if (network && lm.getAllProviders().contains(LocationManager.NETWORK_PROVIDER)) {
                long interval = SAVER.equals(source) ? SAVER_INTERVAL_MS : GPS_INTERVAL_MS;
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, interval, 0, updates, looper);
            }
            requesting = true;
            watchSatellites(lm);
            sendLastKnown(lm, gps, network);
        } catch (SecurityException e) {
            requesting = false;
        }
    }

    private static void stop() {
        if (manager != null) {
            manager.removeUpdates(updates);
            if (gnssCallback != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                manager.unregisterGnssStatusCallback(gnssCallback);
            }
        }
        gnssCallback = null;
        satellites = 0;
        requesting = false;
    }

    /** How many satellites the last fix used, for settings and the GPS chip. */
    private static void watchSatellites(LocationManager lm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N || SAVER.equals(source)) return;
        gnssCallback = new GnssStatus.Callback() {
            @Override
            public void onSatelliteStatusChanged(GnssStatus status) {
                int used = 0;
                for (int i = 0; i < status.getSatelliteCount(); i++) {
                    if (status.usedInFix(i)) used++;
                }
                satellites = used;
            }
        };
        try {
            lm.registerGnssStatusCallback(gnssCallback, new Handler(Looper.getMainLooper()));
        } catch (SecurityException e) {
            gnssCallback = null;
        }
    }

    /** A recent fix the phone already has, so the map isn't blank while the first one comes. */
    private static void sendLastKnown(LocationManager lm, boolean gps, boolean network) {
        Location best = null;
        for (String provider : new String[] { LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
            if ((provider.equals(LocationManager.GPS_PROVIDER) && !gps) || (provider.equals(LocationManager.NETWORK_PROVIDER) && !network)) {
                continue;
            }
            try {
                Location last = lm.getLastKnownLocation(provider);
                if (last != null && (best == null || last.getTime() > best.getTime())) best = last;
            } catch (SecurityException | IllegalArgumentException ignored) {
                // Provider missing on this phone.
            }
        }
        if (best != null && System.currentTimeMillis() - best.getTime() < 120_000) deliver(best);
    }

    private static void deliver(Location location) {
        if (LocationManager.GPS_PROVIDER.equals(location.getProvider())) {
            lastGpsFixAt = SystemClock.elapsedRealtime();
        } else if (ASSISTED.equals(source) && SystemClock.elapsedRealtime() - lastGpsFixAt < GPS_PREFERRED_MS) {
            return;
        }
        for (Listener listener : listeners) listener.onFix(location, satellites);
    }
}
