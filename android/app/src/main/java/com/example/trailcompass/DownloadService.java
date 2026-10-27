package com.example.trailcompass;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps the app running while a route is planned in the background, with
 * a progress notification. The planning itself happens in the web view;
 * this service only stops Android from closing the app meanwhile and
 * passes the notification's Pause, Resume and Stop to DownloadsPlugin.
 */
public class DownloadService extends Service {

    static final String ACTION_START = "com.example.trailcompass.download.START";
    static final String ACTION_PAUSE = "com.example.trailcompass.download.PAUSE";
    static final String ACTION_RESUME = "com.example.trailcompass.download.RESUME";
    static final String ACTION_STOP = "com.example.trailcompass.download.STOP";

    /** Asked to start; the service has not called startForeground() yet. */
    private static boolean starting;
    /** In the foreground with its notification. */
    private static boolean running;
    /** stop() came before the service got going. */
    private static boolean stopWhenStarted;

    static synchronized void start(Context context, DownloadNotifications.Content content) {
        Intent intent = content.into(new Intent(context, DownloadService.class).setAction(ACTION_START));
        stopWhenStarted = false;
        starting = true;
        try {
            // Allowed only while the app is on screen (Android 12+).
            ContextCompat.startForegroundService(context, intent);
        } catch (RuntimeException e) {
            starting = false;
            throw e;
        }
    }

    static synchronized void stop(Context context) {
        if (starting) {
            // Once startForegroundService() is called, startForeground() must follow.
            stopWhenStarted = true;
        } else if (running) {
            // Inactive from now, so a late update() can't re-post the notification.
            running = false;
            context.stopService(new Intent(context, DownloadService.class));
        }
    }

    static synchronized boolean isActive() {
        return starting || running;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_START.equals(action)) {
            ServiceCompat.startForeground(
                this,
                DownloadNotifications.PROGRESS_ID,
                DownloadNotifications.progress(this, DownloadNotifications.Content.from(intent)),
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0
            );
            boolean stopNow;
            synchronized (DownloadService.class) {
                starting = false;
                running = true;
                stopNow = stopWhenStarted;
                stopWhenStarted = false;
            }
            if (stopNow) stopSelf();
            return START_NOT_STICKY;
        }

        boolean active;
        synchronized (DownloadService.class) {
            active = running;
            if (ACTION_STOP.equals(action)) running = false;
        }
        if (!active) {
            // A tap on a notification left from an earlier run.
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            DownloadsPlugin.dispatchAction("stop");
            stopSelf();
        } else if (ACTION_PAUSE.equals(action)) {
            DownloadsPlugin.dispatchAction("pause");
        } else if (ACTION_RESUME.equals(action)) {
            DownloadsPlugin.dispatchAction("resume");
        }
        return START_NOT_STICKY;
    }

    /** Android 15+: a data-sync service may run about 6 hours a day. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        DownloadsPlugin.dispatchAction("stop");
        stopSelf();
    }

    @Override
    public void onDestroy() {
        synchronized (DownloadService.class) {
            running = false;
            starting = false;
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
