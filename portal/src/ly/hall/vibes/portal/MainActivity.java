package ly.hall.vibes.portal;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * vibes, full screen: one WebView on https://vibes.hall.ly/, no browser chrome.
 * The Portal's own bars are hidden too (swipe in from an edge to bring them back).
 *
 * It logs in as a device once, with the key passed in over adb (never stored
 * in the app; the session cookie lasts until the key changes):
 *
 *   adb shell am start -n ly.hall.vibes.portal/.MainActivity --es key <key>
 */
public class MainActivity extends Activity {
    private static final String HOME = "https://vibes.hall.ly/";
    private static final long RETRY_MS = 10_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView web;
    // The page didn't load (no network yet, as just after booting): load it
    // again as soon as there's a network, rather than waiting out RETRY_MS.
    private boolean failed;
    private ConnectivityManager.NetworkCallback network;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Inspectable from chrome://inspect over adb (which can do anything to the Portal anyway).
        WebView.setWebContentsDebuggingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        clearCacheOnUpdate();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                failed = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                // No network or vibes down: try again until it's back.
                if (req.isForMainFrame()) {
                    failed = true;
                    retry();
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The page's renderer died; start over rather than crash the app.
                recreate();
                return true;
            }
        });
        setContentView(web);
        watchNetwork();
        open(getIntent(), true);
    }

    /**
     * Once after each install or update, forget the pages the WebView has
     * cached (not its cookies, so it stays logged in). vibes once served its
     * page dated 1970, which a cache takes to mean fresh for years.
     */
    private void clearCacheOnUpdate() {
        SharedPreferences prefs = getSharedPreferences("vibes", Context.MODE_PRIVATE);
        long version;
        try {
            version = getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode();
        } catch (PackageManager.NameNotFoundException e) {
            return;
        }
        if (prefs.getLong("cleared-for", -1) == version) return;
        web.clearCache(true);
        prefs.edit().putLong("cleared-for", version).apply();
    }

    private void watchNetwork() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm == null) return;
        network = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network n) {
                handler.post(() -> {
                    if (!failed) return;
                    handler.removeCallbacksAndMessages(null);
                    web.loadUrl(HOME);
                });
            }
        };
        cm.registerDefaultNetworkCallback(network);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        open(intent, false);
    }

    private void open(Intent intent, boolean first) {
        String key = intent == null ? null : intent.getStringExtra("key");
        if (key != null) {
            intent.removeExtra("key");
            web.loadUrl(HOME + "auth/device?key=" + Uri.encode(key));
        } else if (first) {
            web.loadUrl(HOME);
        }
    }

    private void retry() {
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(() -> web.loadUrl(HOME), RETRY_MS);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onBackPressed() {
        // Back goes back in vibes. On its first page it does nothing: this is
        // the home screen, so leaving would only open it again.
        if (web.canGoBack()) web.goBack();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm != null && network != null) cm.unregisterNetworkCallback(network);
        web.destroy();
        super.onDestroy();
    }
}
