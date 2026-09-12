/**
 * Example Screenshot Scenarios Configuration
 *
 * This file demonstrates different ways to configure screenshot scenarios
 * for various types of apps. Copy the relevant patterns to your
 * generate-app-screenshots.mjs script.
 */

// Example 1: Simple static pages
const simpleAppScenarios = [
  {
    name: 'home',
    description: 'Home Screen',
    path: '/',
    waitForSelector: 'body',
  },
  {
    name: 'about',
    description: 'About Page',
    path: '/about',
    waitForSelector: '.about-container',
  },
  {
    name: 'contact',
    description: 'Contact Form',
    path: '/contact',
    waitForSelector: '.contact-form',
  },
];

// Example 2: E-commerce app
const ecommerceAppScenarios = [
  {
    name: 'home',
    description: 'Product Catalog',
    path: '/',
    waitForSelector: '.product-grid',
  },
  {
    name: 'product-detail',
    description: 'Product Details',
    path: '/products/example-product',
    waitForSelector: '.product-detail',
  },
  {
    name: 'cart',
    description: 'Shopping Cart',
    path: '/cart',
    waitForSelector: '.cart-items',
    actions: async (page) => {
      // Optionally add items to cart first
      // This is just an example - adapt to your app
    }
  },
  {
    name: 'checkout',
    description: 'Checkout Process',
    path: '/checkout',
    waitForSelector: '.checkout-form',
  },
];

// Example 3: Social/Content app with authentication
const socialAppScenarios = [
  {
    name: 'welcome',
    description: 'Welcome Screen',
    path: '/',
    waitForSelector: '.hero-section',
  },
  {
    name: 'feed',
    description: 'Content Feed',
    path: '/feed',
    waitForSelector: '.post-list',
    actions: async (page) => {
      // If auth is required, you might need to:
      // 1. Fill in login form
      // 2. Use localStorage to set auth token
      // 3. Or navigate after authentication

      // Example: Set auth token via localStorage
      // await page.evaluate(() => {
      //   localStorage.setItem('auth_token', 'demo_token');
      // });
      // await page.reload();
    }
  },
  {
    name: 'profile',
    description: 'User Profile',
    path: '/profile',
    waitForSelector: '.profile-header',
  },
  {
    name: 'create-post',
    description: 'Create New Post',
    path: '/create',
    waitForSelector: '.post-editor',
  },
];

// Example 4: Dashboard/Analytics app
const dashboardAppScenarios = [
  {
    name: 'dashboard',
    description: 'Analytics Dashboard',
    path: '/dashboard',
    waitForSelector: '.dashboard-grid',
    actions: async (page) => {
      // Wait for charts to render
      await page.waitForSelector('.chart-container', { timeout: 5000 });
      await page.waitForTimeout(2000); // Extra time for animations
    }
  },
  {
    name: 'reports',
    description: 'Reports View',
    path: '/reports',
    waitForSelector: '.report-list',
  },
  {
    name: 'settings',
    description: 'Settings Panel',
    path: '/settings',
    waitForSelector: '.settings-form',
  },
];

// Example 5: Card/Greeting card creation app (like Carousel)
const cardCreationAppScenarios = [
  {
    name: 'home',
    description: 'Home Screen',
    path: '/',
    waitForSelector: '.hero-section',
  },
  {
    name: 'gallery',
    description: 'Card Gallery',
    path: '/gallery',
    waitForSelector: '.card-grid',
  },
  {
    name: 'create-wizard-start',
    description: 'Create Card - Occasion Selection',
    path: '/create',
    waitForSelector: '.wizard-container',
    actions: async (page) => {
      // Wait for the wizard to load
      await page.waitForTimeout(1000);
    }
  },
  {
    name: 'create-wizard-relationship',
    description: 'Create Card - Relationship',
    path: '/create',
    waitForSelector: '.wizard-container',
    actions: async (page) => {
      // Navigate through wizard steps
      await page.click('[data-occasion="birthday"]');
      await page.click('.next-button');
      await page.waitForTimeout(1000);
    }
  },
  {
    name: 'card-preview',
    description: 'Card Preview',
    path: '/create',
    waitForSelector: '.card-preview',
    actions: async (page) => {
      // Navigate to preview step
      // This is just an example - adapt to your flow
      await page.click('[data-occasion="birthday"]');
      await page.click('.next-button');
      await page.waitForTimeout(500);
      await page.fill('#recipient-name', 'John');
      await page.click('.next-button');
      await page.waitForTimeout(2000); // Wait for AI generation
    }
  },
];

