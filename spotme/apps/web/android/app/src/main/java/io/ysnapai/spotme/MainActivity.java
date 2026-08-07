package io.ysnapai.spotme;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Spot Me runs entirely inside the WebView Capacitor provides, so the only
 * native code needed is the bridge between Android's permission model and the
 * getUserMedia() calls the web app already makes for voice notes, photo
 * capture, and calls.
 *
 * WITHOUT THIS: Capacitor's default WebChromeClient denies every
 * PermissionRequest, so getUserMedia() rejects even after the user granted
 * the Android runtime permission — the mic/camera prompt would work once,
 * then everything downstream would fail silently.
 */
public class MainActivity extends BridgeActivity {
  private static final int PERMISSION_REQUEST_CODE = 8420;

  @Override
  public void onCreate (Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    /*
     * The web app is right that a BROWSER cannot detect or prevent screenshots
     * (main.js:498) — but the packaged app is not a browser, and FLAG_SECURE is
     * a platform capability we were simply not using. It blocks screenshots and
     * screen recording, and blanks the app-switcher preview at the OS level,
     * which is the same thing the JS `appBlur` setting approximates.
     *
     * Honest limits: a second phone pointed at the screen defeats it, and on a
     * rooted device it is advisory. It also blocks LEGITIMATE screenshots of
     * ordinary chats, which is a product decision — this is the safe default,
     * not the only option. To narrow it to the view-once overlay later, drop
     * this call and expose the two setFlags/clearFlags lines through a small
     * Capacitor plugin that openViewOnce()/finish() can call; nothing else in
     * this file has to change.
     */
    getWindow().setFlags(
      WindowManager.LayoutParams.FLAG_SECURE,
      WindowManager.LayoutParams.FLAG_SECURE
    );

    // Ask up front rather than on first use: getUserMedia() has no good way
    // to pause mid-call while a system dialog resolves.
    String[] needed = {
      Manifest.permission.CAMERA,
      Manifest.permission.RECORD_AUDIO
    };
    java.util.List<String> missing = new java.util.ArrayList<>();
    for (String permission : needed) {
      if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
        missing.add(permission);
      }
    }
    if (!missing.isEmpty()) {
      ActivityCompat.requestPermissions(this, missing.toArray(new String[0]), PERMISSION_REQUEST_CODE);
    }

    bridge.getWebView().setWebChromeClient(new WebChromeClient() {
      @Override
      public void onPermissionRequest (final PermissionRequest request) {
        runOnUiThread(() -> {
          java.util.List<String> granted = new java.util.ArrayList<>();
          for (String resource : request.getResources()) {
            boolean isVideo = resource.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
            boolean isAudio = resource.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE);
            String androidPermission = isVideo ? Manifest.permission.CAMERA
              : isAudio ? Manifest.permission.RECORD_AUDIO : null;
            // Only grant what the Android permission system already allows —
            // this bridges the two permission layers, it does not bypass one.
            if (androidPermission != null
              && ContextCompat.checkSelfPermission(MainActivity.this, androidPermission)
                == PackageManager.PERMISSION_GRANTED) {
              granted.add(resource);
            }
          }
          if (!granted.isEmpty()) request.grant(granted.toArray(new String[0]));
          else request.deny();
        });
      }
    });
  }
}
