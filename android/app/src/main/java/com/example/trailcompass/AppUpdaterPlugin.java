package com.example.trailcompass;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Downloads a TrailCompass release APK and hands it to Android's package
 * installer. Releases are published on GitHub, not Google Play; the JS side
 * is src/services/app-update.service.ts.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private static final String UPDATE_DIR = "updates";
    private static final int REPORT_EVERY_BYTES = 256 * 1024;

    /** Download `url` into the cache as `fileName`, sending "progress" events. */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String fileName = call.getString("fileName");
        if (url == null || !url.startsWith("https://") || fileName == null || !fileName.matches("[A-Za-z0-9._-]+\\.apk")) {
            call.reject("Invalid download request");
            return;
        }
        // Plugin calls share one thread; a 10 MB download must not hold it.
        new Thread(() -> {
            File dir = updateDir();
            File target = new File(dir, fileName);
            File partial = new File(dir, fileName + ".part");
            HttpURLConnection connection = null;
            try {
                if (!dir.isDirectory() && !dir.mkdirs()) {
                    throw new IOException("cannot create the download folder");
                }
                // Only the newest update is kept.
                File[] old = dir.listFiles();
                if (old != null) {
                    for (File file : old) {
                        if (!file.equals(target)) file.delete();
                    }
                }

                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(20_000);
                connection.setReadTimeout(30_000);
                connection.setInstanceFollowRedirects(true);
                int status = connection.getResponseCode();
                if (status != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + status);

                long total = connection.getContentLength();
                long bytes = 0;
                long reported = 0;
                try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(partial)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                        bytes += read;
                        if (bytes - reported >= REPORT_EVERY_BYTES) {
                            reported = bytes;
                            notifyProgress(bytes, total);
                        }
                    }
                }
                if (total > 0 && bytes != total) throw new IOException("the download was cut short");
                notifyProgress(bytes, total);

                if (target.exists() && !target.delete()) throw new IOException("cannot replace the old download");
                if (!partial.renameTo(target)) throw new IOException("cannot save the download");
                JSObject result = new JSObject();
                result.put("path", target.getAbsolutePath());
                call.resolve(result);
            } catch (Exception e) {
                partial.delete();
                call.reject("Download failed: " + e.getMessage(), e);
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }

    /** Whether Android lets this app open the package installer. */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject result = new JSObject();
        result.put("value", installAllowed());
        call.resolve(result);
    }

    /**
     * Open the package installer for a downloaded update. Without the
     * "install unknown apps" permission, open that setting instead.
     */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        File file = path == null ? null : new File(path);
        if (file == null || !file.isFile() || !updateDir().equals(file.getParentFile())) {
            call.reject("Update file not found");
            return;
        }

        JSObject result = new JSObject();
        if (!installAllowed()) {
            Intent settings = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
            );
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            result.put("status", "needs-permission");
            call.resolve(result);
            return;
        }

        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        result.put("status", "started");
        call.resolve(result);
    }

    private boolean installAllowed() {
        // Before Android 8 the system-wide "Unknown sources" setting applies instead.
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getContext().getPackageManager().canRequestPackageInstalls();
    }

    private File updateDir() {
        return new File(getContext().getCacheDir(), UPDATE_DIR);
    }

    private void notifyProgress(long bytes, long total) {
        JSObject progress = new JSObject();
        progress.put("bytes", bytes);
        progress.put("total", total);
        notifyListeners("progress", progress);
    }
}