// Example 6: Progressive actions scenario
const interactiveAppScenarios = [
  {
    name: 'onboarding-1',
    description: 'Onboarding Step 1',
    path: '/onboarding',
    waitForSelector: '.onboarding-container',
  },
  {
    name: 'onboarding-2',
    description: 'Onboarding Step 2',
    path: '/onboarding',
    waitForSelector: '.onboarding-container',
    actions: async (page) => {
      await page.click('.onboarding-next');
      await page.waitForTimeout(500);
    }
  },
  {
    name: 'onboarding-3',
    description: 'Onboarding Step 3',
    path: '/onboarding',
    waitForSelector: '.onboarding-container',
    actions: async (page) => {
      await page.click('.onboarding-next');
      await page.waitForTimeout(500);
      await page.click('.onboarding-next');
      await page.waitForTimeout(500);
    }
  },
];

// Example 7: Using query parameters or hash routing
const parameterizedScenarios = [
  {
    name: 'card-view',
    description: 'Viewing Shared Card',
    path: '/?cardId=demo-card-123',
    waitForSelector: '.card-display',
  },
  {
    name: 'collaboration',
    description: 'Collaboration View',
    path: '/?collabId=demo-collab-456',
    waitForSelector: '.collab-interface',
  },
];

// Example 8: Dark mode toggle
const darkModeScenarios = [
  {
    name: 'home-light',
    description: 'Home (Light Mode)',
    path: '/',
    waitForSelector: 'body',
  },
  {
    name: 'home-dark',
    description: 'Home (Dark Mode)',
    path: '/',
    waitForSelector: 'body',
    actions: async (page) => {
      // Toggle dark mode (adapt to your implementation)
      await page.click('.dark-mode-toggle');
      await page.waitForTimeout(500);
    }
  },
];

/**
 * Tips for Creating Effective Screenshot Scenarios:
 *
 * 1. Focus on Key Features
 *    - Show your app's unique value proposition
 *    - Capture the most impressive or useful screens
 *    - Demonstrate core user flows
 *
 * 2. User Journey
 *    - Tell a story with your screenshots
 *    - Show progression from start to goal completion
 *    - Include before/after states if applicable
 *
 * 3. Visual Appeal
 *    - Use demo data that looks good (real but polished)
 *    - Avoid empty states unless showcasing onboarding
 *    - Show variety without overwhelming users
 *
 * 4. Technical Considerations
 *    - Wait for animations to complete
 *    - Ensure data has loaded (API calls, images)
 *    - Handle authentication when needed
 *    - Use consistent test data across screenshots
 *
 * 5. Platform-Specific
 *    - Consider portrait for mobile screenshots
 *    - Use landscape for tablet screenshots when appropriate
 *    - Test that UI scales well at different sizes
 *
 * 6. Localization
 *    - You can run the script multiple times with different locales
 *    - Set language via URL params or localStorage
 *    - Example: path: '/?lang=es' or in actions: localStorage.setItem('locale', 'es')
 *
 * 7. A/B Testing
 *    - Generate multiple versions of key screens
 *    - Test different messaging or layouts
 *    - Compare performance in app store analytics
 */

// Export the scenario set you want to use
module.exports = {
  simpleAppScenarios,
  ecommerceAppScenarios,
  socialAppScenarios,
  dashboardAppScenarios,
  cardCreationAppScenarios,
  interactiveAppScenarios,
  parameterizedScenarios,
  darkModeScenarios,
};
