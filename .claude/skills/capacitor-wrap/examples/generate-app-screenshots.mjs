/**
 * Automated Screenshot Generator for App Stores
 *
 * Generates screenshots for both Apple App Store and Google Play Store
 * using Playwright for browser automation.
 *
 * Usage:
 *   node scripts/generate-app-screenshots.mjs
 *
 * Requirements:
 *   npm install -D playwright
 *   npx playwright install chromium
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Configuration - customize these for your app
const CONFIG = {
  // Your app URL (local dev server or deployed URL)
  appUrl: process.env.APP_URL || 'http://localhost:5173',

  // Wait time for page to load before screenshot (ms)
  loadWaitTime: 2000,

  // Output directories
  outputDir: 'screenshots',
  iosDir: 'screenshots/ios',
  androidDir: 'screenshots/android',
  androidPhoneDir: 'screenshots/android/phone',
  androidTablet7Dir: 'screenshots/android/tablet-7',
  androidTablet10Dir: 'screenshots/android/tablet-10',

  // Screenshot scenarios - customize these for your app's key screens
  scenarios: [
    {
      name: 'home',
      description: 'Home Screen',
      path: '/',
      waitForSelector: 'body', // Adjust to your app's main content selector
    },
    {
      name: 'feature-1',
      description: 'Main Feature',
      path: '/', // Adjust path
      waitForSelector: 'body',
      // Optional: actions to perform before screenshot
      actions: async (page) => {
        // Example: await page.click('#feature-button');
        // Example: await page.waitForTimeout(1000);
      }
    },
    {
      name: 'feature-2',
      description: 'Secondary Feature',
      path: '/',
      waitForSelector: 'body',
    },
    {
      name: 'user-flow',
      description: 'Key User Flow',
      path: '/',
      waitForSelector: 'body',
    },
  ],
};

// Apple App Store screenshot dimensions (2026 requirements)
// 6.9" iPhone (iPhone 15 Pro Max, 16 Pro Max) - MANDATORY
const IOS_SIZES = [
  { name: 'iphone-6.9', width: 1320, height: 2868, label: '6.9" iPhone (Mandatory)' },
  { name: 'iphone-6.7', width: 1290, height: 2796, label: '6.7" iPhone (14 Pro Max, 15 Plus)' },
  { name: 'iphone-6.5', width: 1242, height: 2688, label: '6.5" iPhone (XS Max, 11 Pro Max)' },
  { name: 'iphone-5.5', width: 1242, height: 2208, label: '5.5" iPhone (8 Plus)' },
  { name: 'ipad-13', width: 2064, height: 2752, label: '13" iPad Pro (Mandatory)' },
  { name: 'ipad-12.9', width: 2048, height: 2732, label: '12.9" iPad Pro' },
];

// Google Play Store screenshot dimensions (2026 requirements)
// Minimum 2 screenshots, up to 8 allowed per category
// Phone screenshots are REQUIRED. Tablet screenshots are OPTIONAL.
const ANDROID_PHONE_SIZES = [
  { name: '1080x1920', width: 1080, height: 1920, label: 'Phone (1080x1920 - Recommended)', dir: 'phone' },
  { name: '1440x2560', width: 1440, height: 2560, label: 'Phone HD (1440x2560)', dir: 'phone' },
];

const ANDROID_TABLET_7_SIZES = [
  { name: '1200x1920', width: 1200, height: 1920, label: '7" Tablet (1200x1920)', dir: 'tablet-7' },
];

const ANDROID_TABLET_10_SIZES = [
  { name: '1600x2560', width: 1600, height: 2560, label: '10" Tablet (1600x2560)', dir: 'tablet-10' },
];

/**
 * Create output directories if they don't exist
 */
function setupDirectories() {
  const dirs = [
    CONFIG.outputDir,
    CONFIG.iosDir,
    CONFIG.androidDir,
    CONFIG.androidPhoneDir,
    CONFIG.androidTablet7Dir,
    CONFIG.androidTablet10Dir
  ];

  dirs.forEach(dir => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`✅ Created directory: ${dir}`);
    }
  });
}

/**
 * Generate screenshots for a specific platform
 */
async function generateScreenshots(browser, platform, sizes, subDir = null) {
  const label = subDir ? `${platform} (${subDir})` : platform;
  console.log(`\n📱 Generating ${label} screenshots...\n`);

  let outputDir;
  if (platform === 'iOS') {
    outputDir = CONFIG.iosDir;
  } else if (subDir) {
    // Android with subdirectory (phone, tablet-7, tablet-10)
    outputDir = join(CONFIG.androidDir, subDir);
  } else {
    outputDir = CONFIG.androidDir;
  }

  let totalGenerated = 0;

  for (const scenario of CONFIG.scenarios) {
    console.log(`  Scenario: ${scenario.description}`);

    for (const size of sizes) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: 2, // Retina display
      });

      const page = await context.newPage();

      try {
        // Navigate to the page
        const url = `${CONFIG.appUrl}${scenario.path}`;
        await page.goto(url, { waitUntil: 'networkidle' });

        // Wait for specific selector
        await page.waitForSelector(scenario.waitForSelector, { timeout: 10000 });

        // Additional wait for animations/loading
        await page.waitForTimeout(CONFIG.loadWaitTime);

        // Execute custom actions if provided
        if (scenario.actions) {
          await scenario.actions(page);
          await page.waitForTimeout(1000); // Wait for action effects
        }

        // Generate filename
        const filename = `${scenario.name}-${size.name}.png`;
        const filepath = join(outputDir, filename);

        // Take screenshot
        await page.screenshot({
          path: filepath,
          fullPage: false, // Only viewport, not full scrollable page
        });

        console.log(`    ✓ ${filename} (${size.width}x${size.height})`);
        totalGenerated++;

      } catch (error) {
        console.error(`    ✗ Error capturing ${scenario.name} at ${size.name}:`, error.message);
      } finally {
        await context.close();
      }
    }
  }

  console.log(`\n  Total ${platform} screenshots generated: ${totalGenerated}`);
  return totalGenerated;
}

