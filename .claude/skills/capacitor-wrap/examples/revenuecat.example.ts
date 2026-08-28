/**
 * RevenueCat Service Example
 *
 * This service handles in-app subscriptions using RevenueCat.
 * Replace API keys with your actual keys from the RevenueCat dashboard.
 */

import {
  Purchases,
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesOfferings,
  type PurchasesPackage,
} from "@revenuecat/purchases-capacitor";
import { Capacitor } from "@capacitor/core";

// Replace with your RevenueCat API keys
// Get these from: https://app.revenuecat.com -> Project Settings -> API Keys
const REVENUECAT_IOS_KEY = "appl_YOUR_IOS_API_KEY";
const REVENUECAT_ANDROID_KEY = "goog_YOUR_ANDROID_API_KEY";

// Entitlement identifiers - must match your RevenueCat dashboard
export const ENTITLEMENTS = {
  PRO: "pro",
  PREMIUM: "premium",
} as const;

// Product identifiers - must match App Store Connect / Google Play Console
export const PRODUCTS = {
  PRO_MONTHLY: "myapp_pro_monthly",
  PRO_YEARLY: "myapp_pro_yearly",
  PREMIUM_MONTHLY: "myapp_premium_monthly",
} as const;

/**
 * Check if running on a native platform
 */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Initialize RevenueCat with the user's ID
 * Call this after user authentication
 */
export async function initRevenueCat(userId: string): Promise<void> {
  if (!isNativePlatform()) {
    console.log("[RevenueCat] Skipping - not on native platform");
    return;
  }

  const platform = Capacitor.getPlatform();
  const apiKey = platform === "ios" ? REVENUECAT_IOS_KEY : REVENUECAT_ANDROID_KEY;

  await Purchases.configure({
    apiKey,
    appUserID: userId,
  });

  // Enable debug logging in development
  if (process.env.NODE_ENV === "development") {
    await Purchases.setLogLevel({ level: LOG_LEVEL.DEBUG });
  }
}

/**
 * Get available subscription offerings
 */
export async function getOfferings(): Promise<PurchasesOfferings | null> {
  if (!isNativePlatform()) return null;

  try {
    const { offerings } = await Purchases.getOfferings();
    return offerings;
  } catch (error) {
    console.error("[RevenueCat] Failed to get offerings:", error);
    return null;
  }
}

/**
 * Purchase a subscription package
 */
export async function purchasePackage(
  pkg: PurchasesPackage
): Promise<CustomerInfo | null> {
  if (!isNativePlatform()) return null;

  try {
    const { customerInfo } = await Purchases.purchasePackage({
      aPackage: pkg,
    });
    return customerInfo;
  } catch (error: unknown) {
    // Check if user cancelled
    if (error && typeof error === "object" && "userCancelled" in error) {
      if ((error as { userCancelled: boolean }).userCancelled) {
        console.log("[RevenueCat] User cancelled purchase");
        return null;
      }
    }
    throw error;
  }
}

/**
 * Get current customer info (subscription status)
 */
export async function getCustomerInfo(): Promise<CustomerInfo | null> {
  if (!isNativePlatform()) return null;

  const { customerInfo } = await Purchases.getCustomerInfo();
  return customerInfo;
}

/**
 * Restore previous purchases
 */
export async function restorePurchases(): Promise<CustomerInfo | null> {
  if (!isNativePlatform()) return null;

  const { customerInfo } = await Purchases.restorePurchases();
  return customerInfo;
}

/**
 * Check if user has an active entitlement
 */
export function hasEntitlement(
  customerInfo: CustomerInfo,
  entitlement: string
): boolean {
  return !!customerInfo.entitlements.active[entitlement];
}

/**
 * Get the user's current plan based on entitlements
 */
export function getUserPlan(
  customerInfo: CustomerInfo
): "free" | "pro" | "premium" {
  if (hasEntitlement(customerInfo, ENTITLEMENTS.PREMIUM)) return "premium";
  if (hasEntitlement(customerInfo, ENTITLEMENTS.PRO)) return "pro";
  return "free";
}

/**
 * Log out the current user
 */
export async function logOutRevenueCat(): Promise<void> {
  if (!isNativePlatform()) return;
  await Purchases.logOut();
}
