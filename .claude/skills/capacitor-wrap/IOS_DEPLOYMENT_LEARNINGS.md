# iOS Deployment Learnings - January 2026

This document captures critical learnings from successful iOS deployment of the Carousel app using Codemagic CI/CD.

## Executive Summary

After resolving multiple code signing, build configuration, and asset issues, we successfully deployed an iOS app to App Store Connect. This document provides a roadmap to avoid the same pitfalls.

## Critical Issues Resolved

### 1. Code Signing Conflicts (HIGHEST PRIORITY)

**Problem:** Mixed automatic/manual signing caused "Cannot save Signing Certificates without certificate private key" errors.

**Root Cause:** Having `ios_signing` block in the workflow's `environment` section conflicts with manual `fetch-signing-files` commands.

**Solution:** Remove `ios_signing` block entirely.

```yaml
# BEFORE (Broken)
environment:
  ios_signing:
    distribution_type: app_store
    bundle_identifier: "ai.carouselcards.app"
  vars:
    BUNDLE_ID: "ai.carouselcards.app"

# AFTER (Working)
environment:
  vars:
    BUNDLE_ID: "ai.carouselcards.app"
  node: 22
  xcode: latest
```

**Reference:** https://github.com/orgs/codemagic-ci-cd/discussions/2280

---

### 2. Apple Certificate Limit

**Problem:** Apple limits each team to 2 distribution certificates. Generating new certificates on every build hits limit quickly.

**Solution:** Generate certificate private key once and reuse across all apps.

**Implementation:**

1. **Generate key locally (one time):**
   ```bash
   openssl genrsa -out cert_key.pem 2048
   cat cert_key.pem | base64
   ```

2. **Store in Codemagic:**
   - Team Settings > Environment Variables
   - Variable name: `FCI_CERTIFICATE_PRIVATE_KEY`
   - Value: Paste base64 output
   - Mark as secure

3. **Use in workflow:**
   ```yaml
   - name: Fetch signing files
     script: |
       set -exo pipefail
       CERT_KEY_PATH="$CM_BUILD_DIR/cert_key.pem"

       if [ -n "${FCI_CERTIFICATE_PRIVATE_KEY:-}" ]; then
         echo "$FCI_CERTIFICATE_PRIVATE_KEY" | base64 -d > "$CERT_KEY_PATH"
       else
         openssl genrsa -out "$CERT_KEY_PATH" 2048
         echo "⚠️ SAVE THIS AS FCI_CERTIFICATE_PRIVATE_KEY:"
         cat "$CERT_KEY_PATH" | base64
       fi

       app-store-connect fetch-signing-files "$BUNDLE_ID" \
         --type IOS_APP_STORE \
         --create \
         --certificate-key=@file:"$CERT_KEY_PATH"
   ```

**Key Points:**
- One certificate works for ALL apps under your Apple Developer team
- Only provisioning profiles are app-specific
- Must use `@file:` syntax, NOT `@env:`
- Store at team level for reuse across projects

---

### 3. Build Number Conflicts

**Problem:** App Store Connect rejected uploads with error:
```
The provided entity includes an attribute with a value that has already been used
```

**Cause:** Reusing the same build number (CFBundleVersion) across multiple uploads.

**Solution:** Use timestamp-based build numbers for automatic uniqueness.

```yaml
- name: Set bundle version
  script: |
    cd ios/App
    BUILD_NUMBER=$(date +%Y%m%d%H%M%S)
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" App/Info.plist
    agvtool new-version -all "$BUILD_NUMBER"
```

**Format:** `20260113143052` = January 13, 2026 at 14:30:52

**Benefits:**
- Always unique (unless builds run in same second, which is impossible on CI)
- Sortable chronologically
- No manual version management needed

---

### 4. App Icon Asset Catalog Requirements

**Problem:** Xcode error:
```
The app icon set "AppIcon" has 1 unassigned child
An app icon set must have exactly one "1024x1024" image for the "Any Appearance" image well
```

**Cause:** Incorrect metadata in `ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json`

**Solution:** Ensure 1024x1024 icon has correct idiom:

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

**Critical Requirements:**
- Must use `"idiom": "ios-marketing"` (NOT `"platform": "ios"`)
- File must be exactly 1024x1024 pixels PNG
- Required for "Any Appearance" image well
- No other platform keys should be present

