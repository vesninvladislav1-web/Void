/**
 * Generate Google Play Store Feature Graphic
 *
 * This script creates the REQUIRED 1024 x 500 px banner graphic that appears
 * at the top of your Google Play Store listing.
 *
 * Requirements:
 * - Exact dimensions: 1024 x 500 px (REQUIRED)
 * - Format: PNG or JPEG
 * - Max size: 15MB
 * - This graphic is MANDATORY for Google Play Store submission
 *
 * Usage:
 *   node scripts/generate-feature-graphic.mjs
 *
 * Requirements:
 *   npm install sharp
 */

import sharp from 'sharp';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Configuration - CUSTOMIZE THESE FOR YOUR APP
const CONFIG = {
  // Exact dimensions required by Google Play Store
  width: 1024,
  height: 500,

  // App branding - UPDATE THESE
  appName: 'Your App Name',
  tagline: 'Your App Tagline',

  // Brand colors - UPDATE THESE
  // Tip: Use your app's primary colors for brand consistency
  colors: {
    gradientStart: '#37B5B6',  // Left side of gradient
    gradientEnd: '#F47C74',     // Right side of gradient
    textColor: '#FFFFFF',       // Text color (white recommended for readability)
  },

  // Paths
  logoPath: join(projectRoot, 'public', 'icons', 'icon-512x512.png'),
  // Alternative logo paths you might use:
  // logoPath: join(projectRoot, 'public', 'icons', 'carousel-logo.png'),
  // logoPath: join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi', 'ic_launcher.png'),

  outputPath: join(projectRoot, 'screenshots', 'android', 'feature-graphic.png')
};

/**
 * Create gradient background using SVG
 */
function createGradientSVG() {
  return `
    <svg width="${CONFIG.width}" height="${CONFIG.height}">
      <defs>
        <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:${CONFIG.colors.gradientStart};stop-opacity:1" />
          <stop offset="100%" style="stop-color:${CONFIG.colors.gradientEnd};stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="${CONFIG.width}" height="${CONFIG.height}" fill="url(#gradient)" />
    </svg>
  `;
}

/**
 * Create text overlay SVG
 */
function createTextSVG() {
  // Calculate positions (centered horizontally, positioned vertically)
  const centerX = CONFIG.width / 2;
  const appNameY = 220;  // App name position
  const taglineY = 300;  // Tagline position (below app name)

  return `
    <svg width="${CONFIG.width}" height="${CONFIG.height}">
      <!-- App Name -->
      <text
        x="${centerX}"
        y="${appNameY}"
        font-family="Arial, Helvetica, sans-serif"
        font-size="120"
        font-weight="bold"
        fill="${CONFIG.colors.textColor}"
        text-anchor="middle"
        style="text-shadow: 2px 2px 4px rgba(0,0,0,0.3);"
      >
        ${CONFIG.appName}
      </text>

      <!-- Tagline -->
      <text
        x="${centerX}"
        y="${taglineY}"
        font-family="Arial, Helvetica, sans-serif"
        font-size="48"
        font-weight="normal"
        fill="${CONFIG.colors.textColor}"
        text-anchor="middle"
        opacity="0.95"
        style="text-shadow: 1px 1px 2px rgba(0,0,0,0.3);"
      >
        ${CONFIG.tagline}
      </text>
    </svg>
  `;
}

/**
 * Generate the feature graphic
 */
async function generateFeatureGraphic() {
  console.log('🎨 Generating Google Play Store Feature Graphic\n');
  console.log(`  Dimensions: ${CONFIG.width} x ${CONFIG.height} (REQUIRED)`);
  console.log(`  App Name: "${CONFIG.appName}"`);
  console.log(`  Tagline: "${CONFIG.tagline}"`);
  console.log(`  Output: ${CONFIG.outputPath}\n`);

  try {
    // Step 1: Create gradient background
    console.log('1️⃣  Creating gradient background...');
    const gradientSVG = Buffer.from(createGradientSVG());
    const background = await sharp(gradientSVG)
      .resize(CONFIG.width, CONFIG.height)
      .png()
      .toBuffer();

    // Step 2: Load and resize logo (if exists)
    let compositeSteps = [];

    if (existsSync(CONFIG.logoPath)) {
      console.log('2️⃣  Processing logo...');
      const logoSize = 180; // Logo height
      const logo = await sharp(CONFIG.logoPath)
        .resize(null, logoSize, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .png()
        .toBuffer();

      // Get logo dimensions to center it
      const logoMetadata = await sharp(logo).metadata();
      const logoX = Math.round((CONFIG.width - logoMetadata.width) / 2);
      const logoY = 30; // Top margin

      compositeSteps.push({
        input: logo,
        top: logoY,
        left: logoX
      });

      console.log('3️⃣  Compositing logo...');
    } else {
      console.log('⚠️  Logo not found at:', CONFIG.logoPath);
      console.log('   Skipping logo - graphic will only have text');
      console.log('   Update CONFIG.logoPath to include your logo\n');
    }

    // Step 3: Add logo to background (if logo exists)
    let withLogo = background;
    if (compositeSteps.length > 0) {
      withLogo = await sharp(background)
        .composite(compositeSteps)
        .png()
        .toBuffer();
    }

    // Step 4: Add text overlay
    console.log('4️⃣  Adding text overlay...');
    const textSVG = Buffer.from(createTextSVG());
    const final = await sharp(withLogo)
      .composite([
        {
          input: textSVG,
          top: 0,
          left: 0
        }
      ])
      .png({ quality: 95 })
      .toFile(CONFIG.outputPath);

    console.log('\n✅ Feature graphic generated successfully!');
    console.log(`   File: ${CONFIG.outputPath}`);
    console.log(`   Size: ${Math.round(final.size / 1024)}KB`);
    console.log(`   Dimensions: ${final.width} x ${final.height}\n`);

    console.log('📝 Next steps:');
    console.log('   1. Review the graphic to ensure it looks good');
    console.log('   2. Customize CONFIG in this script if needed:');
    console.log('      - Update appName, tagline, colors');
    console.log('      - Adjust logoPath if your logo is elsewhere');
    console.log('   3. Upload to Google Play Console:');
    console.log('      Store Listing → Feature Graphic section');
    console.log('   4. This graphic appears at the top of your Play Store listing\n');

    console.log('💡 Tips:');
    console.log('   - Feature graphic is REQUIRED for Google Play submission');
    console.log('   - Use high contrast text for readability');
    console.log('   - Test on different screen sizes in Play Console preview');
    console.log('   - Keep important content centered (edges may be cropped on some devices)\n');

  } catch (error) {
    console.error('❌ Error generating feature graphic:', error);
    console.error('\nTroubleshooting:');
    console.error('   1. Make sure Sharp is installed: npm install sharp');
    console.error('   2. Check that output directory exists: screenshots/android/');
    console.error('   3. Verify logo path is correct in CONFIG.logoPath');
    console.error('   4. Ensure you have write permissions to the output directory\n');
    throw error;
  }
}

// Run the script
generateFeatureGraphic().catch(console.error);
