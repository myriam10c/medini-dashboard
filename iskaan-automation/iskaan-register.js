/**
 * Iskaan Short Stay Registration â Playwright Automation
 * Triggered by GitHub Actions, fills and submits the Iskaan portal form.
 *
 * Environment variables (from GitHub Secrets):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   OTP_APPS_SCRIPT_URL  â Google Apps Script web app for reading OTP emails
 *   GREEN_API_INSTANCE, GREEN_API_TOKEN, WHATSAPP_GROUP_ID
 *
 * Arguments (from workflow_dispatch inputs, passed as env):
 *   QUEUE_ID           â sakani_queue row ID
 *   PORTAL_URL         â e.g. https://hoam.iskaan.com/marwaheights
 *   PORTAL_LOGIN       â e.g. admin@medini-homes.com
 *   APARTMENT_NO       â e.g. 508
 *   GUEST_FIRST_NAME, GUEST_LAST_NAME
 *   CHECKIN_DATE, CHECKOUT_DATE   â YYYY-MM-DD
 *   TOTAL_GUESTS       â integer
 *   GUEST_PHONE        â guest mobile (optional)
 *   GUEST_NATIONALITY  â ISO country (optional)
 *   PASSPORT_PATH      â Supabase storage path for guest passport
 *   DTCM_FILE_URL      â URL or storage path for DTCM permit
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// âââ Config from env âââ
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

// âââ Helpers âââ

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

  // Try direct public URL first, then authenticated
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
  console.log(`Downloaded ${storagePath} â ${dest} (${buffer.length} bytes)`);
  return dest;
}

async function fetchOTP(loginEmail, maxRetries = 12) {
  // Poll the Apps Script endpoint for OTP from noreply@mail.iskaan.com
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
    await new Promise(r => setTimeout(r, 5000)); // Wait 5s between polls
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

// Format date for Iskaan calendar: M/D/YYYY
function formatDateForCalendar(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${parseInt(m)}/${parseInt(d)}/${y}`;
}

// âââ Main Automation âââ

async function run() {
  console.log(`\n=== Iskaan Registration ===`);
  console.log(`Queue ID: ${QUEUE_ID}`);
  console.log(`Portal: ${FORM_URL}`);
  console.log(`Unit: ${APARTMENT_NO}`);
  console.log(`Guest: ${GUEST_FIRST_NAME} ${GUEST_LAST_NAME}`);
  console.log(`Dates: ${CHECKIN_DATE} â ${CHECKOUT_DATE}`);
  console.log(`Guests: ${TOTAL_GUESTS}\n`);

  fs.mkdirSync(DOWNLOADS, { recursive: true });

  // Update status to processing
  await supabaseUpdate('processing');

  // Download documents
  const tradeLicensePath = await downloadFromSupabase(
    'company-docs/trade-license/trade_license_2026.pdf', 'trade_license.pdf'
  );
  const eidPath = await downloadFromSupabase(
    'company-docs/eid/hillal_medini_eid.jpeg', 'eid.jpeg'
  );
  const passportPath = PASSPORT_PATH
    ? await downloadFromSupabase(PASSPORT_PATH, 'passport.pdf')
    : null;

  // DTCM â try Supabase first, could also be a direct URL
  let dtcmPath = null;
  if (DTCM_FILE_URL) {
    dtcmPath = await downloadFromSupabase(DTCM_FILE_URL, 'dtcm_permit.pdf');
  }

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'en-US'
  });
  const page = await context.newPage();

  try {
    // ââ Step 1: Navigate to form ââ
    console.log('Step 1: Navigating to form...');
    await page.goto(FORM_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('div.option', { timeout: 10000 });

    // ââ Step 2: Select "Company" ââ
    console.log('Step 2: Selecting Company...');
    const companyOption = await page.locator('div.option', { hasText: 'Company' });
    await companyOption.click();
    await page.waitForTimeout(500);

    // ââ Step 3: Select Unit ââ
    console.log(`Step 3: Selecting unit ${APARTMENT_NO}...`);
    const unitSelect = page.locator('nz-select').first();
    await unitSelect.click();
    await page.waitForTimeout(300);
    await page.locator(`nz-option-item`, { hasText: APARTMENT_NO }).click();
    await page.waitForTimeout(500);

    // ââ Step 4: Enter email ââ
    console.log(`Step 4: Entering email ${PORTAL_LOGIN}...`);
    const emailInput = page.locator('input[type="text"]').first();
    // Find the email input near the "Email" label
    const emailField = page.locator('nz-form-item', { hasText: 'Email' }).locator('input');
    await emailField.fill(PORTAL_LOGIN);
    await page.waitForTimeout(300);

    // ── Step 5: Click Verify Email & get OTP ──
    console.log('Step 5: Verifying email (OTP)...');
    // Click the search/verify button next to email (it's an nz-input-search button)
    const verifyEmailBtn = page.locator('nz-input-group button, button:has-text("Verify Email")').first();
    await verifyEmailBtn.click();
    await page.waitForTimeout(2000);

    const otp = await fetchOTP(PORTAL_LOGIN);

    // A modal dialog opens for OTP entry — target elements INSIDE the modal
    const modal = page.locator('nz-modal-container, .ant-modal-wrap').first();
    await modal.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {
      console.log('No modal detected, trying page-level OTP input...');
    });

    // Enter OTP — try modal first, then page level
    const modalInput = modal.locator('input');
    const pageOtpInput = page.locator('input[placeholder*="OTP"], input[placeholder*="code"], input[placeholder*="Code"]');

    if (await modalInput.count() > 0) {
      console.log('Entering OTP in modal dialog...');
      await modalInput.first().fill(otp);
    } else if (await pageOtpInput.count() > 0) {
      console.log('Entering OTP in page-level input...');
      await pageOtpInput.first().fill(otp);
    } else {
      // Fallback: try OTP form item
      const otpField = page.locator('nz-form-item', { hasText: 'OTP' }).locator('input');
      await otpField.fill(otp);
    }
    await page.waitForTimeout(500);

    // Click verify/confirm button INSIDE the modal (or page-level)
    const modalVerifyBtn = modal.locator('button');
    const pageVerifyBtn = page.locator('button', { hasText: /verify|confirm|submit/i });

    if (await modalVerifyBtn.count() > 0) {
      console.log('Clicking verify button inside modal...');
      // Click the primary/confirm button in the modal
      const primaryBtn = modal.locator('button.ant-btn-primary, button:has-text("OK"), button:has-text("Verify"), button:has-text("Confirm")').first();
      if (await primaryBtn.count() > 0) {
        await primaryBtn.click();
      } else {
        await modalVerifyBtn.last().click();
      }
    } else {
      await pageVerifyBtn.first().click();
    }
    await page.waitForTimeout(3000);

    // Wait for modal to close
    await modal.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {
      console.log('Modal still visible after verify — might need manual check');
    });
    console.log('Step 5: OTP verified successfully');


    // ââ Step 6: Set dates ââ
    console.log(`Step 6: Setting dates ${CHECKIN_DATE} â ${CHECKOUT_DATE}...`);

    // Start date
    const startDatePicker = page.locator('nz-date-picker').first();
    await startDatePicker.locator('input').click();
    await page.waitForTimeout(300);

    // Navigate calendar and click the right date
    await selectCalendarDate(page, CHECKIN_DATE);
    await page.waitForTimeout(500);

    // End date
    const endDatePicker = page.locator('nz-date-picker').nth(1);
    await endDatePicker.locator('input').click();
    await page.waitForTimeout(300);
    await selectCalendarDate(page, CHECKOUT_DATE);
    await page.waitForTimeout(500);

    // ââ Step 7: Number of guests ââ
    const guestCount = parseInt(TOTAL_GUESTS) || 1;
    console.log(`Step 7: Setting ${guestCount} guests...`);
    const guestInput = page.locator('input[placeholder="Number of Guests"]');
    await guestInput.fill(String(guestCount));
    await page.waitForTimeout(1000); // Wait for guest rows to appear

    // ââ Step 8: Fill guest details ââ
    console.log('Step 8: Filling guest details...');
    const guestName = `${GUEST_FIRST_NAME} ${GUEST_LAST_NAME}`.trim();

    // Guest 1 name
    const nameInputs = page.locator('input[placeholder="Enter Name here"]');
    await nameInputs.first().fill(guestName);

    // Guest 1 mobile
    if (GUEST_PHONE) {
      const mobileInputs = page.locator('input[placeholder="Enter Mobile Number"]');
      const phone = GUEST_PHONE.replace(/[+\s\-()]/g, '').replace(/^971/, '');
      await mobileInputs.first().fill(phone);
    }

    // Guest 1 passport upload
    if (passportPath) {
      const fileInputs = page.locator('input[type="file"]');
      await fileInputs.nth(0).setInputFiles(passportPath);
      await page.waitForTimeout(500);
    }

    // If multiple guests, fill remaining with placeholder data
    for (let i = 1; i < guestCount; i++) {
      if (await nameInputs.nth(i).count() > 0) {
        await nameInputs.nth(i).fill(`Guest ${i + 1}`);
      }
      const mobileInputs = page.locator('input[placeholder="Enter Mobile Number"]');
      if (await mobileInputs.nth(i).count() > 0) {
        await mobileInputs.nth(i).fill('501234567');
      }
    }

    // ââ Step 9: Upload company documents ââ
    console.log('Step 9: Uploading company documents...');
    const fileInputs = page.locator('input[type="file"]');
    const fileInputCount = await fileInputs.count();

    // File inputs order: passport(s)..., DTCM, Trade License, EID
    // DTCM is at index [guestCount], Trade at [guestCount+1], EID at [guestCount+2]
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

    // ââ Step 10: Check Terms & Conditions ââ
    console.log('Step 10: Accepting Terms...');
    const termsCheckbox = page.locator('label.ant-checkbox-wrapper, input[type="checkbox"]').first();
    await termsCheckbox.click();
    await page.waitForTimeout(300);

    // ââ Step 11: Submit ââ
    console.log('Step 11: SUBMITTING...');
    await page.locator('button', { hasText: 'Submit' }).click();
    await page.waitForTimeout(5000);

    // Check for success or error
    const pageText = await page.textContent('body');
    const success = pageText.includes('success') || pageText.includes('submitted') || pageText.includes('Thank');

    if (success) {
      console.log('â Form submitted successfully!');
      await supabaseUpdate('submitted');
      await sendWhatsApp(
        `â Iskaan enregistrÃ©\nð ${APARTMENT_NO} â ${PORTAL_URL.split('/').pop()}\nð¤ ${guestName}\nð ${CHECKIN_DATE} â ${CHECKOUT_DATE}`
      );
    } else {
      // Take screenshot for debugging
      await page.screenshot({ path: path.join(DOWNLOADS, 'result.png') });
      console.log('â ï¸ Form submitted but no clear success message. Check result.png');
      await supabaseUpdate('submitted', 'No clear success confirmation â needs manual check');
      await sendWhatsApp(
        `â ï¸ Iskaan soumis (Ã  vÃ©rifier)\nð ${APARTMENT_NO} â ${PORTAL_URL.split('/').pop()}\nð¤ ${guestName}`
      );
    }

  } catch (error) {
    console.error('â Error:', error.message);

    // Take error screenshot
    try {
      await page.screenshot({ path: path.join(DOWNLOADS, 'error.png') });
    } catch (e) {}

    await supabaseUpdate('error', error.message.substring(0, 500));
    await sendWhatsApp(
      `â Iskaan ERREUR\nð ${APARTMENT_NO} â ${PORTAL_URL.split('/').pop()}\nð ${error.message.substring(0, 100)}`
    );

    process.exit(1);
  } finally {
    await browser.close();
  }
}

// âââ Calendar Date Selection âââ
// Iskaan uses NG-ZORRO date picker. Dates before today+9 are disabled.
async function selectCalendarDate(page, isoDate) {
  const targetTitle = formatDateForCalendar(isoDate);

  // Try clicking the cell with the matching title
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
    // Navigate to next month
    await page.locator('button.ant-picker-header-next-btn').click();
    await page.waitForTimeout(300);
  }
  throw new Error(`Could not find date ${isoDate} in calendar after ${maxNavAttempts} attempts`);
}

// âââ Run âââ
run().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
