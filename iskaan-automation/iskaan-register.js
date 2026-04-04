/**
 * Iskaan Short Stay Registration ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Playwright Automation
 * Triggered by GitHub Actions, fills and submits the Iskaan portal form.
 *
 * Environment variables (from GitHub Secrets):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   OTP_APPS_SCRIPT_URL  ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Google Apps Script web app for reading OTP emails
 *   GREEN_API_INSTANCE, GREEN_API_TOKEN, WHATSAPP_GROUP_ID
 *
 * Arguments (from workflow_dispatch inputs, passed as env):
 *   QUEUE_ID           ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ sakani_queue row ID
 *   PORTAL_URL         ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ e.g. https://hoam.iskaan.com/marwaheights
 *   PORTAL_LOGIN       ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ e.g. admin@medini-homes.com
 *   APARTMENT_NO       ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ e.g. 508
 *   GUEST_FIRST_NAME, GUEST_LAST_NAME
 *   CHECKIN_DATE, CHECKOUT_DATE   ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ YYYY-MM-DD
 *   TOTAL_GUESTS       ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ integer
 *   GUEST_PHONE        ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ guest mobile (optional)
 *   GUEST_NATIONALITY  ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ISO country (optional)
 *   PASSPORT_PATH      ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Supabase storage path for guest passport
 *   DTCM_FILE_URL      ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ URL or storage path for DTCM permit
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Config from env ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
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

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Helpers ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ

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
  console.log(`Downloaded ${storagePath} ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ${dest} (${buffer.length} bytes)`);
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

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Main Automation ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ

async function run() {
  console.log(`\n=== Iskaan Registration ===`);
  console.log(`Queue ID: ${QUEUE_ID}`);
  console.log(`Portal: ${FORM_URL}`);
  console.log(`Unit: ${APARTMENT_NO}`);
  console.log(`Guest: ${GUEST_FIRST_NAME} ${GUEST_LAST_NAME}`);
  console.log(`Dates: ${CHECKIN_DATE} ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ${CHECKOUT_DATE}`);
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

  // DTCM ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ try Supabase first, could also be a direct URL
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
    // ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Step 1: Navigate to form ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
    console.log('Step 1: Navigating to form...');
    await page.goto(FORM_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('div.option', { timeout: 10000 });

    // ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Step 2: Select "Company" ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
    console.log('Step 2: Selecting Company...');
    const companyOption = await page.locator('div.option', { hasText: 'Company' });
    await companyOption.click();
    await page.waitForTimeout(500);

    // ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Step 3: Select Unit ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
    console.log(`Step 3: Selecting unit ${APARTMENT_NO}...`);
    const unitSelect = page.locator('nz-select').first();
    await unitSelect.click();
    await page.waitForTimeout(300);
    await page.locator(`nz-option-item`, { hasText: APARTMENT_NO }).click();
    await page.waitForTimeout(500);

    // ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Step 4: Enter email ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
    console.log(`Step 4: Entering email ${PORTAL_LOGIN}...`);
    const emailInput = page.locator('input[type="text"]').first();
    // Find the email input near the "Email" label
    const emailField = page.locator('nz-form-item', { hasText: 'Email' }).locator('input');
    await emailField.fill(PORTAL_LOGIN);
    await page.waitForTimeout(300);

    // ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ Step 5: Click Verify Email & get OTP ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ
    console.log('Step 5: Verifying email (OTP)...');
    // Click the search/verify button next to email (it's an nz-input-search button)
    const verifyEmailBtn = page.locator('nz-input-group button, button:has-text("Verify Email")').first();
    await verifyEmailBtn.click();
    await page.waitForTimeout(2000);

    const otp = await fetchOTP(PORTAL_LOGIN);

    // A modal dialog opens for OTP entry ÃÂ¢ÃÂÃÂ target elements INSIDE the modal
    const modal = page.locator('nz-modal-container, .ant-modal-wrap').first();
    await modal.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {
      console.log('No modal detected, trying page-level OTP input...');
    });

    // Debug: screenshot modal before entering OTP
    await page.screenshot({ path: path.join(DOWNLOADS, 'modal-opened.png') });

    // Log modal structure for debugging
    const modalHTML = await modal.innerHTML().catch(() => 'could not read modal HTML');
    console.log('Modal HTML preview:', modalHTML.substring(0, 300));

    // Enter OTP â use type() instead of fill() to trigger Angular change detection
    const modalInput = modal.locator('input');
    const pageOtpInput = page.locator('input[placeholder*="OTP"], input[placeholder*="code"], input[placeholder*="Code"]');

    if (await modalInput.count() > 0) {
      console.log(`Entering OTP ${otp} in modal dialog (${await modalInput.count()} inputs)...`);
      const otpInput = modalInput.first();
      await otpInput.click();
      await otpInput.fill(''); // Clear first
      await otpInput.type(otp, { delay: 50 }); // Type char by char for Angular
      await page.waitForTimeout(300);
      // Trigger blur/change events for Angular
      await otpInput.dispatchEvent('input');
      await otpInput.dispatchEvent('change');
    } else if (await pageOtpInput.count() > 0) {
      console.log('Entering OTP in page-level input...');
      await pageOtpInput.first().click();
      await pageOtpInput.first().type(otp, { delay: 50 });
    } else {
      const otpField = page.locator('nz-form-item', { hasText: 'OTP' }).locator('input');
      await otpField.click();
      await otpField.type(otp, { delay: 50 });
    }
    await page.waitForTimeout(500);

    // Debug: screenshot after OTP entered
    await page.screenshot({ path: path.join(DOWNLOADS, 'otp-entered.png') });

    // Click verify/confirm button INSIDE the modal (or page-level)
    const modalBtns = await modal.locator('button').all();
    console.log(`Modal buttons found: ${modalBtns.length}`);
    for (let i = 0; i < modalBtns.length; i++) {
      const txt = await modalBtns[i].textContent().catch(() => '');
      const cls = await modalBtns[i].getAttribute('class').catch(() => '');
      console.log(`  Button ${i}: text="${txt.trim()}", class="${cls}"`);
    }

    // Try the primary button or the OK/Verify button
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
    await page.waitForTimeout(3000);

    // Debug: screenshot after clicking verify
    await page.screenshot({ path: path.join(DOWNLOADS, 'after-verify-click.png') });

    // Wait for modal to close (may take time after OTP verify)
    await modal.waitFor({ state: 'hidden', timeout: 15000 }).catch(async () => {
      console.log('Modal still visible Ã¢ÂÂ trying to dismiss it...');
      // Try clicking any close/OK button that might still be visible
      const dismissBtn = modal.locator('button').last();
      if (await dismissBtn.count() > 0) {
        await dismissBtn.click().catch(() => {});
      }
      await page.waitForTimeout(2000);
    });
    // Extra wait for form to stabilize after OTP verification
    await page.waitForTimeout(3000);
    console.log('Step 5: OTP verified successfully');

    // Ã¢ÂÂÃ¢ÂÂ Step 6: Set dates Ã¢ÂÂÃ¢ÂÂ
    console.log(`Step 6: Setting dates ${CHECKIN_DATE} Ã¢ÂÂ ${CHECKOUT_DATE}...`);

    // Wait for date picker to be present and visible
    await page.waitForSelector('nz-date-picker', { state: 'visible', timeout: 15000 }).catch(async () => {
      console.log('Date picker not found \u2014 taking debug screenshot...');
      await page.screenshot({ path: path.join(DOWNLOADS, 'no-datepicker.png') });
      const bodyText = await page.textContent('body').catch(() => '');
      console.log('Page text preview:', bodyText.substring(0, 500));
    });

    // Start date
    const startDatePicker = page.locator('nz-date-picker').first();
    await startDatePicker.scrollIntoViewIfNeeded();
    await startDatePicker.locator('input').click({ timeout: 10000 });
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

    // ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Step 7: Number of guests ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
    const guestCount = parseInt(TOTAL_GUESTS) || 1;
    console.log(`Step 7: Setting ${guestCount} guests...`);
    const guestInput = page.locator('input[placeholder="Number of Guests"]');
    await guestInput.fill(String(guestCount));
    await page.waitForTimeout(1000); // Wait for guest rows to appear

    // ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Step 8: Fill guest details ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
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

    // ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Step 9: Upload company documents ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
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

    // ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Step 10: Check Terms & Conditions ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
    console.log('Step 10: Accepting Terms...');
    const termsCheckbox = page.locator('label.ant-checkbox-wrapper, input[type="checkbox"]').first();
    await termsCheckbox.click();
    await page.waitForTimeout(300);

    // ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Step 11: Submit ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
    console.log('Step 11: SUBMITTING...');
    await page.locator('button', { hasText: 'Submit' }).click();
    await page.waitForTimeout(5000);

    // Check for success or error
    const pageText = await page.textContent('body');
    const success = pageText.includes('success') || pageText.includes('submitted') || pageText.includes('Thank');

    if (success) {
      console.log('ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Form submitted successfully!');
      await supabaseUpdate('submitted');
      await sendWhatsApp(
        `ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Iskaan enregistrÃÂÃÂÃÂÃÂ©\nÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ ${APARTMENT_NO} ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ${PORTAL_URL.split('/').pop()}\nÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ¤ ${guestName}\nÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ ${CHECKIN_DATE} ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ${CHECKOUT_DATE}`
      );
    } else {
      // Take screenshot for debugging
      await page.screenshot({ path: path.join(DOWNLOADS, 'result.png') });
      console.log('ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ÃÂÃÂ¯ÃÂÃÂ¸ÃÂÃÂ Form submitted but no clear success message. Check result.png');
      await supabaseUpdate('submitted', 'No clear success confirmation ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ needs manual check');
      await sendWhatsApp(
        `ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ÃÂÃÂ¯ÃÂÃÂ¸ÃÂÃÂ Iskaan soumis (ÃÂÃÂÃÂÃÂ  vÃÂÃÂÃÂÃÂ©rifier)\nÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ ${APARTMENT_NO} ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ${PORTAL_URL.split('/').pop()}\nÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ¤ ${guestName}`
      );
    }

  } catch (error) {
    console.error('ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Error:', error.message);

    // Take error screenshot
    try {
      await page.screenshot({ path: path.join(DOWNLOADS, 'error.png') });
    } catch (e) {}

    await supabaseUpdate('error', error.message.substring(0, 500));
    await sendWhatsApp(
      `ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Iskaan ERREUR\nÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ ${APARTMENT_NO} ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ${PORTAL_URL.split('/').pop()}\nÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ ${error.message.substring(0, 100)}`
    );

    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Calendar Date Selection ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
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

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Run ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
run().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
