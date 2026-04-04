/**
 * Iskaan Short Stay Registration — Playwright Automation
 * Triggered by GitHub Actions, fills and submits the Iskaan portal form.
 *
 * Environment variables (from GitHub Secrets):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   OTP_APPS_SCRIPT_URL  — Google Apps Script web app for reading OTP emails
 *   GREEN_API_INSTANCE, GREEN_API_TOKEN, WHATSAPP_GROUP_ID
 *
 * Arguments (from workflow_dispatch inputs, passed as env):
 *   QUEUE_ID           — sakani_queue row ID
 *   PORTAL_URL         — e.g. https://hoam.iskaan.com/marwaheights
 *   PORTAL_LOGIN       — e.g. admin@medini-homes.com
 *   APARTMENT_NO       — e.g. 508
 *   GUEST_FIRST_NAME, GUEST_LAST_NAME
 *   CHECKIN_DATE, CHECKOUT_DATE   — YYYY-MM-DD
 *   TOTAL_GUESTS       — integer
 *   GUEST_PHONE        — guest mobile (optional)
 *   GUEST_NATIONALITY  — ISO country (optional)
 *   PASSPORT_PATH      — Supabase storage path for guest passport
 *   DTCM_FILE_URL      — URL or storage path for DTCM permit
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── Config from env ───
const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  OTP_APPS_SCRIPT_URL,
  GREEN_API_INSTANCE, GREEN_API_TOKEN, WHATSAPP_GROUP_ID,
  QUEUE_ID, PORTAL_URL, PORTAL_LOGIN, APARTMENT_NO,
  GUEST_FIRST_NAME, GUEST_LAST_NAME,
  CHECKIN_DATE, CHECKOUT_DATE,
  TOTAL_GUESTS,
  GUEST_PHONE, GUEST_NATIONALITY,
  PASSPORT_PATH, DTCM_FILE_URL
} = process.env;

const FORM_URL = PORTAL_URL.replace(/\/$/, '') + '/eservices/short-stay';
const DOWNLOADS = path.join(__dirname, 'downloads');

// ─── Helpers ───

async function supabaseUpdate(status, errorMessage = null) {
  const body = { status, updated_at: new Date().toISOString() };
  if (errorMessage) body.error_message = errorMessage;
  if (status === 'submitted') body.submitted_at = new Date().toISOString();

  await fetch(`${SUPABASE_URL}/rest/v1/sakani_queue?id=eq.${QUEUE_ID}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(body)
  });
}

async function downloadFromSupabase(storagePath, filename) {
  if (!storagePath) return null;
  const bucket = storagePath.split('/')[0] || 'company-docs';
  const filePath = storagePath.includes('/') ? storagePath : `company-docs/${storagePath}`;

  const url = `${SUPABASE_URL}/storage/v1/object/${filePath}`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });

  if (!res.ok) {
    console.log(`Failed to download ${storagePath}: ${res.status}`);
    return null;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const dest = path.join(DOWNLOADS, filename);
  fs.writeFileSync(dest, buffer);
  console.log(`Downloaded ${storagePath} → ${dest} (${buffer.length} bytes)`);
  return dest;
}

async function fetchOTP(loginEmail, maxRetries = 12) {
  for (let i = 0; i < maxRetries; i++) {
    console.log(`Polling OTP (attempt ${i + 1}/${maxRetries})...`);
    try {
      const url = `${OTP_APPS_SCRIPT_URL}?email=${encodeURIComponent(loginEmail)}`;
      const res = await fetch(url);
      const text = await res.text();
      if (text && text !== 'NO_OTP' && /^\d{4,6}$/.test(text.trim())) {
        console.log(`OTP received: ${text.trim()}`);
        return text.trim();
      }
    } catch (e) {
      console.log(`OTP fetch error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('OTP not received after ' + maxRetries + ' attempts');
}
async function sendWhatsApp(message) {
  if (!GREEN_API_INSTANCE || !GREEN_API_TOKEN) return;
  try {
    await fetch(
      `https://api.green-api.com/waInstance${GREEN_API_INSTANCE}/sendMessage/${GREEN_API_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: WHATSAPP_GROUP_ID, message })
      }
    );
  } catch (e) {
    console.log('WhatsApp notification failed:', e.message);
  }
}

function formatDateForCalendar(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(m)}/${parseInt(d)}/${y}`;
}

// ─── Main Automation ───

async function run() {
  console.log(`\n=== Iskaan Registration ===`);
  console.log(`Queue ID: ${QUEUE_ID}`);
  console.log(`Portal: ${FORM_URL}`);
  console.log(`Unit: ${APARTMENT_NO}`);
  console.log(`Guest: ${GUEST_FIRST_NAME} ${GUEST_LAST_NAME}`);
  console.log(`Dates: ${CHECKIN_DATE} → ${CHECKOUT_DATE}`);
  console.log(`Guests: ${TOTAL_GUESTS}\n`);

  fs.mkdirSync(DOWNLOADS, { recursive: true });
  await supabaseUpdate('processing');

  const tradeLicensePath = await downloadFromSupabase(
    'company-docs/trade-license/trade_license_2026.pdf', 'trade_license.pdf'
  );
  const eidPath = await downloadFromSupabase(
    'company-docs/eid/hillal_medini_eid.jpeg', 'eid.jpeg'
  );
  const passportPath = PASSPORT_PATH
    ? await downloadFromSupabase(PASSPORT_PATH, 'passport.pdf')
    : null;

  let dtcmPath = null;
  if (DTCM_FILE_URL) {
    dtcmPath = await downloadFromSupabase(DTCM_FILE_URL, 'dtcm_permit.pdf');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'en-US'
  });
  const page = await context.newPage();

  try {
    // ── Step 1: Navigate to form ──
    console.log('Step 1: Navigating to form...');
    await page.goto(FORM_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('div.option', { timeout: 10000 });

    // ── Step 2: Select Company ──
    console.log('Step 2: Selecting Company...');
    const companyOption = await page.locator('div.option', { hasText: 'Company' });
    await companyOption.click();
    await page.waitForTimeout(500);

    // ── Step 3: Select Unit ──
    console.log(`Step 3: Selecting unit ${APARTMENT_NO}...`);
    const unitSelect = page.locator('nz-select').first();
    await unitSelect.click();
    await page.waitForTimeout(300);
    await page.locator(`nz-option-item`, { hasText: APARTMENT_NO }).click();
    await page.waitForTimeout(500);

    // ── Step 4: Enter email ──
    console.log(`Step 4: Entering email ${PORTAL_LOGIN}...`);
    const emailInput = page.locator('input[type="text"]').first();
    const emailField = page.locator('nz-form-item', { hasText: 'Email' }).locator('input');
    await emailField.fill(PORTAL_LOGIN);
    await page.waitForTimeout(300);

    // ── Step 5: Click Verify Email & get OTP ──
    console.log('Step 5: Verifying email (OTP)...');
    const verifyEmailBtn = page.locator('nz-input-group button, button:has-text("Verify Email")').first();
    await verifyEmailBtn.click();
    await page.waitForTimeout(2000);

    const otp = await fetchOTP(PORTAL_LOGIN);

    const modal = page.locator('nz-modal-container, .ant-modal-wrap').first();
    await modal.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {
      console.log('No modal detected, trying page-level OTP input...');
    });

    await page.screenshot({ path: path.join(DOWNLOADS, 'modal-opened.png') });
    const modalHTML = await modal.innerHTML().catch(() => 'could not read modal HTML');
    console.log('Modal HTML preview:', modalHTML.substring(0, 300));
    // Enter OTP using native input value setter to properly trigger Angular ngModel
    const modalInput = modal.locator('input');
    const pageOtpInput = page.locator('input[placeholder*="OTP"], input[placeholder*="code"], input[placeholder*="Code"]');

    if (await modalInput.count() > 0) {
      console.log(`Entering OTP ${otp} in modal dialog (${await modalInput.count()} inputs)...`);
      const otpInput = modalInput.first();
      await otpInput.click();

      // Use native value setter — this is the reliable way to update Angular reactive forms
      await page.evaluate((otpValue) => {
        const modal = document.querySelector('.ant-modal-content') || document.querySelector('nz-modal-container');
        const input = modal ? modal.querySelector('input') : document.querySelector('.ant-modal-wrap input');
        if (!input) throw new Error('OTP input not found in modal');

        // Native setter bypasses Angular's event system, then we fire all events Angular listens for
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(input, otpValue);

        // Fire all events Angular might listen on
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
      }, otp);

      // Verify the value was actually set
      const setValue = await otpInput.inputValue();
      console.log(`OTP input value after set: "${setValue}"`);
    } else if (await pageOtpInput.count() > 0) {
      console.log('Entering OTP in page-level input...');
      await pageOtpInput.first().click();
      await page.evaluate((otpValue) => {
        const input = document.querySelector('input[placeholder*="OTP"], input[placeholder*="code"], input[placeholder*="Code"]');
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(input, otpValue);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, otp);
    } else {
      console.log('No modal/page OTP input found — trying nz-form-item fallback...');
      const otpField = page.locator('nz-form-item', { hasText: 'OTP' }).locator('input');
      await otpField.click();
      await otpField.type(otp, { delay: 50 });
    }
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(DOWNLOADS, 'otp-entered.png') });

    // Click verify/confirm button INSIDE the modal
    const modalBtns = await modal.locator('button').all();
    console.log(`Modal buttons found: ${modalBtns.length}`);
    for (let i = 0; i < modalBtns.length; i++) {
      const txt = await modalBtns[i].textContent().catch(() => '');
      const cls = await modalBtns[i].getAttribute('class').catch(() => '');
      console.log(`  Button ${i}: text="${txt.trim()}", class="${cls}"`);
    }

    const primaryBtn = modal.locator('button.ant-btn-primary').first();
    const okBtn = modal.locator('button:has-text("OK"), button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Submit")').first();

    if (await primaryBtn.count() > 0) {
      console.log('Clicking primary button inside modal (JS click)...');
      await primaryBtn.evaluate(btn => btn.click());
    } else if (await okBtn.count() > 0) {
      console.log('Clicking OK/Verify button inside modal (JS click)...');
      await okBtn.evaluate(btn => btn.click());
    } else if (modalBtns.length > 0) {
      console.log('Clicking last button in modal as fallback (JS click)...');
      await modalBtns[modalBtns.length - 1].evaluate(btn => btn.click());
    }

    // Wait and capture modal state AFTER clicking verify
    await page.waitForTimeout(5000);

    await page.screenshot({ path: path.join(DOWNLOADS, 'after-verify-click.png') });

    // Log modal HTML after verify click — check for error messages
    const postClickModalHTML = await modal.innerHTML().catch(() => 'modal gone (good!)');
    console.log('Modal after verify click:', postClickModalHTML.substring(0, 500));

    const modalStillVisible = await modal.isVisible().catch(() => false);
    console.log(`Modal still visible after verify: ${modalStillVisible}`);

    if (modalStillVisible) {
      const modalText = await modal.textContent().catch(() => '');
      console.log(`Modal text after verify: "${modalText.trim()}"`);

      if (modalText.includes('Invalid') || modalText.includes('expired') || modalText.includes('incorrect')) {
        console.log('OTP error detected — code may be expired or invalid');
      }

      // Try Playwright .click() as second attempt
      console.log('Trying Playwright .click() as second attempt...');
      const retryBtn = modal.locator('button.ant-btn-primary, button:has-text("Verify"), button:has-text("OK")').first();
      if (await retryBtn.count() > 0) {
        await retryBtn.click({ force: true });
        await page.waitForTimeout(5000);
        await page.screenshot({ path: path.join(DOWNLOADS, 'after-retry-click.png') });
        const retryModalText = await modal.textContent().catch(() => '');
        console.log(`Modal text after retry: "${retryModalText.trim()}"`);
      }
    }

    // Wait for modal to close
    await modal.waitFor({ state: 'hidden', timeout: 15000 }).catch(async () => {
      console.log('Modal still visible after all attempts — force dismissing...');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      await page.locator('.ant-modal-mask, .cdk-overlay-backdrop').first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(2000);
    });
    await page.waitForTimeout(3000);
    console.log('Step 5: OTP verification complete');

    // ── Step 6: Set dates ──
    console.log(`Step 6: Setting dates ${CHECKIN_DATE} → ${CHECKOUT_DATE}...`);

    await page.waitForSelector('nz-date-picker', { state: 'visible', timeout: 15000 }).catch(async () => {
      console.log('Date picker not found — taking debug screenshot...');
      await page.screenshot({ path: path.join(DOWNLOADS, 'no-datepicker.png') });
      const bodyText = await page.textContent('body').catch(() => '');
      console.log('Page text preview:', bodyText.substring(0, 500));
    });

    const startDatePicker = page.locator('nz-date-picker').first();
    await startDatePicker.scrollIntoViewIfNeeded();
    await startDatePicker.locator('input').click({ timeout: 10000 });
    await page.waitForTimeout(300);
    await selectCalendarDate(page, CHECKIN_DATE);
    await page.waitForTimeout(500);

    const endDatePicker = page.locator('nz-date-picker').nth(1);
    await endDatePicker.locator('input').click();
    await page.waitForTimeout(300);
    await selectCalendarDate(page, CHECKOUT_DATE);
    await page.waitForTimeout(500);

    // ── Step 7: Number of guests ──
    const guestCount = parseInt(TOTAL_GUESTS) || 1;
    console.log(`Step 7: Setting ${guestCount} guests...`);
    const guestInput = page.locator('input[placeholder="Number of Guests"]');
    await guestInput.fill(String(guestCount));
    await page.waitForTimeout(1000);

    // ── Step 8: Fill guest details ──
    console.log('Step 8: Filling guest details...');
    const guestName = `${GUEST_FIRST_NAME} ${GUEST_LAST_NAME}`.trim();
    const nameInputs = page.locator('input[placeholder="Enter Name here"]');
    await nameInputs.first().fill(guestName);

    if (GUEST_PHONE) {
      const mobileInputs = page.locator('input[placeholder="Enter Mobile Number"]');
      const phone = GUEST_PHONE.replace(/[+\s\-()]/g, '').replace(/^971/, '');
      await mobileInputs.first().fill(phone);
    }

    if (passportPath) {
      const fileInputs = page.locator('input[type="file"]');
      await fileInputs.nth(0).setInputFiles(passportPath);
      await page.waitForTimeout(500);
    }

    for (let i = 1; i < guestCount; i++) {
      if (await nameInputs.nth(i).count() > 0) {
        await nameInputs.nth(i).fill(`Guest ${i + 1}`);
      }
      const mobileInputs = page.locator('input[placeholder="Enter Mobile Number"]');
      if (await mobileInputs.nth(i).count() > 0) {
        await mobileInputs.nth(i).fill('501234567');
      }
    }

    // ── Step 9: Upload company documents ──
    console.log('Step 9: Uploading company documents...');
    const fileInputs = page.locator('input[type="file"]');
    const fileInputCount = await fileInputs.count();
    const dtcmIndex = guestCount;
    const tradeIndex = guestCount + 1;
    const eidIndex = guestCount + 2;

    if (dtcmPath && dtcmIndex < fileInputCount) {
      await fileInputs.nth(dtcmIndex).setInputFiles(dtcmPath);
      console.log('  DTCM uploaded');
      await page.waitForTimeout(500);
    }
    if (tradeLicensePath && tradeIndex < fileInputCount) {
      await fileInputs.nth(tradeIndex).setInputFiles(tradeLicensePath);
      console.log('  Trade License uploaded');
      await page.waitForTimeout(500);
    }
    if (eidPath && eidIndex < fileInputCount) {
      await fileInputs.nth(eidIndex).setInputFiles(eidPath);
      console.log('  EID uploaded');
      await page.waitForTimeout(500);
    }

    // ── Step 10: Check Terms & Conditions ──
    console.log('Step 10: Accepting Terms...');
    const termsCheckbox = page.locator('label.ant-checkbox-wrapper, input[type="checkbox"]').first();
    await termsCheckbox.click();
    await page.waitForTimeout(300);

    // ── Step 11: Submit ──
    console.log('Step 11: SUBMITTING...');
    await page.locator('button', { hasText: 'Submit' }).click();
    await page.waitForTimeout(5000);

    const pageText = await page.textContent('body');
    const success = pageText.includes('success') || pageText.includes('submitted') || pageText.includes('Thank');

    if (success) {
      console.log('✅ Form submitted successfully!');
      await supabaseUpdate('submitted');
      await sendWhatsApp(
        `✅ Iskaan enregistré\n📍 ${APARTMENT_NO} — ${PORTAL_URL.split('/').pop()}\n👤 ${guestName}\n📅 ${CHECKIN_DATE} → ${CHECKOUT_DATE}`
      );
    } else {
      await page.screenshot({ path: path.join(DOWNLOADS, 'result.png') });
      console.log('⚠️ Form submitted but no clear success message. Check result.png');
      await supabaseUpdate('submitted', 'No clear success confirmation — needs manual check');
      await sendWhatsApp(
        `⚠️ Iskaan soumis (à vérifier)\n📍 ${APARTMENT_NO} — ${PORTAL_URL.split('/').pop()}\n👤 ${guestName}`
      );
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    try {
      await page.screenshot({ path: path.join(DOWNLOADS, 'error.png') });
    } catch (e) {}
    await supabaseUpdate('error', error.message.substring(0, 500));
    await sendWhatsApp(
      `❌ Iskaan ERREUR\n📍 ${APARTMENT_NO} — ${PORTAL_URL.split('/').pop()}\n🐛 ${error.message.substring(0, 100)}`
    );
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ─── Calendar Date Selection ───
async function selectCalendarDate(page, isoDate) {
  const targetTitle = formatDateForCalendar(isoDate);
  const maxNavAttempts = 6;
  for (let attempt = 0; attempt < maxNavAttempts; attempt++) {
    const cell = page.locator(`td[title="${targetTitle}"]`);
    if (await cell.count() > 0) {
      const isDisabled = await cell.getAttribute('class');
      if (isDisabled && isDisabled.includes('disabled')) {
        throw new Error(`Date ${isoDate} is disabled (minimum is today + 9 days)`);
      }
      await cell.locator('.ant-picker-cell-inner').click();
      return;
    }
    await page.locator('button.ant-picker-header-next-btn').click();
    await page.waitForTimeout(300);
  }
  throw new Error(`Could not find date ${isoDate} in calendar after ${maxNavAttempts} attempts`);
}

// ─── Run ───
run().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
