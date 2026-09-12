# iOS Deployment Troubleshooting Guide

This guide documents solutions to common issues encountered during iOS deployment with Codemagic CI/CD.

**Last Updated:** January 13, 2026

## Table of Contents

1. [Code Signing Issues](#code-signing-issues)
2. [Build Number Conflicts](#build-number-conflicts)
3. [App Icon Requirements](#app-icon-requirements)
4. [RevenueCat Integration](#revenuecat-integration)
5. [Workflow Configuration](#workflow-configuration)
6. [Common Errors](#common-errors-and-solutions)

---

## Code Signing Issues

### Issue 1: Mixed Automatic/Manual Signing Conflict

**Error:**
```
Error: Cannot save Signing Certificates without certificate private key
```

**Cause:** Having `ios_signing` block in the `environment` section conflicts with manual `fetch-signing-files` commands.

**Solution:** Remove the `ios_signing` block entirely from your workflow.

```yaml
# WRONG - This causes conflicts
environment:
  ios_signing:
    distribution_type: app_store
    bundle_identifier: "com.yourapp.ios"

# CORRECT - Use manual signing via scripts
environment:
  vars:
    BUNDLE_ID: "com.yourapp.ios"
  node: 22
  xcode: latest
```

**Reference:** https://github.com/orgs/codemagic-ci-cd/discussions/2280

### Issue 2: Certificate Limit (2 per Team)

**Problem:** Apple limits each developer team to 2 distribution certificates. Generating new certificates on every build quickly hits this limit.

**Solution:** Store and reuse the certificate private key across all builds and apps.

#### Step-by-Step:

1. **Generate certificate private key once:**
   ```bash
   openssl genrsa -out cert_key.pem 2048
   ```

2. **Encode it for storage:**
   ```bash
   cat cert_key.pem | base64
   ```

3. **Add to Codemagic environment variables:**
   - Go to your team settings in Codemagic
   - Add variable: `FCI_CERTIFICATE_PRIVATE_KEY`
   - Paste the base64-encoded key
   - Set as secure variable

4. **Use in workflow:**
   ```yaml
   - name: Fetch signing files
     script: |
       set -exo pipefail
       CERT_KEY_PATH="$CM_BUILD_DIR/cert_key.pem"

       # Reuse stored certificate or generate new one
       if [ -n "${FCI_CERTIFICATE_PRIVATE_KEY:-}" ]; then
         echo "$FCI_CERTIFICATE_PRIVATE_KEY" | base64 -d > "$CERT_KEY_PATH"
       else
         openssl genrsa -out "$CERT_KEY_PATH" 2048
         echo "Save this as FCI_CERTIFICATE_PRIVATE_KEY:"
         cat "$CERT_KEY_PATH" | base64
       fi

       app-store-connect fetch-signing-files "$BUNDLE_ID" \
         --type IOS_APP_STORE \
         --create \
         --certificate-key=@file:"$CERT_KEY_PATH"
   ```

**Key Points:**
- One certificate works for ALL apps under your team
- Only provisioning profiles are app-specific
- Certificate private key must use `@file:` syntax, NOT `@env:`
- Store the key at team level, not project level

### Issue 3: Certificate Private Key Format

**Error:**
```
Error reading private key from environment variable
```

**Cause:** Using `@env:` syntax instead of `@file:` for the certificate key.

**Solution:**
```bash
# WRONG
--certificate-key=@env:FCI_CERTIFICATE_PRIVATE_KEY

# CORRECT
# First decode to file
echo "$FCI_CERTIFICATE_PRIVATE_KEY" | base64 -d > "$CERT_KEY_PATH"
# Then reference the file
--certificate-key=@file:"$CERT_KEY_PATH"
```

### Issue 4: Xcode Project Requirements

**Error:**
```
Code signing is required for product type 'Application' in SDK 'iOS'
```

**Cause:** Xcode project not configured for manual signing.

**Solution:** Ensure these settings in `ios/App/App.xcodeproj/project.pbxproj`:

```
CODE_SIGN_STYLE = Manual;
DEVELOPMENT_TEAM = [Your Team ID];
```

Both Debug and Release configurations need these settings. You can't use Automatic signing on CI.

**To set via Xcode:**
1. Open `ios/App/App.xcodeproj`
2. Select the App target
3. Go to Signing & Capabilities
4. Uncheck "Automatically manage signing"
5. Set Team to your Apple Developer team

---

## Build Number Conflicts

### Issue: Duplicate Build Numbers

**Error in App Store Connect:**
```
The provided entity includes an attribute with a value that has already been used
```

**Cause:** Using the same build number (CFBundleVersion) for multiple uploads. App Store Connect requires unique build numbers even if the version number (CFBundleShortVersionString) is the same.

**Solution:** Use timestamp-based build numbers.

```yaml
- name: Set bundle version
  script: |
    cd ios/App
    BUILD_NUMBER=$(date +%Y%m%d%H%M%S)
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" App/Info.plist
    agvtool new-version -all "$BUILD_NUMBER"
```

**Build Number Format:**
- `20260113143052` = January 13, 2026 at 14:30:52
- Always unique as long as builds don't run in the same second
- Automatically increments with each build

**Alternative:** Use Codemagic's build number:
```yaml
BUILD_NUMBER=$((BUILD_NUMBER + 1))
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" App/Info.plist
```

---

## App Icon Requirements

### Issue: Missing 1024x1024 Icon

**Error in Xcode:**
```
The app icon set "AppIcon" has 1 unassigned child
An app icon set must have exactly one "1024x1024" image for the "Any Appearance" image well
```

**Cause:** The 1024x1024 icon in your asset catalog has incorrect metadata in `Contents.json`.

**Solution:** Update `ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json`:

```json
{
  "images": [
    {
      "filename": "1024.png",
      "idiom": "ios-marketing",
      "scale": "1x",
      "size": "1024x1024"
    }
  ],
  "info": {
    "author": "xcode",
    "version": 1
  }
}
```

**Key Requirements:**
- Must have `"idiom": "ios-marketing"` (NOT `"platform": "ios"`)
- Must be exactly 1024x1024 pixels
- Must be PNG format
- Must have scale "1x" and size "1024x1024"

**Verification:**
```bash
# Check image dimensions
file ios/App/App/Assets.xcassets/AppIcon.appiconset/1024.png
# Should show: PNG image data, 1024 x 1024

# Check Contents.json
cat ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json | grep -A3 "1024x1024"
```

---

## RevenueCat Integration

### Issue: Capacitor 8 Compatibility

**Error:**
```
@revenuecat/purchases-capacitor-ui@X.X.X requires capacitor@^7.0.0 but found capacitor@8.0.0
```

**Cause:** The RevenueCat UI package only supports Capacitor 7.

**Solution:** Use only the base package, NOT the UI package.

```bash
# CORRECT - Compatible with Capacitor 8
npm install @revenuecat/purchases-capacitor@12.0.3

# WRONG - NOT compatible with Capacitor 8
npm install @revenuecat/purchases-capacitor-ui
```

**Compatible Versions:**
- `@revenuecat/purchases-capacitor@12.0.3` or later = Capacitor 8 support
- `@revenuecat/purchases-capacitor@11.x.x` or earlier = Capacitor 7 only

**Migration from UI Package:**

If you already have the UI package installed:

```bash
# Remove the incompatible package
npm uninstall @revenuecat/purchases-capacitor-ui

# Install the base package
npm install @revenuecat/purchases-capacitor@12.0.3

# Update imports in your code
# OLD: import { Purchases } from '@revenuecat/purchases-capacitor-ui';
# NEW: import { Purchases } from '@revenuecat/purchases-capacitor';
```

---

## Workflow Configuration

### Complete Working Workflow

Here's a proven workflow configuration that avoids all common pitfalls:

```yaml
workflows:
  ios-release:
    name: iOS App Store Release
    instance_type: mac_mini_m2
    max_build_duration: 60
    integrations:
      app_store_connect: "Your Integration Name"  # Must match exactly!
    environment:
      # NO ios_signing block - causes conflicts with manual signing
      vars:
        BUNDLE_ID: "com.yourapp.ios"
        VITE_REVENUECAT_IOS_API_KEY: $REVENUECAT_IOS_API_KEY
      node: 22  # Capacitor 8 requires Node 22
      xcode: latest
    scripts:
      - name: Install dependencies
        script: npm ci

      - name: Fetch signing files
        script: |
          set -exo pipefail
          CERT_KEY_PATH="$CM_BUILD_DIR/cert_key.pem"

          # Reuse stored certificate or generate new one
          if [ -n "${FCI_CERTIFICATE_PRIVATE_KEY:-}" ]; then
            echo "$FCI_CERTIFICATE_PRIVATE_KEY" | base64 -d > "$CERT_KEY_PATH"
          else
            openssl genrsa -out "$CERT_KEY_PATH" 2048
            echo "⚠️ SAVE THIS AS FCI_CERTIFICATE_PRIVATE_KEY ENVIRONMENT VARIABLE:"
            cat "$CERT_KEY_PATH" | base64
          fi

          app-store-connect fetch-signing-files "$BUNDLE_ID" \
            --type IOS_APP_STORE \
            --create \
            --certificate-key=@file:"$CERT_KEY_PATH"

      - name: Set up keychain
        script: |
          keychain initialize
          keychain add-certificates
          xcode-project use-profiles

      - name: Set bundle version
        script: |
          cd ios/App
          BUILD_NUMBER=$(date +%Y%m%d%H%M%S)
          /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" App/Info.plist
          agvtool new-version -all "$BUILD_NUMBER"

      - name: Resolve SPM dependencies
        script: |
          cd ios/App
          xcodebuild -resolvePackageDependencies -project App.xcodeproj -scheme App

      - name: Build app
        script: |
          cd ios/App
          xcodebuild \
            -project App.xcodeproj \
            -scheme App \
            -configuration Release \
            -archivePath build/App.xcarchive \
            archive \
            CODE_SIGN_STYLE=Manual

      - name: Export IPA
        script: |
          cd ios/App
          xcode-project export-ipa \
            --archive build/App.xcarchive

    artifacts:
      - ios/App/build/**/*.ipa
      - ios/App/build/**/*.xcarchive

    publishing:
      app_store_connect:
        auth: integration
        # Upload only - manual submission after metadata
        submit_to_app_store: false
```

### Key Configuration Points

1. **Integration Name Must Match Exactly**
   - The value in `integrations.app_store_connect` must match your Codemagic integration name character-for-character
   - Check: Teams > Integrations > App Store Connect

2. **No ios_signing Block**
   - Don't use automatic signing in environment
   - Use manual `fetch-signing-files` instead

3. **Node 22 Required**
   - Capacitor 8 requires Node 22+
   - Older versions will fail with dependency errors

4. **Resolve SPM Dependencies**
   - Must run BEFORE building
   - Capacitor 8 uses Swift Package Manager, not CocoaPods

5. **Use .xcodeproj, NOT .xcworkspace**
   - Capacitor 8 no longer uses CocoaPods
   - Always reference `App.xcodeproj`

---

## Common Errors and Solutions

### Error: "unbound variable"

**Full Error:**
```
bash: line X: FCI_CERTIFICATE_PRIVATE_KEY: unbound variable
```

**Cause:** Using `set -u` flag (exit on unset variables) without checking if variable exists.

**Solution:**
```bash
# WRONG
echo "$FCI_CERTIFICATE_PRIVATE_KEY" | base64 -d > file.pem

# CORRECT - Use parameter expansion with default
if [ -n "${FCI_CERTIFICATE_PRIVATE_KEY:-}" ]; then
  echo "$FCI_CERTIFICATE_PRIVATE_KEY" | base64 -d > file.pem
fi

# Or remove -u flag from set command
set -exo pipefail  # Instead of set -exuo pipefail
```

### Error: "No matching profiles found"

**Cause:** The `ios_signing` block in environment conflicts with manual profile fetching.

**Solution:** Remove `ios_signing` block entirely. See [Issue 1](#issue-1-mixedautomaticmanual-signing-conflict).

### Error: "Cannot create certificate without private key"

**Cause:** Certificate private key not provided or in wrong format.

**Solution:** Follow [Issue 2](#issue-2-certificate-limit-2-per-team) for proper key storage and usage.

### Error: "provided entity includes an attribute with a value that has already been used"

**Cause:** Duplicate build number.

**Solution:** Use timestamp-based build numbers. See [Build Number Conflicts](#build-number-conflicts).

### Error: "The app icon set has 1 unassigned child"

**Cause:** Missing or misconfigured 1024x1024 icon.

**Solution:** See [App Icon Requirements](#app-icon-requirements).

### Error: "missing required attribute 'usesNonExemptEncryption'"

**Full Error:**
```
Creating Review Submission Item failed. Please ensure that App Store Version
Localization for your application default locale defines uses non exempt encryption
```

**Cause:** Auto-submit enabled (`submit_to_app_store: true`) but app metadata is incomplete.

**Solution:** Use upload-only mode:
```yaml
publishing:
  app_store_connect:
    auth: integration
    submit_to_app_store: false
```

Then manually submit through App Store Connect after filling in:
- App description and screenshots
- Encryption declaration
- Privacy policy URL
- Support URL

**Why This Happens:**
Auto-submit tries to send your app for review immediately, but App Store Connect requires all metadata fields to be filled in first. Upload-only mode gives you control over when to submit.

---

## One-Time Setup Required

For successful iOS deployment, complete these one-time setup steps:

### 1. Create App Store Connect API Key

1. Go to App Store Connect > Users and Access > Integrations
2. Click the + next to "App Store Connect API"
3. Set Access: **Admin** (required for creating certificates/profiles)
4. Download the `.p8` file
5. Note the Key ID and Issuer ID

### 2. Add Integration to Codemagic

1. Go to Codemagic Teams > Integrations > App Store Connect
2. Click "Add integration"
3. Upload the `.p8` file
4. Enter Key ID and Issuer ID
5. Give it a memorable name (e.g., "My Company ASC")
6. Save

### 3. Register Bundle ID

1. Go to Apple Developer Portal > Certificates, Identifiers & Profiles
2. Click Identifiers > +
3. Select "App IDs" > "App"
4. Enter Bundle ID (e.g., `com.yourcompany.appname`)
5. Enable any required capabilities
6. Register

### 4. Generate and Store Certificate Key

1. Run once locally:
   ```bash
   openssl genrsa -out cert_key.pem 2048
   cat cert_key.pem | base64
   ```

2. In Codemagic:
   - Go to Teams > [Your Team] > Environment variables
   - Add variable: `FCI_CERTIFICATE_PRIVATE_KEY`
   - Paste the base64 output
   - Mark as secure
   - Save

### 5. First Build Configuration

1. Create `codemagic.yaml` in your repo root
2. Use the [Complete Working Workflow](#complete-working-workflow) template
3. Update:
   - `integrations.app_store_connect`: Your integration name
   - `BUNDLE_ID`: Your app's bundle identifier
   - Any app-specific environment variables
4. Commit and push

### 6. Trigger First Build

1. Push to main branch (or configured branch)
2. Codemagic will automatically detect and run
3. First build will take longer (15-20 minutes)
4. Check logs for any issues

---

## Verification Checklist

Before pushing a build, verify:

- [ ] Bundle ID registered in Apple Developer Portal
- [ ] App created in App Store Connect
- [ ] App Store Connect API key added to Codemagic
- [ ] Integration name in `codemagic.yaml` matches exactly
- [ ] `FCI_CERTIFICATE_PRIVATE_KEY` stored in team environment variables
- [ ] All agreements accepted in App Store Connect
- [ ] 1024x1024 icon exists and has correct `Contents.json`
- [ ] `CODE_SIGN_STYLE = Manual` in Xcode project
- [ ] Node 22+ configured in workflow
- [ ] RevenueCat using base package only (not UI)
- [ ] No `ios_signing` block in environment section

---

## Getting Help

If you encounter issues not covered here:

1. **Check Codemagic Logs:**
   - Build logs show exact error messages
   - Look for "Error:" or "failed" lines
   - Expand collapsed sections for full output

2. **Codemagic Documentation:**
   - https://docs.codemagic.io/yaml-code-signing/signing-ios/
   - https://docs.codemagic.io/knowledge-base/

3. **Codemagic Discussions:**
   - https://github.com/orgs/codemagic-ci-cd/discussions
   - Search for error messages

4. **Apple Developer Forums:**
   - https://developer.apple.com/forums/
   - For App Store Connect issues

---

## Success Indicators

You'll know your setup is correct when:

1. ✅ Build completes without code signing errors
2. ✅ IPA is generated in artifacts
3. ✅ Upload to App Store Connect succeeds
4. ✅ Build appears in TestFlight or ready for review
5. ✅ No certificate limit warnings
6. ✅ Subsequent builds use cached certificate

**Typical successful build time:** 10-15 minutes

---

## Additional Resources

- [Codemagic iOS Code Signing Guide](https://docs.codemagic.io/yaml-code-signing/signing-ios/)
- [Apple Developer: Creating Signing Certificates](https://developer.apple.com/help/account/create-certificates/create-developer-id-certificates)
- [Capacitor 8 iOS Documentation](https://capacitorjs.com/docs/ios)
- [RevenueCat Capacitor SDK](https://www.revenuecat.com/docs/capacitor)
