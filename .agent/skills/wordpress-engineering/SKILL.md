---
name: wordpress-engineering
description: >
  A unified protocol for developing, debugging, and modifying the Tesseract Academy WordPress ecosystem.
  It encapsulates critical lessons from past regressions, focusing on preventing silent AJAX failures, 
  isolating programmatic UI from fragile theme structures (Divi), and resolving MU-plugin priority conflicts.
---

# WordPress Engineering Protocol

**Core Principle**: Never assume the frontend binds correctly to a backend change. Never trust theme inheritance for critical UI. Never hook into the ether without verifying priority.

This skill is invoked whenever tasks involve modifying WordPress plugins, MU-plugins, theme files, or any custom WordPress integration on the Tesseract Academy website.

## 1. The "Silent AJAX Failure" Anti-Pattern (WP AJAX Trace)

**Problem:** Modifying a PHP backend or changing a frontend DOM element often breaks the asynchronous flow. Because there is no hard page reload, the failure is silent, leaving the user stranded without an error message (e.g., OTP password reset, custom login flows).

**Protocol:** Before modifying ANY asynchronous WordPress flow, you MUST trace and map the 5-step lifecycle:

1. **Trigger:** Identify the exact DOM selector (e.g., `#wpmt-otp-set-pw-form`).
2. **Listener:** Identify the JS file and event binding (e.g., `jQuery(document).on('submit', '#wpmt-otp-set-pw-form', ...)`). Ensure it uses event delegation if the DOM is rendered dynamically.
3. **Transport:** Verify the exact payload sent to `admin-ajax.php` or the REST API.
4. **Handler:** Identify the PHP hook (`wp_ajax_nopriv_my_action` or `wp_ajax_my_action`).
5. **Mutation:** Verify how the frontend consumes the JSON response to update the DOM or show an error message. Every AJAX request MUST have a visible `.error-message` or equivalent DOM target to display failures.

*Checklist for modifications:*
- [ ] Did you change a form or button ID? If yes, update the JS selector.
- [ ] Did you add a new form? If yes, ensure `initAjaxForm` or the equivalent initialization function binds to it.
- [ ] Is the PHP response returning standard WP JSON (`wp_send_json_success` / `wp_send_json_error`)?
- [ ] Does the JS `success` callback explicitly handle `response.success === false`?

## 2. Theme Inheritance & UI Isolation

**Problem:** Relying on complex themes (like Divi or Elementor) for the structural layout of programmatic contexts is fragile. Theme updates or global layout shifts often corrupt injected UI components (e.g., header rendering issues on masterclass posts).

**Protocol:** For critical programmatic UI components (custom headers, checkout flows, authentication modals), **do not rely on theme inheritance.**

- **Namespace CSS:** Wrap custom components in a strict BEM namespace (e.g., `.tesseract-isolated-component *`).
- **Reset Inheritance:** Strip inherited margins, paddings, and line-heights within your namespace.
- **Direct Injection:** Deploy custom CSS/HTML structures via targeted MU-plugins rather than relying on child theme stylesheets or page builders.
- **Shadow DOM (Optional):** If CSS isolation is impossible due to extreme theme !important spam, consider wrapping the component in a Shadow DOM boundary.

## 3. MU-Plugin Priority Conflict Resolution

**Problem:** Multiple plugins (especially MU-plugins) hooking into the same filters (like `authenticate` or `lostpassword_url`) without explicit priority management leads to silent routing overrides and "priority wars".

**Protocol:** When adding or modifying a critical hook:

1. **Audit First:** Never use the default priority `10` blindly. Dump the global `$wp_filter` array for the specific hook to analyze competing functions and their priorities.
2. **Declare Intentional Priority:** Explicitly assign a safe priority index (e.g., `999` to ensure late execution, or `1` for early execution).
3. **Document Why:** Add an inline comment explaining the priority choice. Example:
   ```php
   // Priority 999: Ensure this runs AFTER standard WooCommerce and Theme login redirects
   add_filter('lostpassword_url', 'tesseract_custom_lost_password', 999);
   ```

## 4. WP E2E Testing Generation

**Problem:** PHPUnit tests do not catch frontend JS binding failures. A PHP function can pass all unit tests but fail silently in the browser.

**Protocol:** Any critical flow (Authentication, Checkout, Lead Capture) MUST be verified with Playwright or Puppeteer end-to-end tests that check the DOM state after submission.
- Ensure the test waits for the network response.
- Ensure the test asserts the presence of the success/error message in the DOM.
- Never use hardcoded production URLs in test fixtures; use dynamic staging or local environment variables.

## When to Use This Skill
- Building or modifying WordPress plugins/MU-plugins.
- Creating custom landing pages or programmatic templates.
- Fixing authentication, checkout, or lead capture forms.
- Debugging UI issues on the WordPress site.
