package com.example.trailcompass;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.PluginCall;

/** The route-planning notifications: progress while it runs, then the result. */
final class DownloadNotifications {

    static final int PROGRESS_ID = 4101;
    private static final int RESULT_ID = 4102;
    private static final String PROGRESS_CHANNEL = "route-planning";
    private static final String RESULT_CHANNEL = "route-ready";

    private static final String EXTRA_TITLE = "title";
    private static final String EXTRA_TEXT = "text";
    private static final String EXTRA_PERCENT = "percent";
    private static final String EXTRA_PAUSED = "paused";

    private DownloadNotifications() {}

    /** What the progress notification shows. A percent below 0 means unknown. */
    static final class Content {

        final String title;
        final String text;
        final int percent;
        final boolean paused;

        Content(String title, String text, int percent, boolean paused) {
            this.title = title;
            this.text = text;
            this.percent = percent;
            this.paused = paused;
        }

        static Content from(PluginCall call) {
            Integer percent = call.getInt("percent");
            return new Content(
                call.getString("title", "Planning your route"),
                call.getString("text", ""),
                percent == null ? -1 : Math.max(0, Math.min(100, percent)),
                Boolean.TRUE.equals(call.getBoolean("paused", false))
            );
        }

        static Content from(Intent intent) {
            String title = intent.getStringExtra(EXTRA_TITLE);
            String text = intent.getStringExtra(EXTRA_TEXT);
            return new Content(
                title == null ? "Planning your route" : title,
                text == null ? "" : text,
                intent.getIntExtra(EXTRA_PERCENT, -1),
                intent.getBooleanExtra(EXTRA_PAUSED, false)
            );
        }

        Intent into(Intent intent) {
            return intent
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_TEXT, text)
                .putExtra(EXTRA_PERCENT, percent)
                .putExtra(EXTRA_PAUSED, paused);
        }
    }

    static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel progress = new NotificationChannel(
            PROGRESS_CHANNEL,
            "Route planning",
            NotificationManager.IMPORTANCE_LOW
        );
        progress.setDescription("Progress while roads download in the background");
        NotificationChannel result = new NotificationChannel(RESULT_CHANNEL, "Route ready", NotificationManager.IMPORTANCE_DEFAULT);
        result.setDescription("When a route planned in the background is ready");
        manager.createNotificationChannel(progress);
        manager.createNotificationChannel(result);
    }

    static Notification progress(Context context, Content content) {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, PROGRESS_CHANNEL)
            .setSmallIcon(content.paused ? android.R.drawable.ic_media_pause : android.R.drawable.stat_sys_download)
            .setContentTitle(content.title)
            .setContentText(content.text)
            .setContentIntent(openApp(context))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            // Android 12+ otherwise holds a new service notification back for ~10 s.
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        if (content.paused) {
            builder.addAction(android.R.drawable.ic_media_play, "Resume", serviceAction(context, DownloadService.ACTION_RESUME));
        } else {
            builder.setProgress(100, Math.max(0, content.percent), content.percent < 0);
            builder.addAction(android.R.drawable.ic_media_pause, "Pause", serviceAction(context, DownloadService.ACTION_PAUSE));
        }
        builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", serviceAction(context, DownloadService.ACTION_STOP));
        return builder.build();
    }

    static void showProgress(Context context, Content content) {
        post(context, PROGRESS_ID, progress(context, content));
    }

    static void showResult(Context context, String title, String text, boolean ok) {
        Notification notification = new NotificationCompat.Builder(context, RESULT_CHANNEL)
            .setSmallIcon(ok ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_notify_error)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openApp(context))
            .setAutoCancel(true)
            .build();
        post(context, RESULT_ID, notification);
    }

    /** Without permission (Android 13+) or with notifications off, nothing is shown. */
    private static void post(Context context, int id, Notification notification) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return;
        }
        try {
            NotificationManagerCompat.from(context).notify(id, notification);
        } catch (SecurityException ignored) {
            // Permission withdrawn meanwhile.
        }
    }

    /** Brings the app back to the front, like its launcher icon. */
    private static PendingIntent openApp(Context context) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent serviceAction(Context context, String action) {
        Intent intent = new Intent(context, DownloadService.class).setAction(action);
        return PendingIntent.getService(
            context,
            action.hashCode(),
            intent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
    }
}
