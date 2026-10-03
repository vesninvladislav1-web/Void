# Capacitor Wrap Skill for Claude Code - v2.4

**NEW in v2.4:** Optimized for non-technical users! Local builds are now the PRIMARY method. No CI/CD required.

# Capacitor Wrap Skill for Claude Code

A Claude Code skill that wraps any web app in Capacitor for iOS and Android app store deployment, with optional RevenueCat subscription integration.

## Features

## Features - v2.5: Full Monetization Support!

- **Monetization setup guide**: Comprehensive RevenueCat + app stores documentation (NEW in v2.5)
- **IAP configuration templates**: Product IDs, pricing, and code examples (NEW in v2.5)
- **Quick reference card**: One-page cheat sheet for monetization setup (NEW in v2.5)
- **Local builds PRIMARY**: Simple AAB/IPA generation without CI/CD complexity
- **Pre-written store content**: Auto-generated PLAY-STORE-LISTING.md
- **Kid-friendly upload guide**: UPLOAD-INSTRUCTIONS.md written for ages 10+
- **One-command setup**: Installs and configures Capacitor for any web app
- **Automated keystore generation**: Secure Android signing with auto-generated credentials
- **Icon generation**: Creates all required app store icon sizes from a single source
- **Screenshot automation**: Automated Playwright-based screenshot generation for iOS and Android
- **Feature graphic generator**: Automated creation of Android Play Store feature graphic (1024x500 REQUIRED)
- **RevenueCat integration**: Optional in-app subscription support
- **Cross-platform builds**: Works on Windows and macOS
- **CodeMagic CI/CD**: Optional advanced configuration (for experienced developers)
- **Store-ready**: Everything needed for app store submission

## Installation

### Option 1: Copy to your skills directory

```bash
# Clone this repo
git clone https://github.com/YOUR_USERNAME/capacitor-wrap-skill.git

# Copy to Claude Code skills directory
# Windows
copy capacitor-wrap-skill\SKILL.md %USERPROFILE%\.claude\skills\capacitor-wrap\

# macOS/Linux
cp capacitor-wrap-skill/SKILL.md ~/.claude/skills/capacitor-wrap/
```

### Option 2: Manual installation

1. Create the skill directory:
   ```bash
   mkdir -p ~/.claude/skills/capacitor-wrap
   ```

2. Copy `SKILL.md` to `~/.claude/skills/capacitor-wrap/SKILL.md`

## Usage

In Claude Code, simply describe what you want:

```
"Wrap my web app at https://myapp.com for the app stores"
```

Or invoke directly:
```
/capacitor-wrap
```

The skill will guide you through:
1. Gathering app details (name, iOS bundle ID, Android package name, colors)
2. Installing Capacitor dependencies
3. Generating icons and splash screens
4. **Automatically generating app store screenshots using Playwright** (NEW in v2.3)
5. Configuring native platforms with separate bundle identifiers
6. **Automatically generating Android keystore with secure passwords**
7. Setting up RevenueCat (optional)
8. Creating build configurations
9. Generating comprehensive store listing documentation and deployment guides

**Important**: The skill now properly handles separate bundle IDs for iOS and Android:
- iOS uses bundle ID (e.g., `app.company.appname` or `ai.carouselcards.app`)
- Android uses package name (e.g., `com.company.appname`)
- These identifiers are PERMANENT and cannot be changed after app store submission

## What Gets Created

| File | Purpose |
|------|---------|
| `capacitor.config.ts` | Main Capacitor configuration |
| `public/error.html` | Offline fallback page |
| `assets/*.png` | Source icons for generation |
| `lib/services/revenuecat.ts` | RevenueCat integration (optional) |
| `app/api/webhooks/revenuecat/route.ts` | Webhook handler (optional) |
| `codemagic.yaml` | iOS/Android CI/CD config |
| `docs/APP_STORE_GUIDE.md` | Store submission guide |
| `scripts/generate-app-icons.mjs` | Icon generation script |
| `scripts/generate-app-screenshots.mjs` | **NEW:** Automated screenshot generator |
| `scripts/generate-feature-graphic.mjs` | **NEW:** Android feature graphic generator (1024x500) |
| `screenshots/ios/*.png` | **NEW:** iOS App Store screenshots |
| `screenshots/android/phone/*.png` | **NEW:** Android phone screenshots (REQUIRED) |
| `screenshots/android/tablet-7/*.png` | **NEW:** Android 7" tablet screenshots (optional) |
| `screenshots/android/tablet-10/*.png` | **NEW:** Android 10" tablet screenshots (optional) |
| `screenshots/android/feature-graphic.png` | **NEW:** Android feature graphic (REQUIRED) |
| `android/` | Android native project |
| `android-signing/` | **Android signing folder** (DO NOT COMMIT) |
| `android-signing/*.keystore` | Auto-generated release signing key |
| `android-signing/CREDENTIALS.txt` | Auto-generated passwords and setup values |
| `android-signing/SETUP-INSTRUCTIONS.md` | Step-by-step Codemagic/Google Play guide |
| `examples/MONETIZATION-SETUP-TEMPLATE.md` | **NEW v2.5:** Complete monetization setup guide |
| `examples/MONETIZATION-QUICK-REFERENCE.md` | **NEW v2.5:** One-page monetization cheat sheet |
| `examples/iap-products-config.ts` | **NEW v2.5:** IAP products configuration template |
| `ios/` | iOS native project |

