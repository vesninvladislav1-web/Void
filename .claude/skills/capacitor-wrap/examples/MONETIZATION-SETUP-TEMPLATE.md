# Monetization Setup Guide - RevenueCat + App Stores

This guide walks you through setting up in-app purchases (IAP) and subscriptions for your Capacitor-wrapped app using RevenueCat as the monetization platform.

**Why RevenueCat?**
- Single API for both iOS and Android
- Automatic receipt validation
- Subscription analytics and insights
- Webhook support for backend sync
- Free up to $2.5M in tracked revenue

---

## Table of Contents

1. [Product Configuration (Code)](#section-a-product-configuration-code)
2. [RevenueCat Setup](#section-b-revenuecat-setup)
3. [iOS App Store Connect Setup](#section-c-ios-app-store-connect-setup)
4. [Google Play Console Setup](#section-d-google-play-console-setup)
5. [Testing Checklist](#section-e-testing-checklist)
6. [Common Pitfalls](#common-pitfalls)

---

## Section A: Product Configuration (Code)

### Step 1: Define Your Product IDs

Create `services/iap.ts` (or `lib/services/iap.ts`) in your project:

```typescript
// Product IDs - must match EXACTLY across:
// 1. This code
// 2. RevenueCat dashboard
// 3. App Store Connect (iOS)
// 4. Google Play Console (Android)
export const IAP_PRODUCTS = {
  // Subscriptions
  PRO_MONTHLY: 'pro_monthly',
  PRO_YEARLY: 'pro_yearly',

  // Consumables (credits, tokens, coins)
  CREDITS_50: 'credits_50',
  CREDITS_200: 'credits_200',
  CREDITS_500: 'credits_500',
} as const;

export type IAPProductId = typeof IAP_PRODUCTS[keyof typeof IAP_PRODUCTS];

export interface IAPProduct {
  id: IAPProductId;
  title: string;
  description: string;
  price: string;
  type: 'subscription' | 'consumable';
  credits?: number; // For consumable products
}

// Product display information
export const PRODUCT_INFO: Record<IAPProductId, IAPProduct> = {
  [IAP_PRODUCTS.PRO_MONTHLY]: {
    id: IAP_PRODUCTS.PRO_MONTHLY,
    title: 'Pro Monthly',
    description: 'Unlimited AI generations & premium features',
    price: '$4.99/month',
    type: 'subscription',
  },
  [IAP_PRODUCTS.PRO_YEARLY]: {
    id: IAP_PRODUCTS.PRO_YEARLY,
    title: 'Pro Yearly',
    description: 'Unlimited AI generations & premium features',
    price: '$39.99/year',
    type: 'subscription',
  },
  [IAP_PRODUCTS.CREDITS_50]: {
    id: IAP_PRODUCTS.CREDITS_50,
    title: '50 Credits',
    description: 'Use for AI generations',
    price: '$4.99',
    type: 'consumable',
    credits: 50,
  },
  [IAP_PRODUCTS.CREDITS_200]: {
    id: IAP_PRODUCTS.CREDITS_200,
    title: '200 Credits',
    description: 'Best value for regular users',
    price: '$14.99',
    type: 'consumable',
    credits: 200,
  },
  [IAP_PRODUCTS.CREDITS_500]: {
    id: IAP_PRODUCTS.CREDITS_500,
    title: '500 Credits',
    description: 'Maximum savings for power users',
    price: '$29.99',
    type: 'consumable',
    credits: 500,
  },
};
```

### Step 2: Understand Product Types

**Subscriptions** (Auto-renewable):
- User charged automatically at regular intervals
- Access to premium features/content
- Can be monthly, yearly, quarterly
- Example: `pro_monthly`, `premium_yearly`

**Consumables** (One-time purchase):
- User purchases credits/tokens/coins
- Consumed through app usage
- Can be purchased multiple times
- Example: `credits_50`, `credits_200`

**Non-consumables** (Permanent unlock):
- One-time purchase, permanent unlock
- Cannot be purchased again
- Less common with RevenueCat pattern
- Example: `unlock_premium_templates`

### Step 3: Customize Product IDs

**Recommended Naming Patterns:**

**For Subscriptions:**
```typescript
// Pattern: {tier}_{period}
PRO_MONTHLY: 'pro_monthly'
PRO_YEARLY: 'pro_yearly'
PREMIUM_MONTHLY: 'premium_monthly'
ELITE_QUARTERLY: 'elite_quarterly'

// Alternative with app prefix:
MYAPP_PRO_MONTHLY: 'myapp_pro_monthly'
```

**For Consumables:**
```typescript
// Pattern: credits_{amount}
CREDITS_50: 'credits_50'
CREDITS_100: 'credits_100'
CREDITS_500: 'credits_500'

// Alternative patterns:
TOKENS_100: 'tokens_100'
COINS_500: 'coins_500'
```

### Step 4: Set Your Pricing

**Subscription Pricing Guidelines:**
- Monthly: $4.99 - $9.99 (most common)
- Yearly: $39.99 - $79.99 (save 20-30% vs monthly)
- Premium tier: $14.99 - $29.99/month

**Consumable Pricing Guidelines:**
- Starter pack: $4.99 (50-100 units)
- Value pack: $14.99 (200-300 units)
- Best value: $29.99 (500-1000 units)

**Pro Tip:** Offer 3 tiers to leverage the "goldilocks effect" - most users choose the middle option.

---

## Section B: RevenueCat Setup

### Step 1: Create RevenueCat Account

1. Go to [app.revenuecat.com](https://app.revenuecat.com)
2. Sign up (free for up to $2.5M tracked revenue)
3. Create a new project

### Step 2: Add iOS App

1. In RevenueCat dashboard → **Apps** → **Add App**
2. Select **iOS**
3. Enter your **iOS Bundle ID** (e.g., `app.carousel.ios` or `ai.carouselcards.app`)
4. App Name: Your app name
5. Click **Save**

### Step 3: Add Android App

1. **Apps** → **Add App**
2. Select **Android**
3. Enter your **Android Package Name** (e.g., `com.company.appname`)
4. App Name: Your app name
5. Click **Save**

**IMPORTANT:** iOS and Android apps are configured separately in RevenueCat, each with their own API keys.

### Step 4: Configure iOS Integration

1. Navigate to your iOS app in RevenueCat
2. Go to **Apple App Store** integration
3. Click **Set up**
4. You'll need:
   - **App Store Connect API Key** (see iOS setup below)
   - OR **Shared Secret** from App Store Connect

**Getting Shared Secret (easier method):**
1. Go to App Store Connect
2. Navigate to: **My Apps** → Your App → **App Store** tab → **App Information**
3. Scroll to **App-Specific Shared Secret** section
4. Click **Generate** (or copy existing)
5. Paste into RevenueCat

### Step 5: Configure Android Integration

1. Navigate to your Android app in RevenueCat
2. Go to **Google Play Store** integration
3. Click **Set up**
4. You'll need:
   - **Service Account JSON** from Google Cloud Console (see Android setup below)

**Getting Service Account JSON:**
1. Google Play Console → **Setup** → **API access**
2. Link to a Google Cloud project (or create new)
3. Create a service account in Google Cloud Console
4. Download the JSON key
5. Upload to RevenueCat

### Step 6: Create Entitlements

Entitlements are the features users get access to.

1. In RevenueCat → **Entitlements** → **New Entitlement**
2. Enter identifier: `pro` (or `premium`, `elite`)
3. Add description: "Pro features access"
4. Click **Save**

**Example Entitlements:**
- `pro` - Pro tier features
- `premium` - Premium tier features
- `unlimited` - Unlimited usage

### Step 7: Create Products in RevenueCat

**IMPORTANT:** Create products in App Store Connect and Google Play Console FIRST, then import to RevenueCat.

1. In RevenueCat → **Products** → **New Product**
2. For each product:
   - **Product ID**: Must match your code (e.g., `pro_monthly`)
   - **Product Type**: Subscription or Consumable
   - **Store Product IDs**:
     - iOS: Enter the iOS product ID from App Store Connect
     - Android: Enter the Android product ID from Google Play Console
   - Click **Save**

**Note:** If iOS and Android product IDs differ, RevenueCat maps them automatically.

### Step 8: Create Offerings

Offerings group products for display in your app.

1. **Offerings** → **New Offering**
2. Identifier: `default` (shown to all users)
3. Add packages:
   - **Package**: `$rc_monthly` (monthly subscription)
   - **Product**: Select `pro_monthly`
   - **Package**: `$rc_annual` (yearly subscription)
   - **Product**: Select `pro_yearly`
4. Click **Save**

**Example Offering Structure:**
```
Offering: default
├── Package: $rc_monthly → pro_monthly
├── Package: $rc_annual → pro_yearly
└── Package: credits_50 → credits_50
```

### Step 9: Get API Keys

1. In RevenueCat → **Settings** → **API Keys**
2. Copy **iOS Public SDK Key** (starts with `appl_...`)
3. Copy **Android Public SDK Key** (starts with `goog_...`)

**Add to your environment variables:**
```bash
# .env
VITE_REVENUECAT_IOS_API_KEY=appl_xxxxxxxxxxxxxxxxx
VITE_REVENUECAT_ANDROID_API_KEY=goog_xxxxxxxxxxxxxxxxx
```

**Add to Codemagic (for CI/CD):**
1. Codemagic → Your App → **Environment variables**
2. Add both keys as secure variables

---

## Section C: iOS App Store Connect Setup

### Step 1: Create In-App Purchases

1. Go to [App Store Connect](https://appstoreconnect.apple.com)
2. **My Apps** → Your App → **Features** → **In-App Purchases**
3. Click **+** to create

### Step 2: Create Subscriptions

**For each subscription (e.g., pro_monthly, pro_yearly):**

1. Click **+** → **Auto-Renewable Subscription**
2. Enter **Product ID**: `pro_monthly` (must match your code EXACTLY)
3. Select **Subscription Group** (or create new: "Pro Subscription")
4. Click **Create**

**Configure the subscription:**
1. **Subscription Display Name**: Pro Monthly
2. **Subscription Duration**: 1 month (or 1 year for yearly)
3. **Subscription Prices**: Click **+** to add
   - Select territories (or "All Territories")
   - Enter price: $4.99 USD
   - Click **Next** → **Add**
4. **App Store Localization** (at least one required):
   - Language: English (U.S.)
   - Display Name: Pro Monthly Subscription
   - Description: Unlimited AI generations and premium features
5. **Review Information** (for Apple reviewers):
   - Screenshot: (optional but recommended)
   - Review Notes: Explain what features this unlocks
6. Click **Save**

**Repeat for yearly subscription:**
- Product ID: `pro_yearly`
- Duration: 1 year
- Price: $39.99 USD
- Ensure it's in the SAME subscription group

### Step 3: Create Consumables

**For each consumable (e.g., credits_50):**

1. Click **+** → **Consumable**
2. Enter **Product ID**: `credits_50`
3. Click **Create**

**Configure the consumable:**
1. **Display Name**: 50 Credits
2. **Price**: $4.99 USD (add for all territories)
3. **App Store Localization**:
   - Language: English (U.S.)
   - Display Name: 50 Credits
   - Description: Use credits for AI generations
4. **Review Information**: Explain credit usage
5. Click **Save**

**Repeat for all consumables:**
- `credits_200` - $14.99
- `credits_500` - $29.99

### Step 4: Set Up Subscription Groups

Subscription groups allow users to switch between plans.

1. **Subscription Group Settings**:
   - Name: Pro Subscription
   - Add both `pro_monthly` and `pro_yearly` to this group
2. **Subscription Ranking** (within group):
   - Drag to set upgrade/downgrade hierarchy
   - Higher rank = higher tier
   - Example: `pro_yearly` ranked above `pro_monthly`

### Step 5: Submit for Review

**Before submitting:**
- All products must have at least one localization
- Review information filled out
- Test with sandbox account

**To submit:**
1. Go to each product
2. Click **Submit for Review**
3. Apple typically reviews in 24-48 hours

**Note:** You can test products in sandbox mode BEFORE approval.

---

## Section D: Google Play Console Setup

### Step 1: Navigate to Monetization

1. Go to [Google Play Console](https://play.google.com/console)
2. Select your app
3. Navigate to **Monetize** → **Products**

### Step 2: Create Subscriptions

1. Click **Subscriptions** tab → **Create subscription**

**For each subscription (e.g., pro_monthly):**

1. **Product ID**: `pro_monthly` (must match your code EXACTLY)
2. **Name**: Pro Monthly
3. **Description**: Unlimited AI generations and premium features
4. Click **Continue**

**Set up base plan:**
1. **Base plan ID**: `monthly` (or `yearly` for yearly subscription)
2. **Billing period**: 1 month (or 1 year)
3. **Price**:
   - Click **Set price**
   - Enter: $4.99 USD
   - Let Google auto-convert for other countries
   - Click **Apply**
4. **Free trial** (optional):
   - Enable free trial: 7 days (recommended)
   - Trial price: $0.00
5. Click **Activate**

**Repeat for all subscriptions:**
- `pro_yearly` - $39.99/year base plan

### Step 3: Create In-App Products (Consumables)

1. Click **In-app products** tab → **Create product**

**For each consumable (e.g., credits_50):**

1. **Product ID**: `credits_50`
2. **Name**: 50 Credits
3. **Description**: Use credits for AI generations
4. **Price**:
   - Set to $4.99 USD
   - Auto-convert for other countries
5. **Status**: Active
6. Click **Save**

**Repeat for all consumables:**
- `credits_200` - $14.99
- `credits_500` - $29.99

### Step 4: Activate Products

**IMPORTANT:** Products must be activated before they appear in your app.

1. Go to each product
2. Verify all fields are complete
3. Click **Activate** (top right)
4. Products are immediately available (no review required!)

### Step 5: Set Up License Testing

For testing purchases without real charges:

1. **Settings** → **License Testing**
2. Add test account emails (your email, QA team)
3. **Test Licenses**: Select "Respond normally"
4. Test purchases will be free and instant

---

## Section E: Testing Checklist

### iOS Sandbox Testing

**Setup:**
1. Create sandbox tester account:
   - App Store Connect → **Users and Access** → **Sandbox Testers**
   - Click **+** → Create tester with unique email
   - Password, region, etc.
2. On test device:
   - Settings → App Store → Sign out of real account
   - Install your app via Xcode/TestFlight
   - When prompted for App Store login, use sandbox account

**Test purchases:**
- [ ] Purchase monthly subscription
- [ ] Verify subscription shows as active in app
- [ ] Purchase consumable (credits)
- [ ] Verify credits added to account
- [ ] Test restore purchases
- [ ] Cancel subscription and verify access revoked

**Check RevenueCat:**
- [ ] Events appear in RevenueCat dashboard
- [ ] Customer profile shows purchases
- [ ] Webhook events sent (if configured)

### Android License Testing

**Setup:**
1. Add your email to license testers (see Step 5 above)
2. Install app via internal testing or debug build
3. Sign in with your Google account
4. Purchases will be instant and free

**Test purchases:**
- [ ] Purchase monthly subscription
- [ ] Verify subscription shows as active
- [ ] Purchase consumable (credits)
- [ ] Verify credits added
- [ ] Test restore purchases
- [ ] Cancel subscription and verify

**Check RevenueCat:**
- [ ] Android purchases appear in dashboard
- [ ] Customer profile updated
- [ ] Webhooks triggered

### Production Testing

**Before launch:**
- [ ] Create real TestFlight/Internal Testing release
- [ ] Test with non-sandbox account (real charges!)
- [ ] Verify full purchase flow end-to-end
- [ ] Test subscription renewal (may take 24h)
- [ ] Test webhooks with production URL
- [ ] Test on multiple devices/OS versions

### Common Test Scenarios

**Scenario 1: New user purchases subscription**
- Expected: Pro features unlock immediately
- Check: Database updated with `subscription_status: 'pro'`

**Scenario 2: User purchases credits**
- Expected: Credits added to account balance
- Check: Database `credits` field incremented

**Scenario 3: User restores purchases on new device**
- Expected: Subscription and credits restored
- Check: All purchases re-validated

**Scenario 4: Subscription expires**
- Expected: Pro features locked
- Check: Database `subscription_status: 'free'` after expiry

**Scenario 5: User upgrades from monthly to yearly**
- Expected: Prorated credit, yearly subscription active
- Check: Only yearly subscription shows in RevenueCat

---

## Common Pitfalls

### 1. Product ID Mismatches

**Problem:** Product IDs don't match across code, RevenueCat, and stores.

**Solution:**
- Use a consistent naming convention
- Copy-paste product IDs (don't retype!)
- Check for typos: `pro_montly` vs `pro_monthly`

### 2. Products Not Approved (iOS)

**Problem:** Products in "Waiting for Review" state.

**Solution:**
- Products can be tested in sandbox before approval
- Submit for review with your app submission
- Apple typically approves in 24-48 hours

### 3. Products Not Activated (Android)

**Problem:** Products created but not activated.

**Solution:**
- Go to Google Play Console → Products
- Click each product → **Activate**
- Products are usable immediately (no review!)

### 4. Wrong API Keys

**Problem:** Using iOS API key for Android (or vice versa).

**Solution:**
- RevenueCat generates separate keys for each platform
- Use platform detection in code:
  ```typescript
  const apiKey = Platform.OS === 'ios'
    ? REVENUECAT_IOS_KEY
    : REVENUECAT_ANDROID_KEY;
  ```

### 5. Sandbox Account Not Signed In

**Problem:** Test purchases fail on iOS.

**Solution:**
- Sign out of real App Store account
- Sign in with sandbox tester account
- Only during purchase prompt, not in Settings

### 6. Subscription Groups Not Set

**Problem:** Users can buy multiple subscriptions.

**Solution:**
- Ensure all tiers in same subscription group
- Users can only have one active at a time
- Switching plans handled automatically

### 7. Receipt Validation Failures

**Problem:** Purchases succeed but not validated.

**Solution:**
- Verify RevenueCat integration setup
- Check service account permissions (Android)
- Ensure shared secret correct (iOS)
- Review webhook logs for errors

### 8. Free Trial Issues

**Problem:** Users can't access trial or trial doesn't work.

**Solution:**
- Enable free trial in Google Play base plan
- For iOS, configure in App Store Connect
- Test with fresh sandbox/license testing account

### 9. Currency Conversion

**Problem:** Prices show in wrong currency.

**Solution:**
- Set base price in USD
- Let stores auto-convert (don't manually set all)
- RevenueCat shows localized prices automatically

### 10. Webhook Not Firing

**Problem:** Backend not receiving purchase events.

**Solution:**
- Verify webhook URL in RevenueCat settings
- Check URL is HTTPS (required)
- Test with RevenueCat's "Send Test" feature
- Check server logs for POST requests

---

## Next Steps

After completing this setup:

1. **Test thoroughly** using sandbox/license testing
2. **Submit app** to App Store and Google Play
3. **Monitor analytics** in RevenueCat dashboard
4. **Set up webhooks** for backend sync (optional but recommended)
5. **Plan promotions** - trials, discounts, promotional offers

---

## Additional Resources

- **RevenueCat Docs:** https://www.revenuecat.com/docs
- **App Store Connect Guide:** https://developer.apple.com/app-store-connect/
- **Google Play Console Guide:** https://support.google.com/googleplay/android-developer
- **RevenueCat Community:** https://community.revenuecat.com/

---

**Generated by Capacitor Wrap Skill v2.5**
