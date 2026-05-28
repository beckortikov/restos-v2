import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.restos.waiter',
  appName: 'RestOS Waiter',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
    // Allow plain-HTTP traffic to LAN restaurant servers — they don't have SSL
    // and we don't want certificate warnings inside the WebView.
    cleartext: true,
    // Outgoing navigation whitelist: anything in standard private LAN ranges.
    // Without this, Android WebView blocks navigation away from the local
    // bundle and Capacitor.WebView.setServerBasePath() can't redirect.
    allowNavigation: [
      '192.168.*',
      '10.*',
      '172.16.*', '172.17.*', '172.18.*', '172.19.*',
      '172.20.*', '172.21.*', '172.22.*', '172.23.*',
      '172.24.*', '172.25.*', '172.26.*', '172.27.*',
      '172.28.*', '172.29.*', '172.30.*', '172.31.*',
      'localhost',
    ],
  },
  plugins: {
    // Camera permission rationale shown to the user the first time they tap
    // "Сканировать QR" in NativeConnectScreen.
    BarcodeScanner: {},
  },
  android: {
    allowMixedContent: true,
  },
}

export default config
