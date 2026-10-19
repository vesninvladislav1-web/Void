package site.voidm.borozdinovsky;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

// Игра — во встроенном движке Android (WebView), на весь экран, горизонтально, экран не гаснет.
// Ссылки на voidm.site/brzd-rstv открываются внутри; остальные — в браузере телефона.
// Нет интернета и игра ещё ни разу не загружалась — показываем свою страницу «нужен интернет».
public class MainActivity extends Activity {
    private static final String ИГРА = "https://voidm.site/brzd-rstv/";
    private WebView веб;

    @Override
    protected void onCreate(Bundle сохранено) {
        super.onCreate(сохранено);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) getWindow().getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        веб = new WebView(this);
        setContentView(веб);
        спрятатьПанели();

        WebSettings н = веб.getSettings();
        н.setJavaScriptEnabled(true);
        н.setDomStorageEnabled(true);
        н.setDatabaseEnabled(true);
        н.setMediaPlaybackRequiresUserGesture(false);
        н.setCacheMode(WebSettings.LOAD_DEFAULT);
        н.setUserAgentString(н.getUserAgentString() + " BrzdApp/2");   // игра знает, что она в приложении

        веб.setWebChromeClient(new WebChromeClient());
        веб.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView в, WebResourceRequest з) {
                Uri u = з.getUrl();
                if ("voidm.site".equals(u.getHost()) || "file".equals(u.getScheme())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { }
                return true;
            }
            @Override
            public void onReceivedError(WebView в, WebResourceRequest з, WebResourceError о) {
                if (з.isForMainFrame()) в.loadUrl("file:///android_asset/offline.html");
            }
        });

        if (сохранено != null) веб.restoreState(сохранено);
        else веб.loadUrl(адрес(getIntent()));
    }

    private String адрес(Intent и) {
        Uri u = и != null ? и.getData() : null;
        if (u != null && "voidm.site".equals(u.getHost()) && u.getPath() != null && u.getPath().startsWith("/brzd-rstv")) return u.toString();
        return ИГРА;
    }

    @Override
    protected void onNewIntent(Intent и) {
        super.onNewIntent(и);
        if (и != null && и.getData() != null) веб.loadUrl(адрес(и));
    }

    private void спрятатьПанели() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public void onWindowFocusChanged(boolean фокус) { super.onWindowFocusChanged(фокус); if (фокус) спрятатьПанели(); }

    @Override
    public void onBackPressed() { if (веб.canGoBack()) веб.goBack(); else super.onBackPressed(); }

    @Override
    protected void onResume() { super.onResume(); веб.onResume(); веб.resumeTimers(); }

    @Override
    protected void onPause() { веб.onPause(); веб.pauseTimers(); super.onPause(); }

    @Override
    protected void onSaveInstanceState(Bundle б) { super.onSaveInstanceState(б); веб.saveState(б); }
}