/**
 * Generate summary report
 */
function generateReport(counts) {
  const total = Object.values(counts).reduce((sum, val) => sum + val, 0);

  console.log('\n' + '='.repeat(70));
  console.log('📊 Screenshot Generation Summary');
  console.log('='.repeat(70));
  console.log(`\n📱 iOS Screenshots: ${counts.ios}`);
  console.log(`   Location: ${CONFIG.iosDir}/`);
  console.log(`   Required: At least 1 x 6.9" iPhone + 1 x 13" iPad`);
  console.log(`\n🤖 Android Phone Screenshots: ${counts.androidPhone} (REQUIRED)`);
  console.log(`   Location: ${CONFIG.androidPhoneDir}/`);
  console.log(`   Required: Minimum 2, maximum 8 screenshots (1080x1920 recommended)`);
  console.log(`\n📱 Android 7" Tablet Screenshots: ${counts.androidTablet7} (optional)`);
  console.log(`   Location: ${CONFIG.androidTablet7Dir}/`);
  console.log(`\n📱 Android 10" Tablet Screenshots: ${counts.androidTablet10} (optional)`);
  console.log(`   Location: ${CONFIG.androidTablet10Dir}/`);
  console.log(`\n✅ Total Screenshots: ${total}`);
  console.log('\n' + '='.repeat(70));
  console.log('\n📝 Next Steps:');
  console.log('   1. Review generated screenshots in the directories above');
  console.log('   2. Generate feature graphic for Android (1024x500) - REQUIRED');
  console.log('      Run: node scripts/generate-feature-graphic.mjs');
  console.log('   3. Upload to App Store Connect (iOS) and Google Play Console (Android)');
  console.log('   4. Add captions/localization in respective consoles');
  console.log('\n💡 Tips:');
  console.log('   - iOS: Provide 6.9" iPhone and 13" iPad (mandatory in 2026)');
  console.log('   - Android Phone: REQUIRED - minimum 2, maximum 8 screenshots');
  console.log('   - Android Feature Graphic: REQUIRED - 1024 x 500 px banner');
  console.log('   - Android Tablets: OPTIONAL - but recommended for better discovery');
  console.log('   - Use high-quality, engaging screenshots showing key features');
  console.log('   - Consider adding text overlays for context (optional)');
  console.log('\n' + '='.repeat(70) + '\n');
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 Starting App Store Screenshot Generation\n');
  console.log(`   App URL: ${CONFIG.appUrl}`);
  console.log(`   Scenarios: ${CONFIG.scenarios.length}`);
  console.log(`   iOS Sizes: ${IOS_SIZES.length}`);
  console.log(`   Android Phone Sizes: ${ANDROID_PHONE_SIZES.length}`);
  console.log(`   Android 7" Tablet Sizes: ${ANDROID_TABLET_7_SIZES.length}`);
  console.log(`   Android 10" Tablet Sizes: ${ANDROID_TABLET_10_SIZES.length}`);

  // Setup directories
  setupDirectories();

  // Launch browser
  console.log('\n🌐 Launching browser...');
  const browser = await chromium.launch({ headless: true });

  const counts = {
    ios: 0,
    androidPhone: 0,
    androidTablet7: 0,
    androidTablet10: 0
  };

  try {
    // Generate iOS screenshots
    counts.ios = await generateScreenshots(browser, 'iOS', IOS_SIZES);

    // Generate Android Phone screenshots (REQUIRED)
    counts.androidPhone = await generateScreenshots(browser, 'Android', ANDROID_PHONE_SIZES, 'phone');

    // Generate Android 7" Tablet screenshots (OPTIONAL)
    counts.androidTablet7 = await generateScreenshots(browser, 'Android', ANDROID_TABLET_7_SIZES, 'tablet-7');

    // Generate Android 10" Tablet screenshots (OPTIONAL)
    counts.androidTablet10 = await generateScreenshots(browser, 'Android', ANDROID_TABLET_10_SIZES, 'tablet-10');

    // Generate report
    generateReport(counts);

  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  } finally {
    await browser.close();
  }

  console.log('✅ Screenshot generation complete!\n');
}

// Run the script
main().catch(console.error);
