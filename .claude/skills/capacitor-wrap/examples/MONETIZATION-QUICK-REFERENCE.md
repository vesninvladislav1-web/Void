# Monetization Quick Reference Card

One-page cheat sheet for setting up in-app purchases with RevenueCat.

---

## Dashboard URLs

| Service | URL | Purpose |
|---------|-----|---------|
| **RevenueCat** | https://app.revenuecat.com | Monetization platform (start here) |
| **App Store Connect** | https://appstoreconnect.apple.com | iOS IAP setup |
| **Google Play Console** | https://play.google.com/console | Android IAP setup |
| **Google Cloud Console** | https://console.cloud.google.com | Service account for RevenueCat |

---

## Quick Setup Flow

```
1. Code → Define product IDs (services/iap.ts)
2. RevenueCat → Create project + iOS/Android apps
3. App Store Connect → Create IAP products (iOS)
4. Google Play Console → Create IAP products (Android)
5. RevenueCat → Import products + create entitlements/offerings
6. Test → Sandbox (iOS) + License testing (Android)
```

---

## Product ID Naming Patterns

### Subscriptions
```
Pattern: {tier}_{period}

Examples:
  pro_monthly
  pro_yearly
  premium_monthly
  elite_quarterly
```

### Consumables
```
Pattern: credits_{amount} or tokens_{amount}

Examples:
  credits_50
  credits_200
  credits_500
  tokens_100
  coins_1000
```

---

## Recommended Pricing

| Product Type | Price Range | Notes |
|--------------|-------------|-------|
| **Monthly Sub** | $4.99 - $9.99 | Most common for consumer apps |
| **Yearly Sub** | $39.99 - $79.99 | 20-30% savings vs monthly |
| **Starter Pack** | $4.99 | Entry-level consumable |
| **Value Pack** | $14.99 | Most popular (middle tier) |
| **Best Value** | $29.99 | Highest value per unit |

---

## iOS App Store Connect

### Navigate to IAP
```
App Store Connect → My Apps → Your App → Features → In-App Purchases
```

### Create Subscription
1. Click **+ → Auto-Renewable Subscription**
2. Product ID: `pro_monthly` (match code!)
3. Select/Create subscription group: "Pro Subscription"
4. Duration: 1 month (or 1 year)
5. Price: $4.99 USD (add all territories)
6. Localization: Add English (U.S.) at minimum
7. Save → Submit for Review

### Create Consumable
1. Click **+ → Consumable**
2. Product ID: `credits_50` (match code!)
3. Price: $4.99 USD
4. Localization: Add English (U.S.)
5. Save → Submit for Review

### Get Shared Secret
```
My Apps → Your App → App Store tab → App Information
→ Scroll to "App-Specific Shared Secret"
→ Generate → Copy to RevenueCat
```

---

## Google Play Console

### Navigate to IAP
```
Play Console → Your App → Monetize → Products
```

### Create Subscription
1. **Subscriptions** tab → **Create subscription**
2. Product ID: `pro_monthly` (match code!)
3. Name: Pro Monthly
4. Description: Unlimited features
5. Base plan ID: `monthly`
6. Billing period: 1 month
7. Price: $4.99 USD (auto-convert currencies)
8. Optional: Free trial (7 days recommended)
9. **Activate** (top right)

### Create Consumable
1. **In-app products** tab → **Create product**
2. Product ID: `credits_50` (match code!)
3. Name: 50 Credits
4. Description: Use for AI generations
5. Price: $4.99 USD
6. Status: **Active**
7. Save

### Get Service Account JSON
```
Play Console → Setup → API access
→ Link Google Cloud project
→ Create service account in Google Cloud Console
→ Download JSON key
→ Upload to RevenueCat
```

---

## RevenueCat Dashboard

### Create Project
```
Dashboard → New Project → Enter name
```

### Add Apps
```
Apps → Add App
→ iOS: Enter bundle ID (e.g., app.company.ios)
→ Android: Enter package name (e.g., com.company.app)
```

### Configure Integrations
```
iOS App → Apple App Store → Set up
→ Paste shared secret from App Store Connect

Android App → Google Play Store → Set up
→ Upload service account JSON
```

### Create Entitlements
```
Entitlements → New Entitlement
→ Identifier: "pro"
→ Description: "Pro features access"
```

### Create Products
```
Products → New Product
→ Product ID: pro_monthly (match code!)
→ Type: Subscription or Consumable
→ Store Product IDs:
   iOS: pro_monthly (from App Store Connect)
   Android: pro_monthly (from Google Play Console)
```

### Create Offerings
```
Offerings → New Offering
→ Identifier: "default"
→ Add packages:
   Package: $rc_monthly → Product: pro_monthly
   Package: $rc_annual → Product: pro_yearly
```

