package site.voidm.borozdinovsky;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;
import java.io.OutputStream;
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
        н.setUserAgentString(н.getUserAgentString() + " BrzdApp/4");   // игра знает, что она в приложении
        веб.addJavascriptInterface(new PhotoBridge(), "BrzdApp");                 // фоторежим: снимок в галерею; копирование в буфер

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

    // Для игры: window.BrzdApp.savePhoto(base64 JPEG) — кладёт снимок в галерею, в альбом «Бороздиновский».
    // Страницы с других сайтов в приложении не открываются (уходят в браузер), так что мост видит только игра.
    private class PhotoBridge {   // имя класса — латиницей: оно становится именем .class-файла
        @JavascriptInterface
        public boolean savePhoto(String base64) {
            if (base64 == null || base64.length() > 20_000_000) return false;
            try {
                byte[] байты = Base64.decode(base64, Base64.DEFAULT);
                String имя = "brzd_" + System.currentTimeMillis() + ".jpg";
                boolean ок;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues зн = new ContentValues();
                    зн.put(MediaStore.Images.Media.DISPLAY_NAME, имя);
                    зн.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                    зн.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Бороздиновский");
                    Uri u = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, зн);
                    if (u == null) return false;
                    try (OutputStream о = getContentResolver().openOutputStream(u)) { о.write(байты); }
                    ок = true;
                } else {
                    if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                        runOnUiThread(() -> requestPermissions(new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE }, 1));
                        сказать("Разреши доступ к фото и сними ещё раз");
                        return false;
                    }
                    Bitmap к = BitmapFactory.decodeByteArray(байты, 0, байты.length);
                    ок = к != null && MediaStore.Images.Media.insertImage(getContentResolver(), к, имя, "Бороздиновский") != null;
                }
                if (ок) сказать("📸 Фото в галерее");
                return ок;
            } catch (Exception e) { сказать("Не вышло сохранить фото"); return false; }
        }
        // window.BrzdApp.copyText(текст) — в буфер обмена (в WebView обычное копирование ненадёжно)
        @JavascriptInterface
        public boolean copyText(String т) {
            if (т == null || т.length() > 100_000) return false;
            runOnUiThread(() -> { ClipboardManager б = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE); if (б != null) б.setPrimaryClip(ClipData.newPlainText("Бороздиновский", т)); });
            return true;
        }
    }
    private void сказать(String т) { runOnUiThread(() -> Toast.makeText(this, т, Toast.LENGTH_SHORT).show()); }

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

    // «Назад»: сначала игра закрывает своё окно (меню, гонки, онлайн…); нечего закрывать — выход только по второму нажатию
    private long прошлыйНазад = 0;
    @Override
    public void onBackPressed() {
        веб.evaluateJavascript("(window.__назад && window.__назад()) ? 1 : 0", ответ -> {
            if ("1".equals(ответ)) return;
            if (веб.canGoBack()) { веб.goBack(); return; }
            long сейчас = System.currentTimeMillis();
            if (сейчас - прошлыйНазад < 2000) finish();
            else { прошлыйНазад = сейчас; сказать("Нажми «Назад» ещё раз, чтобы выйти"); }
        });
    }

    @Override
    protected void onResume() { super.onResume(); веб.onResume(); веб.resumeTimers(); }

    @Override
    protected void onPause() { веб.onPause(); веб.pauseTimers(); super.onPause(); }

    @Override
    protected void onSaveInstanceState(Bundle б) { super.onSaveInstanceState(б); веб.saveState(б); }
}
