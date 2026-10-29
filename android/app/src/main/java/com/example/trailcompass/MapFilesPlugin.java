package com.example.trailcompass;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;

/**
 * Byte ranges of offline map files (PMTiles). The Filesystem plugin only
 * reads and writes whole files, and the web view's local server ignores
 * the start of a Range request, so the map reads tiles through here.
 * Paths are relative to the Filesystem plugin's DATA or CACHE folder.
 * The JS side is src/offline/pack-files.ts.
 */
@CapacitorPlugin(name = "MapFiles")
public class MapFilesPlugin extends Plugin {

    /** Bigger reads would be slow to pass to the web view as base64. */
    private static final int MAX_READ = 8 * 1024 * 1024;

    @PluginMethod
    public void readRange(PluginCall call) {
        File file;
        try {
            file = resolve(call);
        } catch (IOException e) {
            call.reject(e.getMessage());
            return;
        }
        // getLong only accepts values JSON parsed as Long; small offsets arrive as Integer.
        long offset = call.getData().optLong("offset", -1);
        int length = call.getData().optInt("length", -1);
        if (offset < 0 || length < 0 || length > MAX_READ) {
            call.reject("Bad range");
            return;
        }
        getBridge().execute(() -> {
            try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
                // Readers ask for the first 16 KiB even when the file is shorter.
                int count = (int) Math.max(0, Math.min(length, raf.length() - offset));
                byte[] bytes = new byte[count];
                raf.seek(offset);
                raf.readFully(bytes);
                JSObject result = new JSObject();
                result.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(result);
            } catch (IOException e) {
                call.reject("Couldn't read the map file: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void writeAt(PluginCall call) {
        File file;
        try {
            file = resolve(call);
        } catch (IOException e) {
            call.reject(e.getMessage());
            return;
        }
        // getLong only accepts values JSON parsed as Long; small offsets arrive as Integer.
        long offset = call.getData().optLong("offset", -1);
        String data = call.getString("data", "");
        if (offset < 0) {
            call.reject("Bad offset");
            return;
        }
        getBridge().execute(() -> {
            try (RandomAccessFile raf = new RandomAccessFile(file, "rw")) {
                raf.seek(offset);
                raf.write(Base64.decode(data, Base64.DEFAULT));
                call.resolve();
            } catch (IOException | IllegalArgumentException e) {
                call.reject("Couldn't write the map file: " + e.getMessage());
            }
        });
    }

    /** Keeps paths inside the app's own data and cache folders. */
    private File resolve(PluginCall call) throws IOException {
        String path = call.getString("path", "");
        File root = "CACHE".equals(call.getString("directory", "DATA"))
            ? getContext().getCacheDir()
            : getContext().getFilesDir();
        File file = new File(root, path).getCanonicalFile();
        if (path.isEmpty() || !file.getPath().startsWith(root.getCanonicalPath() + File.separator)) {
            throw new IOException("Path outside the app's folders");
        }
        return file;
    }
}