### Get API Keys
```
Settings → API Keys
→ Copy iOS Public SDK Key (appl_...)
→ Copy Android Public SDK Key (goog_...)
→ Add to .env:
   VITE_REVENUECAT_IOS_API_KEY=appl_xxx
   VITE_REVENUECAT_ANDROID_API_KEY=goog_xxx
```

---

## Testing

### iOS Sandbox Testing

**Setup:**
```
App Store Connect → Users and Access → Sandbox Testers
→ Create tester (unique email + password)

On Device:
Settings → App Store → Sign out
Install app → Purchase → Sign in with sandbox account
```

**Test Checklist:**
- [ ] Purchase subscription
- [ ] Purchase consumable
- [ ] Restore purchases
- [ ] Cancel subscription
- [ ] Check RevenueCat dashboard for events

### Android License Testing

**Setup:**
```
Play Console → Settings → License Testing
→ Add tester email (your Google account)
→ Test Licenses: "Respond normally"

Install app via internal testing or debug build
Sign in with Google account
Purchases are instant and free
```

**Test Checklist:**
- [ ] Purchase subscription
- [ ] Purchase consumable
- [ ] Restore purchases
- [ ] Cancel subscription
- [ ] Check RevenueCat dashboard for events

---

## Environment Variables

Add to `.env`:
```bash
VITE_REVENUECAT_IOS_API_KEY=appl_xxxxxxxxxxxxxxxxx
VITE_REVENUECAT_ANDROID_API_KEY=goog_xxxxxxxxxxxxxxxxx
```

Add to Codemagic (CI/CD):
```
Codemagic → App → Environment variables
→ Add both keys (mark as "Secure")
```

---

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| **Product not found** | Check product ID matches exactly (code, RevenueCat, stores) |
| **iOS: Products not loading** | Sign in with sandbox tester account, verify product approved |
| **Android: Products not loading** | Check product is **Activated** in Play Console |
| **Wrong API key** | Use iOS key for iOS, Android key for Android (separate!) |
| **Receipt validation fails** | Verify RevenueCat integration (shared secret or service account) |
| **Subscription not renewing** | Normal in sandbox - renewals are accelerated (5 min = 1 month) |

---

## Code Snippets

### Initialize RevenueCat
```typescript
import { Purchases } from '@revenuecat/purchases-capacitor';
import { Capacitor } from '@capacitor/core';

const apiKey = Capacitor.getPlatform() === 'ios'
  ? import.meta.env.VITE_REVENUECAT_IOS_API_KEY
  : import.meta.env.VITE_REVENUECAT_ANDROID_API_KEY;

await Purchases.configure({
  apiKey,
  appUserID: userId, // Optional: your user ID
});
```

### Get Offerings
```typescript
const { offerings } = await Purchases.getOfferings();
const monthlyPackage = offerings.current?.monthly;
const yearlyPackage = offerings.current?.annual;
```

### Purchase Package
```typescript
const { customerInfo } = await Purchases.purchasePackage({
  aPackage: monthlyPackage,
});

// Check entitlements
const hasPro = customerInfo.entitlements.active['pro'] !== undefined;
```

### Restore Purchases
```typescript
const { customerInfo } = await Purchases.restorePurchases();
```

---

## Checklist: Ready to Launch?

**Code:**
- [ ] Product IDs defined in code
- [ ] RevenueCat SDK installed
- [ ] API keys in environment variables
- [ ] Purchase flow implemented
- [ ] Restore purchases implemented

**iOS:**
- [ ] Bundle ID registered in Apple Developer Portal
- [ ] Products created in App Store Connect
- [ ] Products submitted for review
- [ ] Shared secret added to RevenueCat
- [ ] Tested with sandbox account

**Android:**
- [ ] Package name registered in Google Play Console
- [ ] Products created and **Activated**
- [ ] Service account JSON uploaded to RevenueCat
- [ ] Tested with license testing account

**RevenueCat:**
- [ ] iOS and Android apps added
- [ ] Products imported from stores
- [ ] Entitlements created
- [ ] Offerings created
- [ ] API keys copied to project
- [ ] Webhook configured (optional)

**Testing:**
- [ ] Sandbox purchases work (iOS)
- [ ] License testing purchases work (Android)
- [ ] Events appear in RevenueCat dashboard
- [ ] Database updates correctly
- [ ] Restore purchases works
- [ ] Subscription renewal tested

---

## Support Resources

| Resource | URL |
|----------|-----|
| **RevenueCat Docs** | https://www.revenuecat.com/docs |
| **RevenueCat Community** | https://community.revenuecat.com |
| **Apple IAP Guide** | https://developer.apple.com/in-app-purchase/ |
| **Google Play Billing** | https://developer.android.com/google/play/billing |
| **Capacitor Wrap Skill** | https://github.com/mrchevyceleb/capacitor-wrap-skill |

---

**Generated by Capacitor Wrap Skill v2.5**
