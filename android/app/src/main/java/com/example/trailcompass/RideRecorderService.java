package com.example.trailcompass;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.Locale;

/**
 * Records a ride. A foreground service keeps the GPS running with the
 * screen off or the app closed, and every fix is appended to
 * `map-packages/rides/<id>.csv`, which the web view reads when the ride
 * ends (services/ride-log.service.ts):
 *
 *   time,lat,lon,accuracy,altitude,speed,bearing,satellites
 *   #pause,time   #resume,time   #end,time
 *
 * The state lives in SharedPreferences, so the app can pick a ride up
 * after a restart. The distance shown in the notification follows the
 * same rule as ride-track.ts.
 */
public class RideRecorderService extends Service implements LocationHub.Listener {

    static final String ACTION_START = "com.example.trailcompass.ride.START";
    static final String ACTION_PAUSE = "com.example.trailcompass.ride.PAUSE";
    static final String ACTION_RESUME = "com.example.trailcompass.ride.RESUME";
    static final String ACTION_FINISH = "com.example.trailcompass.ride.FINISH";

    static final String RECORDING = "recording";
    static final String PAUSED = "paused";
    static final String FINISHED = "finished";

    private static final String PREFS = "trailcompass-ride";
    private static final String CHANNEL = "ride-recording";
    private static final int NOTIFICATION_ID = 4201;
    /** Fixes less precise than this don't count towards the distance. */
    private static final float MAX_ACCURACY_M = 30;
    /** Smaller moves are GPS drift while standing still. */
    private static final float MIN_STEP_M = 5;
    private static final long UPDATE_EVERY_MS = 5_000;

    private BufferedWriter writer;
    private Location lastKept;
    private long lastUpdate;
    private boolean listening;

    /** Starts a new ride, replacing any finished one not yet collected. */
    static void start(Context context, String id) {
        prefs(context)
            .edit()
            .clear()
            .putString("id", id)
            .putString("state", RECORDING)
            .putLong("startedAt", System.currentTimeMillis())
            .apply();
        ContextCompat.startForegroundService(context, new Intent(context, RideRecorderService.class).setAction(ACTION_START));
    }

    /** Pause, resume or finish; the app is on screen when these are called. */
    static void command(Context context, String action) {
        String state = prefs(context).getString("state", null);
        if (state == null || FINISHED.equals(state)) return;
        ContextCompat.startForegroundService(context, new Intent(context, RideRecorderService.class).setAction(action));
    }

    static boolean isRecording(Context context) {
        return RECORDING.equals(prefs(context).getString("state", null));
    }

    /** Forgets a finished ride once the app has saved it. */
    static void clear(Context context) {
        if (FINISHED.equals(prefs(context).getString("state", null))) prefs(context).edit().clear().apply();
    }

    /** The current or last finished ride, or an empty object. */
    static JSObject snapshot(Context context) {
        SharedPreferences p = prefs(context);
        JSObject out = new JSObject();
        String id = p.getString("id", null);
        if (id == null) return out;
        String state = p.getString("state", PAUSED);
        out.put("id", id);
        out.put("state", state);
        out.put("startedAt", p.getLong("startedAt", 0));
        if (p.contains("endedAt")) out.put("endedAt", p.getLong("endedAt", 0));
        out.put("activeMs", activeMs(p));
        out.put("distanceMeters", (double) p.getFloat("distance", 0));
        out.put("points", p.getInt("points", 0));
        out.put("path", "map-packages/rides/" + id + ".csv");
        return out;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A null intent: Android restarted the service after closing the app.
        String action = intent == null ? null : intent.getAction();
        SharedPreferences p = prefs(this);
        String state = p.getString("state", null);
        if (!goForeground()) {
            // Not allowed now (restarted in the background): the app resumes it.
            if (RECORDING.equals(state)) pauseState(p);
            RideLocationPlugin.dispatchRecording(snapshot(this));
            stopSelf();
            return START_NOT_STICKY;
        }
        if (state == null || FINISHED.equals(state)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_FINISH.equals(action)) {
            finish();
            return START_NOT_STICKY;
        }
        if (ACTION_PAUSE.equals(action)) {
            if (RECORDING.equals(state)) pause();
        } else if (ACTION_RESUME.equals(action) || RECORDING.equals(state)) {
            record(ACTION_RESUME.equals(action) && PAUSED.equals(state));
        }
        showNotification();
        RideLocationPlugin.dispatchRecording(snapshot(this));
        return START_STICKY;
    }

    @Override
    public void onFix(Location location, int satellites) {
        if (writer == null) return;
        SharedPreferences p = prefs(this);
        try {
            writer.write(
                String.format(
                    Locale.US,
                    "%d,%.7f,%.7f,%s,%s,%s,%s,%d\n",
                    location.getTime(),
                    location.getLatitude(),
                    location.getLongitude(),
                    location.hasAccuracy() ? String.format(Locale.US, "%.1f", location.getAccuracy()) : "",
                    location.hasAltitude() ? String.format(Locale.US, "%.1f", location.getAltitude()) : "",
                    location.hasSpeed() ? String.format(Locale.US, "%.2f", location.getSpeed()) : "",
                    location.hasBearing() ? String.format(Locale.US, "%.0f", location.getBearing()) : "",
                    satellites
                )
            );
            writer.flush();
        } catch (IOException e) {
            return;
        }
        float distance = p.getFloat("distance", 0);
        float accuracy = location.hasAccuracy() ? location.getAccuracy() : 0;
        if (accuracy <= MAX_ACCURACY_M) {
            if (lastKept == null) {
                lastKept = location;
            } else {
                float step = lastKept.distanceTo(location);
                if (step >= Math.max(MIN_STEP_M, accuracy)) {
                    distance += step;
                    lastKept = location;
                }
            }
        }
        p.edit().putFloat("distance", distance).putInt("points", p.getInt("points", 0) + 1).apply();
        long now = SystemClock.elapsedRealtime();
        if (now - lastUpdate >= UPDATE_EVERY_MS) {
            lastUpdate = now;
            showNotification();
            RideLocationPlugin.dispatchRecording(snapshot(this));
        }
    }