## Prerequisites

### For the skill to work:
- Node.js 22+ (Capacitor 8 requirement)
- An existing web app (hosted URL or PWA)
- App icon (at least 512x512 PNG)
- iOS bundle ID and Android package name (permanent identifiers)

### For Android builds:
- JDK 21 (Capacitor 8 requirement)
- Android Studio

### For iOS builds:
- **Option A**: macOS with Xcode 15+
- **Option B**: Codemagic account (free tier available)

## Build Commands

### Android Debug
```bash
cd android
./gradlew assembleDebug    # Windows: .\gradlew.bat assembleDebug
```

### Android Release (Signed for Play Store)

**Important**: The skill automatically generates a secure keystore and saves credentials to `android-signing/CREDENTIALS.txt`.

**Windows PowerShell:**
```powershell
# Get credentials from android-signing/CREDENTIALS.txt
$KEYSTORE_PATH = (Resolve-Path android-signing\myapp-release.keystore).Path
$env:MYAPP_KEYSTORE_PATH = $KEYSTORE_PATH
$env:MYAPP_KEYSTORE_PASSWORD = "your-password-from-credentials-file"
$env:MYAPP_KEY_ALIAS = "myapp"
$env:MYAPP_KEY_PASSWORD = "your-password-from-credentials-file"
cd android
.\gradlew.bat bundleRelease
```

**macOS/Linux/Git Bash:**
```bash
# Get credentials from android-signing/CREDENTIALS.txt
export MYAPP_KEYSTORE_PATH="$(pwd)/android-signing/myapp-release.keystore"
export MYAPP_KEYSTORE_PASSWORD="your-password-from-credentials-file"
export MYAPP_KEY_ALIAS="myapp"
export MYAPP_KEY_PASSWORD="your-password-from-credentials-file"
cd android
./gradlew bundleRelease
```

Output: `android/app/build/outputs/bundle/release/app-release.aab`

**New in v2.2**: The skill automatically:
- Generates a cryptographically secure 32-character password
- Creates the keystore non-interactively (no manual prompts!)
- Saves all credentials to `android-signing/CREDENTIALS.txt`
- Creates `android-signing/SETUP-INSTRUCTIONS.md` with step-by-step Codemagic and Google Play setup
- Provides ready-to-paste values for CI/CD configuration

> **Security Note**: The `android-signing/` folder contains everything needed to sign your app. Back it up securely and never commit it to git!

### iOS (macOS)
```bash
npx cap open ios
# Build in Xcode: Product > Archive
```

### iOS (Codemagic)
Push to your repo's main branch - Codemagic builds automatically.

## Screenshot Generation (NEW in v2.3)

The skill now includes automated screenshot generation for both iOS and Android app stores using Playwright.

### Quick Start

```bash
# Install Playwright
npm install -D playwright
npx playwright install chromium

# Start your app
npm run dev

# Generate screenshots (in another terminal)
node scripts/generate-app-screenshots.mjs
```

### What Gets Generated

**iOS Screenshots:**
- 6.9" iPhone (1320x2868) - **Mandatory for 2026**
- 6.7" iPhone (1290x2796)
- 6.5" iPhone (1242x2688)
- 5.5" iPhone (1242x2208)
- 13" iPad Pro (2064x2752) - **Mandatory for 2026**
- 12.9" iPad Pro (2048x2732)

**Android Screenshots:**
- Phone portrait: 1080x1920 (recommended), 1440x2560 - saved to `screenshots/android/phone/`
- Tablet 7": 1200x1920 - saved to `screenshots/android/tablet-7/` (optional)
- Tablet 10": 1600x2560 - saved to `screenshots/android/tablet-10/` (optional)

### Customization

Edit `scripts/generate-app-screenshots.mjs` to customize:
- App URL (local or production)
- Screenshot scenarios (which screens to capture)
- Custom actions before screenshots (e.g., click buttons, fill forms)
- Wait times and selectors

Example scenario configuration:
```javascript
scenarios: [
  {
    name: 'home',
    description: 'Home Screen',
    path: '/',
    waitForSelector: '.main-content',
  },
  {
    name: 'feature',
    description: 'Key Feature',
    path: '/feature',
    waitForSelector: '.feature-container',
    actions: async (page) => {
      await page.click('#demo-button');
      await page.waitForTimeout(1000);
    }
  }
]
```

### App Store Requirements

**Apple App Store (2026):**
- Mandatory: 6.9" iPhone + 13" iPad Pro
- 1-10 screenshots per device size
- PNG or JPEG, 72 DPI, no transparency