**Verification Commands:**
```bash
# Check image size
file ios/App/App/Assets.xcassets/AppIcon.appiconset/1024.png

# Check Contents.json format
cat ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json | jq '.images[] | select(.size == "1024x1024")'
```

---

### 5. RevenueCat Capacitor 8 Compatibility

**Problem:** RevenueCat UI package installation failed with peer dependency error:
```
@revenuecat/purchases-capacitor-ui requires capacitor@^7.0.0
```

**Cause:** RevenueCat UI package only supports Capacitor 7, not Capacitor 8.

**Solution:** Use base package only, not UI package.

```bash
# CORRECT (Capacitor 8)
npm install @revenuecat/purchases-capacitor@12.0.3

# WRONG (Capacitor 7 only)
npm install @revenuecat/purchases-capacitor-ui
```

**Version Compatibility:**
- `@revenuecat/purchases-capacitor@12.0.3+` → Capacitor 8
- `@revenuecat/purchases-capacitor@11.x.x` → Capacitor 7
- `@revenuecat/purchases-capacitor-ui` → Capacitor 7 only (no Capacitor 8 version)

---

### 6. Xcode Project Manual Signing Configuration

**Problem:** Code signing errors in CI despite correct workflow configuration.

**Cause:** Xcode project configured for automatic signing.

**Solution:** Set manual signing in Xcode project settings.

**Via Xcode GUI:**
1. Open `ios/App/App.xcodeproj`
2. Select App target
3. Go to Signing & Capabilities tab
4. Uncheck "Automatically manage signing"
5. Set Team to your Apple Developer team

**Verify in project.pbxproj:**
```
CODE_SIGN_STYLE = Manual;
DEVELOPMENT_TEAM = YOUR_TEAM_ID;
```

Both Debug and Release configurations need these settings.

---

### 7. Auto-Submit Failures Without Metadata

**Problem:** When `submit_to_app_store: true` is enabled, builds fail with metadata errors even though the IPA uploaded successfully.

**Error:**
```
Creating Review Submission Item failed. Please ensure that App Store Version
Localization for your application default locale defines uses non exempt encryption

Associated error: The provided entity is missing a required attribute - You must
provide a value for the attribute 'usesNonExemptEncryption'
```

**Cause:** Codemagic attempts to automatically submit the app for review, but this requires all app metadata to be filled in:
- App description and screenshots
- Encryption declaration (`usesNonExemptEncryption`)
- Privacy policy URL
- Support URL
- Age rating

**Solution:** Use upload-only mode and submit manually.

```yaml
publishing:
  app_store_connect:
    auth: integration
    submit_to_app_store: false  # Upload only
```

**Why Upload-Only is Better:**
- ✅ Builds show as successful (not "failed" due to missing metadata)
- ✅ You control when to submit for review
- ✅ Fill in screenshots and descriptions at your own pace
- ✅ Update metadata between builds without workflow changes
- ✅ Standard workflow used by most developers

**Manual Submission Steps:**
1. Build completes → IPA uploaded to App Store Connect
2. Go to https://appstoreconnect.apple.com
3. Navigate to your app → Find the new build
4. Fill in required metadata (first time only, then just update as needed)
5. Click "Submit for Review" when ready

**When to Use Auto-Submit:**
Only use `submit_to_app_store: true` if:
- All app metadata is already configured and stable
- You rarely change screenshots or descriptions
- You want fully automated submissions (rare in practice)

---

## Complete Working Workflow

This is the battle-tested workflow configuration that incorporates all fixes:

```yaml
workflows:
  ios-release:
    name: iOS App Store Release
    instance_type: mac_mini_m2
    max_build_duration: 60
    integrations:
      app_store_connect: "Your ASC Integration Name"  # Must match exactly!
    environment:
      # ⚠️ NO ios_signing block - causes conflicts
      vars:
        BUNDLE_ID: "ai.carouselcards.app"
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

          # Reuse stored certificate
          if [ -n "${FCI_CERTIFICATE_PRIVATE_KEY:-}" ]; then
            echo "$FCI_CERTIFICATE_PRIVATE_KEY" | base64 -d > "$CERT_KEY_PATH"
          else
            openssl genrsa -out "$CERT_KEY_PATH" 2048
            echo "⚠️ SAVE THIS AS FCI_CERTIFICATE_PRIVATE_KEY:"
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
          xcode-project export-ipa --archive build/App.xcarchive

    artifacts:
      - ios/App/build/**/*.ipa
      - ios/App/build/**/*.xcarchive

    publishing:
      app_store_connect:
        auth: integration
        # Upload only - manual submission after metadata entry
        submit_to_app_store: false
```

