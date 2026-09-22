import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Example Capacitor configuration for wrapping a web app
 * Replace placeholders with your actual values
 *
 * IMPORTANT: iOS and Android Bundle IDs
 * - The appId here serves as the DEFAULT and should be set to your Android package name
 * - Android will use this value (also set it explicitly in android/app/build.gradle)
 * - iOS bundle ID must be set separately in Xcode (see SKILL.md Phase 8.1)
 * - iOS and Android can have DIFFERENT bundle identifiers
 */
const config: CapacitorConfig = {
  // Your Android package name (e.g., com.company.appname)
  // This serves as the default appId for both platforms, but iOS will be overridden in Xcode
  appId: "com.example.myapp",

  // Display name shown under the app icon
  appName: "My App",

  // Directory containing your built web app (or placeholder for remote URL)
  webDir: "out",

  server: {
    // Your hosted web app URL
    url: "https://myapp.example.com",

    // Domains the WebView is allowed to navigate to
    allowNavigation: [
      "myapp.example.com",
      "*.myapp.example.com",
      "*.supabase.co", // If using Supabase
    ],

    // HTTPS only
    cleartext: false,

    // Show this page when offline
    errorPath: "error.html",
  },

  // iOS-specific settings
  ios: {
    // How content adjusts for notch/status bar
    contentInset: "automatic",

    // Allow link previews (3D Touch)
    allowsLinkPreview: true,

    // Enable scrolling
    scrollEnabled: true,

    // Background color while loading
    backgroundColor: "#000000",

    // Prefer mobile view
    preferredContentMode: "mobile",
  },

  // Android-specific settings
  android: {
    // Don't allow mixed HTTP/HTTPS content
    allowMixedContent: false,

    // Background color while loading
    backgroundColor: "#000000",
  },

  // Plugin configurations
  plugins: {
    // Splash screen settings
    SplashScreen: {
      // How long to show splash (ms)
      launchShowDuration: 2000,

      // Auto-hide after duration
      launchAutoHide: true,

      // Fade out animation duration (ms)
      launchFadeOutDuration: 500,

      // Splash background color
      backgroundColor: "#000000",

      // Show loading spinner
      showSpinner: true,

      // Spinner color (your accent color)
      spinnerColor: "#F59E0B",

      // Full screen splash (hide status bar)
      splashFullScreen: true,

      // Immersive mode (hide navigation bar too)
      splashImmersive: true,
    },

    // Status bar settings
    StatusBar: {
      // Light or dark icons
      style: "DARK",

      // Status bar background
      backgroundColor: "#000000",
    },
  },
};

export default config;