**Google Play Store:**
- Phone screenshots (REQUIRED): Minimum 2, maximum 8 (1080x1920 recommended)
- Feature graphic (REQUIRED): 1024 x 500 px banner
- Tablet screenshots (OPTIONAL): 7" and 10" tablet sizes
- Format: PNG or JPEG, max 8MB per screenshot, max 15MB for feature graphic

### Feature Graphic Generation (NEW in v2.4)

Android Play Store REQUIRES a 1024 x 500 px feature graphic. Generate it automatically:

```bash
# Generate feature graphic
node scripts/generate-feature-graphic.mjs
```

Edit `scripts/generate-feature-graphic.mjs` to customize:
- App name and tagline
- Brand colors for gradient
- Logo path

Output: `screenshots/android/feature-graphic.png`

## Monetization Setup (NEW in v2.5)

The skill now includes comprehensive monetization documentation to help you set up in-app purchases and subscriptions.

### What's Included

**Documentation:**
- **MONETIZATION-SETUP-TEMPLATE.md** - Complete step-by-step guide covering:
  - Product configuration in code
  - RevenueCat account and app setup
  - iOS App Store Connect configuration
  - Google Play Console configuration
  - Testing procedures
  - Common pitfalls and solutions

- **MONETIZATION-QUICK-REFERENCE.md** - One-page cheat sheet with:
  - Dashboard URLs
  - Quick setup flow
  - Product ID naming patterns
  - Recommended pricing
  - Common issues and solutions

- **iap-products-config.ts** - Code template showing:
  - Product ID definitions
  - Product info structures
  - Helper functions
  - Usage examples

### Setup Overview

1. **Define products in code** - Subscriptions and consumables with consistent IDs
2. **Create RevenueCat account** - Add iOS and Android apps
3. **Configure App Store Connect** - Create in-app purchases (subscriptions/consumables)
4. **Configure Google Play Console** - Create products and activate them
5. **Set up RevenueCat** - Create entitlements, products, and offerings
6. **Get API keys** - Add to environment variables
7. **Test** - iOS sandbox and Android license testing

### Product Examples

Based on the Carousel app implementation:

**Subscriptions:**
- `pro_monthly` - $4.99/month
- `pro_yearly` - $39.99/year

**Consumables:**
- `credits_50` - $4.99
- `credits_200` - $14.99
- `credits_500` - $29.99

### Quick Start

```typescript
// Define products
export const IAP_PRODUCTS = {
  PRO_MONTHLY: 'pro_monthly',
  PRO_YEARLY: 'pro_yearly',
  CREDITS_50: 'credits_50',
} as const;

// Initialize RevenueCat
const apiKey = Platform.OS === 'ios'
  ? process.env.REVENUECAT_IOS_KEY
  : process.env.REVENUECAT_ANDROID_KEY;

await Purchases.configure({ apiKey, appUserID: userId });
```

See `examples/MONETIZATION-SETUP-TEMPLATE.md` for complete instructions.

## Store Listing

The skill generates a complete `APP_STORE_GUIDE.md` with:
- Copy-paste store listing text
- Screenshot requirements
- Icon specifications
- In-app purchase setup instructions
- Deep link configuration
- Submission checklists

## Triggers

The skill activates when you mention:
- "capacitor"
- "app store"
- "play store"
- "wrap web app"
- "native app"
- "ios app"
- "android app"
- "pwa to native"

## Example Conversation

**You:** "I want to publish my fitness web app https://fitpro.app to the app stores"

**Claude:** "I'll help you wrap FitPro in Capacitor for app store deployment. Let me ask a few questions..."

**Claude:** Creates all configuration, generates icons, sets up builds, and provides store submission guide.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Credits

Created for use with [Claude Code](https://claude.ai/code) by Anthropic.

## Troubleshooting

Encountering issues with iOS deployment? We've documented solutions from real-world deployment experience:

### Documentation

- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** - Comprehensive troubleshooting guide
  - Code signing conflicts and certificate management
  - Build number conflicts
  - App icon requirements
  - RevenueCat Capacitor 8 compatibility
  - Complete working workflow examples
  - Common error messages and solutions

- **[IOS_DEPLOYMENT_LEARNINGS.md](IOS_DEPLOYMENT_LEARNINGS.md)** - Real-world deployment learnings
  - Timeline of issues encountered and resolved
  - Battle-tested workflow configuration
  - One-time setup checklist
  - Key takeaways and best practices

### Quick Solutions

| Error | Solution |
|-------|----------|
| "Cannot save Signing Certificates" | Remove `ios_signing` block from environment section |
| Duplicate build numbers | Use timestamp-based build numbers |
| App icon errors | Verify 1024x1024 icon has `"idiom": "ios-marketing"` |
| RevenueCat compatibility | Use base package only (not UI package) |
| Certificate limit reached | Reuse certificate key via env var |

See the full guides for detailed explanations and complete solutions.

---

**Last Updated:** January 2026 (v2.5) - Added comprehensive monetization setup guide for RevenueCat and app stores, including IAP product configuration templates, complete store setup instructions, testing procedures, and pricing recommendations
