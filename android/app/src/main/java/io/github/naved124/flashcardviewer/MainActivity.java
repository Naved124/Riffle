package io.github.naved124.flashcardviewer;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.view.View;
import android.view.Window;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
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

import java.net.InetAddress;
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
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Hosts the shared Riffle web UI (flashcard_viewer/ui, copied into assets/ui) in a WebView.
 * The app logic runs in JavaScript (ui/js/core); this class supplies what a web page cannot do itself:
 * serving bundled assets, an offline cache for CDN files, file picking/saving, "Open with"/share
 * intents, the back button and system-bar colours.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/ui/index.html";
    private static final String UPDATE_PREFIX = "https://github.com/Naved124/Riffle/releases/download/";
    private static final String ACTION_INSTALL_STATUS = "io.github.naved124.flashcardviewer.INSTALL_STATUS";
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
    // Read once on the UI thread: WebView methods throw when called from the network threads.
    private volatile String userAgent = "";
    // Per-install key handed to the app page in its URL fragment. Deck frames (sandboxed, opaque
    // origin) can't read it, so they can't call the bridge methods that need it.
    private String bridgeKey;
    private String[] pendingUpdate; // url, sha256, size: waiting for "install unknown apps" permission
    private volatile boolean updateRunning = false;
    private BroadcastReceiver installReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        cdnDir = new File(getCacheDir(), "cdn");
        //noinspection ResultOfMethodCallIgnored
        cdnDir.mkdirs();

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        bridgeKey = loadBridgeKey();
        createWebView();
        handleIntent(getIntent());
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL + "#k=" + bridgeKey);
    }

    private String loadBridgeKey() {
        SharedPreferences prefs = getSharedPreferences("app", MODE_PRIVATE);
        String k = prefs.getString("bridgeKey", null);
        if (k == null) {
            byte[] b = new byte[24];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            k = sb.toString();
            prefs.edit().putString("bridgeKey", k).apply();
        }
        return k;
    }

    private boolean keyOk(String key) {
        return key != null && MessageDigest.isEqual(key.getBytes(StandardCharsets.UTF_8), bridgeKey.getBytes(StandardCharsets.UTF_8));
    }

    private void createWebView() {
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
        userAgent = s.getUserAgentString();

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setBackgroundColor(Color.parseColor("#F3EDF7"));
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
    protected void onResume() {
        super.onResume();
        // Back from the "install unknown apps" screen: carry on with the update if it was allowed.
        if (pendingUpdate != null && getPackageManager().canRequestPackageInstalls()) {
            String[] u = pendingUpdate;
            pendingUpdate = null;
            startUpdate(u[0], u[1], Long.parseLong(u[2]));
        }
    }

    @Override
    protected void onDestroy() {
        if (installReceiver != null) {
            try {
                unregisterReceiver(installReceiver);
            } catch (IllegalArgumentException ignored) {
            }
        }
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
            if (!readableFromOutside(u)) {
                Toast.makeText(this, "Can't open that file", Toast.LENGTH_LONG).show();
                continue;
            }
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

    /**
     * Another app can hand us any URI. A file:// one must not point into this app's private storage or
     * system folders, or that app could make us import (and display) files only we can read.
     */
    private boolean readableFromOutside(Uri uri) {
        if (!"file".equals(uri.getScheme())) return true;
        String path = uri.getPath();
        if (path == null) return false;
        try {
            String real = new File(path).getCanonicalPath();
            String own = new File(getApplicationInfo().dataDir).getCanonicalPath();
            return !(real.startsWith(own) || real.startsWith("/data/") || real.startsWith("/proc/")
                    || real.startsWith("/sys/") || real.startsWith("/system/"));
        } catch (IOException e) {
            return false;
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
            // .jsx/.tsx have no reliable MIME type, so decks use */* and the app filters by content;
            // the deck editor's image button asks for image/* and gets the image picker.
            boolean images = false;
            String[] accept = params.getAcceptTypes();
            if (accept != null && accept.length > 0) {
                images = true;
                for (String a : accept) if (a == null || !a.startsWith("image/")) images = false;
            }
            i.setType(images ? "image/*" : "*/*");
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
            android.util.Log.d("Riffle", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
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
            // Navigations inside the deck frame (anchors, about:srcdoc, forms) stay where they are.
            if (!request.isForMainFrame()) return false;
            String scheme = u.getScheme();
            if ("http".equals(scheme) || "https".equals(scheme) || "mailto".equals(scheme)) openExternal(u.toString());
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            try {
                Uri u = request.getUrl();
                String scheme = u.getScheme();
                if (HOST.equals(u.getHost())) return serveAsset(u.getPath());
                if (!"GET".equalsIgnoreCase(request.getMethod()) || request.isForMainFrame()) return null;
                if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
                if ("api.github.com".equals(u.getHost())) return null; // update checks must never be served from the cache
                // Never proxy this phone or the local network: the WebView then loads it itself, under
                // normal cross-origin rules, so a deck can't read a router or local service through us.
                if (!isPublicHost(u.getHost())) return null;
                return serveCached(u.toString());
            } catch (Exception e) {
                // Never let a bad request take the app down; the WebView falls back to a normal fetch.
                android.util.Log.w("Riffle", "intercept failed: " + e);
                return null;
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // A deck crashed or exhausted the web renderer. Without this the system kills the whole app.
            if (view != web) return true;
            pageReady = false;
            web.destroy();
            createWebView();
            web.loadUrl(START_URL + "?recovered=1#k=" + bridgeKey);
            Toast.makeText(MainActivity.this, "That deck crashed the viewer and was closed", Toast.LENGTH_LONG).show();
            return true;
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
        return corsHeaders(true);
    }

    /** cors: allow cross-origin reads (true for app assets and for CDN files whose server allows it). */
    private static Map<String, String> corsHeaders(boolean cors) {
        Map<String, String> h = new HashMap<>();
        if (cors) h.put("Access-Control-Allow-Origin", "*");
        h.put("Cache-Control", "no-cache");
        return h;
    }

    private static final String[] LOCAL_SUFFIXES = {".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".home.arpa", ".corp"};

    /** False for loopback, private, link-local and other non-public hosts (same rules as netpolicy.py). */
    static boolean isPublicHost(String host) {
        if (host == null) return false;
        String h = host.trim().toLowerCase(Locale.ROOT);
        while (h.endsWith(".")) h = h.substring(0, h.length() - 1);
        if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length() - 1);
        if (h.isEmpty() || h.equals("localhost")) return false;
        for (String s : LOCAL_SUFFIXES) if (h.endsWith(s)) return false;
        if (!h.contains(".") && !h.contains(":")) return false;
        if (h.contains(":")) return isPublicIp(h);
        String[] parts = h.split("\\.", -1);
        boolean numeric = parts.length <= 4;
        for (String p : parts) numeric &= p.matches("0x[0-9a-f]*|\\d+");
        if (!numeric) return true; // an ordinary host name
        if (parts.length != 4) return false; // shorthand IPv4 such as 127.1 or 0x7f.1
        for (String p : parts) {
            if (!p.matches("\\d{1,3}") || Integer.parseInt(p) > 255) return false;
        }
        return isPublicIp(h);
    }

    private static boolean isPublicIp(String literal) {
        try {
            InetAddress a = InetAddress.getByName(literal); // a literal: no DNS lookup
            byte[] b = a.getAddress();
            if (b.length == 16 && isV4Mapped(b)) b = java.util.Arrays.copyOfRange(b, 12, 16);
            if (a.isLoopbackAddress() || a.isAnyLocalAddress() || a.isLinkLocalAddress() || a.isSiteLocalAddress()
                    || a.isMulticastAddress()) return false;
            if (b.length == 4) {
                int x = b[0] & 0xff, y = b[1] & 0xff;
                return !(x == 0 || x == 10 || x == 127 || (x == 100 && y >= 64 && y < 128) || (x == 169 && y == 254)
                        || (x == 172 && y >= 16 && y < 32) || (x == 192 && y == 168) || x >= 224);
            }
            return (b[0] & 0xfe) != 0xfc; // IPv6 unique-local fc00::/7
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isV4Mapped(byte[] b) {
        for (int i = 0; i < 10; i++) if (b[i] != 0) return false;
        return (b[10] & 0xff) == 0xff && (b[11] & 0xff) == 0xff;
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
        File corsFile = new File(cdnDir, key + ".cors");
        if (body.exists() && meta.exists()) {
            try {
                String mime = readSmall(meta);
                boolean cors = !corsFile.exists() || "1".equals(readSmall(corsFile).trim()); // older entries: allowed
                return new WebResourceResponse(baseMime(mime), charsetOf(mime), 200, "OK", corsHeaders(cors), new FileInputStream(body));
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
            if (!userAgent.isEmpty()) c.setRequestProperty("User-Agent", userAgent);
            int code = c.getResponseCode();
            if (code >= 400) return null;
            if (!isPublicHost(c.getURL().getHost())) return null; // redirected onto the local network
            // Mirror the origin's CORS policy, like a browser would.
            String acao = c.getHeaderField("Access-Control-Allow-Origin");
            boolean cors = acao != null && !acao.trim().isEmpty();
            String mime = c.getContentType();
            if (mime == null) mime = "application/octet-stream";
            byte[] data = readAll(c.getInputStream());
            try (FileOutputStream out = new FileOutputStream(body)) {
                out.write(data);
            }
            try (FileOutputStream out = new FileOutputStream(meta)) {
                out.write(mime.getBytes(StandardCharsets.UTF_8));
            }
            try (FileOutputStream out = new FileOutputStream(corsFile)) {
                out.write((cors ? "1" : "0").getBytes(StandardCharsets.UTF_8));
            }
            return new WebResourceResponse(baseMime(mime), charsetOf(mime), 200, "OK", corsHeaders(cors), new ByteArrayInputStream(data));
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
        } catch (RuntimeException e) { // ActivityNotFoundException, SecurityException, FileUriExposedException
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
    }

    // ------------------------------------------------------------------ in-app updates
    private void updateEvent(String json) {
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript("window.__fvUpdateEvent && window.__fvUpdateEvent(" + JSONObject.quote(json) + ")", null);
        });
    }

    private void updateEvent(String state, String key, Object value) {
        try {
            JSONObject o = new JSONObject().put("state", state);
            if (key != null) o.put(key, value);
            updateEvent(o.toString());
        } catch (JSONException ignored) {
        }
    }

    private void startUpdate(String url, String sha256, long size) {
        if (updateRunning) return;
        if (!getPackageManager().canRequestPackageInstalls()) {
            // Android 8+: the user allows this app to install updates once.
            pendingUpdate = new String[]{url, sha256, String.valueOf(size)};
            updateEvent("permission", null, null);
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            } catch (RuntimeException e) {
                pendingUpdate = null;
                updateEvent("error", "message", "Allow \"Install unknown apps\" for Riffle in system settings, then try again.");
            }
            return;
        }
        updateRunning = true;
        new Thread(() -> {
            try {
                File apk = downloadUpdate(url, sha256, size);
                installApk(apk);
            } catch (Exception e) {
                updateRunning = false;
                updateEvent("error", "message", "Update failed: " + e.getMessage());
            }
        }, "update").start();
    }

    private File downloadUpdate(String url, String sha256, long size) throws IOException {
        File out = new File(getCacheDir(), "update.apk");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(true);
            if (c.getResponseCode() >= 400) throw new IOException("server answered " + c.getResponseCode());
            long total = c.getContentLengthLong() > 0 ? c.getContentLengthLong() : size;
            MessageDigest md;
            try {
                md = MessageDigest.getInstance("SHA-256");
            } catch (Exception e) {
                throw new IOException(e);
            }
            long done = 0;
            long lastSent = 0;
            try (InputStream in = c.getInputStream(); FileOutputStream fo = new FileOutputStream(out)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) {
                    fo.write(buf, 0, n);
                    md.update(buf, 0, n);
                    done += n;
                    long now = System.currentTimeMillis();
                    if (now - lastSent > 150) {
                        lastSent = now;
                        updateEvent("progress", "progress", total > 0 ? (double) done / total : -1);
                    }
                }
            }
            if (size > 0 && done != size) throw new IOException("download incomplete");
            if (!sha256.isEmpty()) {
                StringBuilder sb = new StringBuilder();
                for (byte b : md.digest()) sb.append(String.format("%02x", b));
                if (!sb.toString().equalsIgnoreCase(sha256)) {
                    //noinspection ResultOfMethodCallIgnored
                    out.delete();
                    throw new IOException("downloaded file failed its checksum");
                }
            }
            updateEvent("progress", "progress", 1.0);
            return out;
        } finally {
            c.disconnect();
        }
    }

    private void installApk(File apk) throws IOException {
        PackageInstaller pi = getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(getPackageName());
        int id = pi.createSession(params);
        try (PackageInstaller.Session session = pi.openSession(id)) {
            try (OutputStream o = session.openWrite("update.apk", 0, apk.length()); InputStream in = new FileInputStream(apk)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
                session.fsync(o);
            }
            registerInstallReceiver();
            Intent status = new Intent(ACTION_INSTALL_STATUS).setPackage(getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pending = PendingIntent.getBroadcast(this, id, status, flags);
            session.commit(pending.getIntentSender());
        }
        //noinspection ResultOfMethodCallIgnored
        apk.delete();
    }

    private void registerInstallReceiver() {
        if (installReceiver != null) return;
        installReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                    if (confirm != null) {
                        updateEvent("confirm", null, null);
                        startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    }
                    return;
                }
                updateRunning = false;
                if (status == PackageInstaller.STATUS_SUCCESS) return; // the app restarts as the new version
                String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
                    updateEvent("error", "message", "Update cancelled.");
                } else if (status == PackageInstaller.STATUS_FAILURE_CONFLICT || status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE) {
                    updateEvent("error", "message", "This update is signed with a different key than the installed app. "
                            + "Export a backup, uninstall the app and install the new APK from the releases page.");
                } else {
                    updateEvent("error", "message", "Update failed" + (msg != null ? ": " + msg : "."));
                }
            }
        };
        IntentFilter f = new IntentFilter(ACTION_INSTALL_STATUS);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(installReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(installReceiver, f);
    }

    // ------------------------------------------------------------------ window.AndroidBridge
    private class Bridge {
        @JavascriptInterface
        public void openExternal(String key, String url) {
            if (!keyOk(key)) return;
            if (url != null && (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:"))) {
                runOnUiThread(() -> MainActivity.this.openExternal(url));
            }
        }

        @JavascriptInterface
        public void saveFile(String key, String name, String mime, String text) {
            if (!keyOk(key)) return;
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
        public void setNetworkMode(String key, String mode) {
            if (keyOk(key) && mode != null) networkMode = mode;
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
        public void clearCache(String key) {
            if (!keyOk(key)) return;
            File[] list = cdnDir.listFiles();
            if (list != null) for (File f : list) //noinspection ResultOfMethodCallIgnored
                f.delete();
            runOnUiThread(() -> web.clearCache(true));
        }

        @JavascriptInterface
        public String pendingImports(String key) {
            if (!keyOk(key)) return "[]";
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
        public void installUpdate(String key, String url, String sha256, double size) {
            if (!keyOk(key) || url == null || !url.startsWith(UPDATE_PREFIX) || !url.endsWith(".apk")) return;
            runOnUiThread(() -> startUpdate(url, sha256 == null ? "" : sha256, (long) size));
        }

        @JavascriptInterface
        public String platformInfo() {
            return "{\"sdk\":" + Build.VERSION.SDK_INT + "}";
        }
    }
}