    private void record(boolean resumed) {
        SharedPreferences p = prefs(this);
        SharedPreferences.Editor edit = p.edit().putString("state", RECORDING);
        if (p.contains("pausedAt")) {
            edit.putLong("pausedMs", p.getLong("pausedMs", 0) + System.currentTimeMillis() - p.getLong("pausedAt", 0)).remove("pausedAt");
        }
        edit.apply();
        if (listening) return;
        openWriter();
        if (resumed) mark("#resume");
        // Distance doesn't bridge a pause.
        lastKept = null;
        try {
            LocationHub.addListener(this, this);
            listening = true;
        } catch (SecurityException e) {
            pause();
        }
    }

    private void pause() {
        stopListening();
        mark("#pause");
        closeWriter();
        pauseState(prefs(this));
    }

    private void finish() {
        stopListening();
        if (writer == null) openWriter();
        mark("#end");
        closeWriter();
        SharedPreferences p = prefs(this);
        if (p.contains("pausedAt")) {
            p.edit().putLong("pausedMs", p.getLong("pausedMs", 0) + System.currentTimeMillis() - p.getLong("pausedAt", 0)).remove("pausedAt").apply();
        }
        p.edit().putString("state", FINISHED).putLong("endedAt", System.currentTimeMillis()).apply();
        RideLocationPlugin.dispatchRecording(snapshot(this));
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private static void pauseState(SharedPreferences p) {
        SharedPreferences.Editor edit = p.edit().putString("state", PAUSED);
        if (!p.contains("pausedAt")) edit.putLong("pausedAt", System.currentTimeMillis());
        edit.apply();
    }

    private void stopListening() {
        if (!listening) return;
        LocationHub.removeListener(this);
        listening = false;
    }

    private void openWriter() {
        if (writer != null) return;
        String id = prefs(this).getString("id", "ride");
        File dir = new File(getFilesDir(), "map-packages/rides");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        try {
            writer = new BufferedWriter(new FileWriter(new File(dir, id + ".csv"), true));
        } catch (IOException e) {
            writer = null;
        }
    }

    private void closeWriter() {
        if (writer == null) return;
        try {
            writer.close();
        } catch (IOException ignored) {
            // Already written line by line.
        }
        writer = null;
    }

    private void mark(String what) {
        if (writer == null) return;
        try {
            writer.write(what + "," + System.currentTimeMillis() + "\n");
            writer.flush();
        } catch (IOException ignored) {
            // The ride still has its fixes.
        }
    }

    /** Time recording, pauses left out. */
    private static long activeMs(SharedPreferences p) {
        long end = p.contains("endedAt") ? p.getLong("endedAt", 0) : p.contains("pausedAt") ? p.getLong("pausedAt", 0) : System.currentTimeMillis();
        return Math.max(0, end - p.getLong("startedAt", end) - p.getLong("pausedMs", 0));
    }

    private boolean goForeground() {
        createChannel();
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification(),
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0
            );
            return true;
        } catch (RuntimeException e) {
            // Android 12+: no foreground service from the background; 14+: none without location permission.
            return false;
        }
    }

    private void showNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, notification());
    }

    private Notification notification() {
        SharedPreferences p = prefs(this);
        boolean recording = RECORDING.equals(p.getString("state", null));
        float km = p.getFloat("distance", 0) / 1000f;
        long active = activeMs(p);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(recording ? android.R.drawable.ic_menu_mylocation : android.R.drawable.ic_media_pause)
            .setContentTitle(recording ? "Recording ride" : "Ride paused")
            .setContentText(String.format(Locale.US, "%.1f km", km))
            .setContentIntent(openApp())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        if (recording) {
            // A clock that ticks by itself: started `active` ago.
            builder.setUsesChronometer(true).setWhen(System.currentTimeMillis() - active).setShowWhen(true);
            builder.addAction(android.R.drawable.ic_media_pause, "Pause", action(ACTION_PAUSE));
        } else {
            builder.setShowWhen(false).setSubText(formatDuration(active));
            builder.addAction(android.R.drawable.ic_media_play, "Resume", action(ACTION_RESUME));
        }
        builder.addAction(android.R.drawable.ic_menu_save, "Finish", action(ACTION_FINISH));
        return builder.build();
    }

    private static String formatDuration(long ms) {
        long minutes = ms / 60_000;
        return minutes >= 60 ? String.format(Locale.US, "%dh %02dm", minutes / 60, minutes % 60) : minutes + " min";
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Ride recording", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Distance and time while a ride is recorded");
        manager.createNotificationChannel(channel);
    }

    private PendingIntent openApp() {
        Intent intent = new Intent(this, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private PendingIntent action(String action) {
        Intent intent = new Intent(this, RideRecorderService.class).setAction(action);
        return PendingIntent.getService(this, action.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public void onDestroy() {
        stopListening();
        closeWriter();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
