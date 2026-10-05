package io.github.naved124.flashcardviewer;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.Window;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Hosts the shared Flashcard Viewer web UI (flashcard_viewer/ui, copied into assets/ui) in a WebView.
 * The app logic runs in JavaScript (ui/js/core); this class supplies what a web page cannot do itself:
 * serving bundled assets, an offline cache for CDN files, file picking/saving, "Open with"/share
 * intents, the back button and system-bar colours.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/ui/index.html";
    private static final int REQ_PICK = 1;
    private static final int REQ_SAVE = 2;
    private static final long MAX_DECK_BYTES = 25L * 1024 * 1024;

    private WebView web;
    private boolean pageReady = false;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingSaveText;
    private volatile String networkMode = "offline-first";
    private final List<JSONObject> pendingImports = new ArrayList<>();
    private File cdnDir;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        cdnDir = new File(getCacheDir(), "cdn");
        //noinspection ResultOfMethodCallIgnored
        cdnDir.mkdirs();

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100); // the app has its own text-size setting
        s.setSupportZoom(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setBackgroundColor(Color.parseColor("#F3EDF7"));

        handleIntent(getIntent());
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (!pageReady) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("(window.__fvBack && window.__fvBack()) ? 'yes' : 'no'", value -> {
            if (value == null || !value.contains("yes")) finish();
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.evaluateJavascript("window.__fvBeforeClose && window.__fvBeforeClose()", null);
            web.destroy();
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------ intents ("Open with", share)
    private void handleIntent(Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
            else {
                CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (text != null && text.length() > 0) deliverImport("shared-deck.html", text.toString());
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        for (Uri u : uris) {
            try {
                String text = readText(u);
                deliverImport(displayName(u), text);
            } catch (IOException e) {
                Toast.makeText(this, "Couldn't open file: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        }
    }

    private void deliverImport(String name, String text) {
        try {
            JSONObject o = new JSONObject();
            o.put("name", name);
            o.put("text", text);
            if (pageReady) {
                web.evaluateJavascript("window.__fvImport && window.__fvImport(" + JSONObject.quote(name) + ","
                        + JSONObject.quote(text) + ")", null);
            } else {
                synchronized (pendingImports) {
                    pendingImports.add(o);
                }
            }
        } catch (JSONException ignored) {
        }
    }

    private String displayName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {
            }
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "deck.html";
        return name;
    }

    private String readText(Uri uri) throws IOException {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("unreadable");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            long total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_DECK_BYTES) throw new IOException("file is larger than 25 MB");
                out.write(buf, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    // ------------------------------------------------------------------ activity results
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK) {
            if (fileCallback == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) {
                    result = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
        } else if (requestCode == REQ_SAVE) {
            String text = pendingSaveText;
            pendingSaveText = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null || text == null) return;
            try (OutputStream out = getContentResolver().openOutputStream(data.getData(), "wt")) {
                if (out == null) throw new IOException("unwritable");
                out.write(text.getBytes(StandardCharsets.UTF_8));
                Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show();
            } catch (IOException e) {
                Toast.makeText(this, "Couldn't save: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        }
    }

    // ------------------------------------------------------------------ WebView plumbing
    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*"); // .jsx/.tsx have no reliable MIME type; the app filters by content
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try {
                startActivityForResult(i, REQ_PICK);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            android.util.Log.d("FlashcardViewer", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
            return true;
        }
    }

    private class Client extends WebViewClient {
        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (HOST.equals(u.getHost())) return false;
            openExternal(u.toString());
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String scheme = u.getScheme();
            if (HOST.equals(u.getHost())) return serveAsset(u.getPath());
            if (!"GET".equalsIgnoreCase(request.getMethod()) || request.isForMainFrame()) return null;
            if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
            return serveCached(u.toString());
        }
    }

    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("woff2", "font/woff2");
        MIME.put("woff", "font/woff");
        MIME.put("ttf", "font/ttf");
        MIME.put("txt", "text/plain");
    }

    private static Map<String, String> corsHeaders() {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Cache-Control", "no-cache");
        return h;
    }

    private WebResourceResponse serveAsset(String path) {
        if (path == null || !path.startsWith("/assets/")) return notFound();
        String rel = Uri.decode(path.substring("/assets/".length()));
        if (rel.contains("..")) return notFound();
        String ext = rel.contains(".") ? rel.substring(rel.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
        String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
        try {
            InputStream in = getAssets().open(rel);
            boolean text = mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");
            return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", corsHeaders(), in);
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", corsHeaders(),
                new ByteArrayInputStream(new byte[0]));
    }

    // ------------------------------------------------------------------ offline CDN cache
    private static String sha256(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest(s.getBytes(StandardCharsets.UTF_8))) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }

    private WebResourceResponse serveCached(String url) {
        String mode = networkMode;
        if ("online".equals(mode)) return null; // let the WebView fetch normally
        String key = sha256(url);
        File body = new File(cdnDir, key + ".bin");
        File meta = new File(cdnDir, key + ".mime");
        if (body.exists() && meta.exists()) {
            try {
                String mime = readSmall(meta);
                return new WebResourceResponse(baseMime(mime), charsetOf(mime), 200, "OK", corsHeaders(), new FileInputStream(body));
            } catch (IOException ignored) {
            }
        }
        if ("offline".equals(mode)) return notFound();
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", web.getSettings().getUserAgentString());
            int code = c.getResponseCode();
            if (code >= 400) return null;
            String mime = c.getContentType();
            if (mime == null) mime = "application/octet-stream";
            byte[] data = readAll(c.getInputStream());
            try (FileOutputStream out = new FileOutputStream(body)) {
                out.write(data);
            }
            try (FileOutputStream out = new FileOutputStream(meta)) {
                out.write(mime.getBytes(StandardCharsets.UTF_8));
            }
            return new WebResourceResponse(baseMime(mime), charsetOf(mime), 200, "OK", corsHeaders(), new ByteArrayInputStream(data));
        } catch (IOException e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String baseMime(String m) {
        int i = m.indexOf(';');
        return (i >= 0 ? m.substring(0, i) : m).trim();
    }

    private static String charsetOf(String m) {
        String lower = m.toLowerCase(Locale.ROOT);
        int i = lower.indexOf("charset=");
        if (i >= 0) return m.substring(i + 8).trim();
        return lower.startsWith("text/") || lower.contains("javascript") || lower.contains("json") ? "utf-8" : null;
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try (InputStream is = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static String readSmall(File f) throws IOException {
        return new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8);
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
    }

    // ------------------------------------------------------------------ window.AndroidBridge
    private class Bridge {
        @JavascriptInterface
        public void openExternal(String url) {
            if (url != null && (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:"))) {
                runOnUiThread(() -> MainActivity.this.openExternal(url));
            }
        }

        @JavascriptInterface
        public void saveFile(String name, String mime, String text) {
            runOnUiThread(() -> {
                pendingSaveText = text;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                i.putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(i, REQ_SAVE);
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this, "No file manager available", Toast.LENGTH_LONG).show();
                }
            });
        }

        @JavascriptInterface
        public void setNetworkMode(String mode) {
            if (mode != null) networkMode = mode;
        }

        @JavascriptInterface
        public String cacheInfo() {
            long bytes = 0;
            int files = 0;
            File[] list = cdnDir.listFiles();
            if (list != null) {
                for (File f : list) {
                    if (f.getName().endsWith(".bin")) {
                        files++;
                        bytes += f.length();
                    }
                }
            }
            return "{\"files\":" + files + ",\"bytes\":" + bytes + "}";
        }

        @JavascriptInterface
        public void clearCache() {
            File[] list = cdnDir.listFiles();
            if (list != null) for (File f : list) //noinspection ResultOfMethodCallIgnored
                f.delete();
            runOnUiThread(() -> web.clearCache(true));
        }

        @JavascriptInterface
        public String pendingImports() {
            JSONArray arr = new JSONArray();
            synchronized (pendingImports) {
                for (JSONObject o : pendingImports) arr.put(o);
                pendingImports.clear();
            }
            return arr.toString();
        }

        @JavascriptInterface
        public void setSystemBars(String color, boolean dark) {
            runOnUiThread(() -> {
                int c;
                try {
                    c = Color.parseColor(color.trim());
                } catch (IllegalArgumentException e) {
                    return;
                }
                Window w = getWindow();
                w.setStatusBarColor(c);
                w.setNavigationBarColor(c);
                web.setBackgroundColor(c);
                View decor = w.getDecorView();
                int flags = decor.getSystemUiVisibility();
                if (dark) {
                    flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                } else {
                    flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR; // API 26+
                }
                decor.setSystemUiVisibility(flags);
            });
        }

        @JavascriptInterface
        public String platformInfo() {
            return "{\"sdk\":" + Build.VERSION.SDK_INT + "}";
        }
    }
}
