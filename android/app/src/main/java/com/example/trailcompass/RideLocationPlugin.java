package com.example.trailcompass;

import android.content.Intent;
import android.location.Location;
import android.location.LocationManager;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The phone's position from the rider's chosen source (LocationHub), and
 * ride recording (RideRecorderService). The web view asks for location
 * permission first, through @capacitor/geolocation.
 *
 * Events: "fix" for each position, "recording" when a ride's state or
 * distance changes (also from the notification's buttons).
 */
@CapacitorPlugin(name = "RideLocation")
public class RideLocationPlugin extends Plugin {

    private static RideLocationPlugin instance;
    private boolean watching;
    private final LocationHub.Listener forward = (location, satellites) -> notifyListeners("fix", toJson(location, satellites));

    @Override
    public void load() {
        instance = this;
    }

    static void dispatchRecording(JSObject state) {
        RideLocationPlugin plugin = instance;
        if (plugin != null) plugin.notifyListeners("recording", state);
    }

    @PluginMethod
    public void watch(PluginCall call) {
        LocationHub.setSource(getContext(), call.getString("source", LocationHub.ASSISTED));
        try {
            LocationHub.addListener(getContext(), forward);
            watching = true;
            call.resolve();
        } catch (SecurityException e) {
            call.reject("Location permission denied", "DENIED");
        }
    }

    @PluginMethod
    public void clearWatch(PluginCall call) {
        watching = false;
        LocationHub.removeListener(forward);
        call.resolve();
    }

    @PluginMethod
    public void setSource(PluginCall call) {
        LocationHub.setSource(getContext(), call.getString("source", LocationHub.ASSISTED));
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject out = new JSObject();
        out.put("source", LocationHub.getSource());
        out.put("gpsEnabled", LocationHub.isEnabled(getContext(), LocationManager.GPS_PROVIDER));
        out.put("networkEnabled", LocationHub.isEnabled(getContext(), LocationManager.NETWORK_PROVIDER));
        out.put("satellites", LocationHub.getSatellites());
        call.resolve(out);
    }

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        try {
            getActivity().startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("Couldn't open location settings");
        }
    }

    @PluginMethod
    public void startRecording(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty() || id.contains("/")) {
            call.reject("A ride id is needed");
            return;
        }
        if (!LocationHub.hasPermission(getContext())) {
            call.reject("Location permission denied", "DENIED");
            return;
        }
        try {
            RideRecorderService.start(getContext(), id);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("Couldn't start recording: " + e.getMessage());
        }
    }

    @PluginMethod
    public void pauseRecording(PluginCall call) {
        command(call, RideRecorderService.ACTION_PAUSE);
    }

    @PluginMethod
    public void resumeRecording(PluginCall call) {
        command(call, RideRecorderService.ACTION_RESUME);
    }

    @PluginMethod
    public void finishRecording(PluginCall call) {
        command(call, RideRecorderService.ACTION_FINISH);
    }

    /** The current ride, or the last finished one not yet cleared; {} when none. */
    @PluginMethod
    public void recording(PluginCall call) {
        call.resolve(RideRecorderService.snapshot(getContext()));
    }

    /** After the web view has saved a finished ride. */
    @PluginMethod
    public void clearRecording(PluginCall call) {
        RideRecorderService.clear(getContext());
        call.resolve();
    }

    private void command(PluginCall call, String action) {
        try {
            RideRecorderService.command(getContext(), action);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("Couldn't change the recording: " + e.getMessage());
        }
    }

    // In the background with no ride recording, the app doesn't need the GPS.
    @Override
    protected void handleOnPause() {
        if (watching && !RideRecorderService.isRecording(getContext())) LocationHub.removeListener(forward);
    }

    @Override
    protected void handleOnResume() {
        if (!watching) return;
        try {
            LocationHub.addListener(getContext(), forward);
        } catch (SecurityException ignored) {
            // Permission withdrawn while away; watch() reports it next time.
        }
    }

    private static JSObject toJson(Location location, int satellites) {
        JSObject fix = new JSObject();
        fix.put("latitude", location.getLatitude());
        fix.put("longitude", location.getLongitude());
        if (location.hasAccuracy()) fix.put("accuracy", (double) location.getAccuracy());
        if (location.hasAltitude()) fix.put("altitude", location.getAltitude());
        if (location.hasSpeed()) fix.put("speed", (double) location.getSpeed());
        if (location.hasBearing()) fix.put("bearing", (double) location.getBearing());
        fix.put("time", location.getTime());
        fix.put("provider", location.getProvider());
        fix.put("satellites", satellites);
        return fix;
    }
}
