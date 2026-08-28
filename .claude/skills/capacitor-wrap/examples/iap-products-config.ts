/**
 * IAP Products Configuration Template
 *
 * This file shows how to configure in-app purchase products for your Capacitor app.
 * Copy this to your project at: services/iap.ts (or lib/services/iap.ts)
 *
 * IMPORTANT: Product IDs must match EXACTLY across:
 * 1. This code
 * 2. RevenueCat dashboard
 * 3. App Store Connect (iOS)
 * 4. Google Play Console (Android)
 */

// ============================================================================
// PRODUCT IDs - Customize these for your app
// ============================================================================

export const IAP_PRODUCTS = {
  // ========== SUBSCRIPTIONS ==========
  // Auto-renewable subscriptions - user charged automatically
  // Pattern: {tier}_{period}
  PRO_MONTHLY: 'pro_monthly',        // $4.99/month - Pro tier
  PRO_YEARLY: 'pro_yearly',          // $39.99/year - Pro tier (save 33%)

  // Optional: Additional subscription tiers
  // PREMIUM_MONTHLY: 'premium_monthly',  // $9.99/month - Premium tier
  // ELITE_YEARLY: 'elite_yearly',        // $79.99/year - Elite tier

  // ========== CONSUMABLES ==========
  // One-time purchases, can be bought multiple times
  // Pattern: credits_{amount} or tokens_{amount}
  CREDITS_50: 'credits_50',          // $4.99 - Starter pack
  CREDITS_200: 'credits_200',        // $14.99 - Value pack
  CREDITS_500: 'credits_500',        // $29.99 - Best value pack

  // Alternative naming patterns:
  // TOKENS_100: 'tokens_100',
  // COINS_500: 'coins_500',
  // GEMS_1000: 'gems_1000',
} as const;

// TypeScript type for product IDs
export type IAPProductId = typeof IAP_PRODUCTS[keyof typeof IAP_PRODUCTS];

// ============================================================================
// PRODUCT INTERFACE - Type definition
// ============================================================================

export interface IAPProduct {
  id: IAPProductId;                   // Product identifier (must match stores)
  title: string;                      // Display name in your app
  description: string;                // Product description
  price: string;                      // Display price (for reference)
  type: 'subscription' | 'consumable'; // Product type
  credits?: number;                   // For consumables: how many credits/tokens
  billingPeriod?: 'monthly' | 'yearly' | 'quarterly'; // For subscriptions
}

// ============================================================================
// PRODUCT INFORMATION - Display details for your app
// ============================================================================

export const PRODUCT_INFO: Record<IAPProductId, IAPProduct> = {
  // ========== SUBSCRIPTION PRODUCTS ==========

  [IAP_PRODUCTS.PRO_MONTHLY]: {
    id: IAP_PRODUCTS.PRO_MONTHLY,
    title: 'Pro Monthly',
    description: 'Unlimited AI generations & premium features',
    price: '$4.99/month',
    type: 'subscription',
    billingPeriod: 'monthly',
  },

  [IAP_PRODUCTS.PRO_YEARLY]: {
    id: IAP_PRODUCTS.PRO_YEARLY,
    title: 'Pro Yearly',
    description: 'Unlimited AI generations & premium features',
    price: '$39.99/year',
    type: 'subscription',
    billingPeriod: 'yearly',
  },

  // ========== CONSUMABLE PRODUCTS ==========

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

// ============================================================================
// HELPER FUNCTIONS - Useful utilities
// ============================================================================

/**
 * Get all subscription products
 */
export function getSubscriptionProducts(): IAPProduct[] {
  return Object.values(PRODUCT_INFO).filter(p => p.type === 'subscription');
}

/**
 * Get all consumable products
 */
export function getConsumableProducts(): IAPProduct[] {
  return Object.values(PRODUCT_INFO).filter(p => p.type === 'consumable');
}

/**
 * Get product info by ID
 */
export function getProductInfo(productId: IAPProductId): IAPProduct | undefined {
  return PRODUCT_INFO[productId];
}

/**
 * Check if a product ID is valid
 */
export function isValidProductId(productId: string): productId is IAPProductId {
  return Object.values(IAP_PRODUCTS).includes(productId as IAPProductId);
}

// ============================================================================
// PRICING RECOMMENDATIONS
// ============================================================================

/**
 * Recommended pricing tiers for different app types:
 *
 * CONSUMER APPS (Social, Fitness, Productivity):
 * - Monthly: $4.99 - $9.99
 * - Yearly: $39.99 - $79.99
 * - Free trial: 3-7 days
 *
 * PROFESSIONAL APPS (Business, Creative Tools):
 * - Monthly: $9.99 - $29.99
 * - Yearly: $99.99 - $299.99
 * - Free trial: 7-14 days
 *
 * GAMING / CONSUMABLES:
 * - Starter: $0.99 - $4.99 (50-100 units)
 * - Value: $9.99 - $14.99 (200-300 units)
 * - Best Value: $24.99 - $49.99 (500-1000 units)
 *
 * PSYCHOLOGY TIP:
 * - Offer 3 tiers (Goldilocks effect - most choose middle)
 * - Make yearly price save 20-30% vs monthly
 * - Price consumables with increasing value (more units per $)
 */

// ============================================================================
// EXAMPLE USAGE IN YOUR APP
// ============================================================================

/**
 * Example: Purchase flow
 *
 * import { IAP_PRODUCTS, PRODUCT_INFO } from './services/iap';
 * import { purchasePackage } from '@revenuecat/purchases-capacitor';
 *
 * // Display products to user
 * const subscriptions = getSubscriptionProducts();
 *
 * // When user clicks "Buy Pro Monthly"
 * const product = PRODUCT_INFO[IAP_PRODUCTS.PRO_MONTHLY];
 *
 * // Trigger purchase (using RevenueCat)
 * const offerings = await getOfferings();
 * const monthlyPackage = offerings.current?.monthly;
 * if (monthlyPackage) {
 *   await purchasePackage({ aPackage: monthlyPackage });
 * }
 */

// ============================================================================
// CUSTOMIZATION CHECKLIST
// ============================================================================

/**
 * Before deploying:
 *
 * [ ] Update product IDs to match your app name/branding
 * [ ] Set appropriate pricing for your market/audience
 * [ ] Create matching products in App Store Connect (iOS)
 * [ ] Create matching products in Google Play Console (Android)
 * [ ] Import products into RevenueCat dashboard
 * [ ] Create entitlements in RevenueCat (e.g., "pro", "premium")
 * [ ] Create offerings in RevenueCat (group products for display)
 * [ ] Get RevenueCat API keys (iOS and Android separate)
 * [ ] Add API keys to environment variables
 * [ ] Test with sandbox accounts (iOS) and license testing (Android)
 */