---

## One-Time Setup Checklist

Before your first build, complete these steps:

### Apple Developer Portal
- [ ] Register bundle ID (e.g., `ai.carouselcards.app`)
- [ ] Enable required capabilities (if any)
- [ ] Create app in App Store Connect

### App Store Connect API
- [ ] Create API key with **Admin** access
- [ ] Download .p8 file
- [ ] Note Key ID and Issuer ID

### Codemagic Setup
- [ ] Add App Store Connect integration
  - Teams > Integrations > App Store Connect
  - Upload .p8 file
  - Enter Key ID and Issuer ID
  - Give it a name (use in workflow)
- [ ] Generate and store certificate key
  ```bash
  openssl genrsa -out cert_key.pem 2048
  cat cert_key.pem | base64
  ```
- [ ] Add to team environment variables
  - Variable: `FCI_CERTIFICATE_PRIVATE_KEY`
  - Value: base64 output
  - Mark as secure

### Xcode Project
- [ ] Set `CODE_SIGN_STYLE = Manual` in both Debug and Release
- [ ] Set `DEVELOPMENT_TEAM` to your team ID
- [ ] Verify 1024x1024 icon in asset catalog
- [ ] Check icon Contents.json has `"idiom": "ios-marketing"`

### Repository
- [ ] Create `codemagic.yaml` using template above
- [ ] Update bundle ID in workflow
- [ ] Update integration name to match Codemagic
- [ ] Commit and push to trigger build

---

## Common Error Messages and Solutions

### "Cannot save Signing Certificates without certificate private key"
→ Remove `ios_signing` block from environment section

### "provided entity includes an attribute with a value that has already been used"
→ Implement timestamp-based build numbers

### "The app icon set has 1 unassigned child"
→ Fix 1024x1024 icon idiom to `ios-marketing`

### "No matching profiles found"
→ Ensure bundle ID is registered and remove `ios_signing` block

### "unbound variable: FCI_CERTIFICATE_PRIVATE_KEY"
→ Use `${VAR:-}` syntax or remove `-u` from set command

### "@revenuecat/purchases-capacitor-ui requires capacitor@^7.0.0"
→ Use base package only: `@revenuecat/purchases-capacitor@12.0.3`

---

## Timeline of Fixes

This deployment required 5 major iterations:

1. **Initial attempt** - Failed on mixed signing (ios_signing block conflict)
2. **Second attempt** - Failed on certificate limit (generating new certs each time)
3. **Third attempt** - Failed on build number conflict (reusing same number)
4. **Fourth attempt** - Failed on app icon requirements (wrong idiom)
5. **Fifth attempt** - Success! All issues resolved

**Time saved for next deployment:** ~3-4 hours of debugging by following this guide.

---

## Key Takeaways

1. **Never use `ios_signing` block** when doing manual signing with `fetch-signing-files`
2. **One certificate per team** - Generate once, reuse forever
3. **Timestamp build numbers** - Simple, automatic, always unique
4. **Asset catalog metadata matters** - iOS is strict about icon format
5. **Capacitor 8 broke RevenueCat UI** - Use base package only
6. **Manual signing required on CI** - Set in Xcode project settings

---

## References

- [Codemagic Code Signing Discussion #2280](https://github.com/orgs/codemagic-ci-cd/discussions/2280)
- [Codemagic iOS Signing Docs](https://docs.codemagic.io/yaml-code-signing/signing-ios/)
- [Apple Developer: Code Signing](https://developer.apple.com/support/code-signing/)
- [Capacitor 8 iOS Guide](https://capacitorjs.com/docs/ios)

---

## Document History

| Date | Description |
|------|-------------|
| 2026-01-13 | Initial document created after successful Carousel iOS deployment |

---

**Status:** Active - Use as reference for all future iOS deployments with Codemagic.
