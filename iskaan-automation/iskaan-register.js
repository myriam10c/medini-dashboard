/**
 * Iskaan Short-Stay Registration â v2 (clean rewrite)
 *
 * Playwright headless automation for the Iskaan portal.
 * Triggered by GitHub Actions via workflow_dispatch.
 *
 * ENV (GitHub Secrets):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   OTP_APPS_SCRIPT_URL   â Google Apps Script that reads OTP from Gmail
 *   GREEN_API_INSTANCE, GREEN_API_TOKEN, WHATSAPP_GROUP_ID
 *
 * ENV (workflow inputs):
 *   QUEUE_ID, PORTAL_URL, PORTAL_LOGIN, APARTMENT_NO
 *   GUEST_FIRST_NAME, GUEST_LAST_NAME
 *   CHECKIN_DATE, CHECKOUT_DATE (YYYY-MM-DD)
 *   TOTAL_GUESTS, GUEST_PHONE, GUEST_NATIONALITY
 *   PASSPORT_PATH, DTCM_FILE_URL
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ââ Config ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  OTP_APPS_SCRIPT_URL,
  GREEN_API_INSTANCE, GREEN_API_TOKEN, WHATSAPP_GROUP_ID,
  QUEUE_ID, PORTAL_URL, PORTAL_LOGIN, APARTMENT_NO,
  GUEST_FIRST_NAME, GUEST_LAST_NAME,
  CHECKIN_DATE, CHECKOUT_DATE,
  TOTAL_GUESTS, GUEST_PHONE, GUEST_NATIONALITY,
  PASSPORT_PATH, DTCM_FILE_URL
} = process.env;

const FORM_URL = PORTAL_URL.replace(/\/$/, '') + '/eservices/short-stay';
const DL_DIR  = path.join(__dirname, 'downloads');

// ââ Helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

/** Update sakani_queue row in Supabase */
async function updateQueue(status, errorMsg = null) {
  const body = { status, updated_at: new Date().toISOString() };
  if (errorMsg) body.error_message = errorMsg.substring(0, 500);
  if (status === 'submitted') body.submitted_at = new Date().toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/sakani_queue?id=eq.${QUEUE_ID}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
}

/** Download a file from Supabase Storage â local disk */
async function dlFromStorage(storagePath, localName) {
  if (!storagePath) return null;
  const p = storagePath.includes('/') ? storagePath : `company-docs/${storagePath}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${p}`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!res.ok) { console.log(`  â  Download failed: ${p} (${res.status})`); return null; }
  const dest = path.join(DL_DIR, localName);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`  â ${localName} (${fs.statSync(dest).size} bytes)`);
  return dest;
}

/** Drain stale OTP then poll for fresh one */
async function getOTP(email) {
  const url = `${OTP_APPS_SCRIPT_URL}?email=${encodeURIComponent(email)}`;
  // 1) Drain any cached/stale OTP from previous runs
  try { await (await fetch(url)).text(); } catch (_) {}
  // 2) Small pause to let drain settle
  await new Promise(r => setTimeout(r, 1500));
  // 3) Return a poller â caller triggers the OTP email first, then calls poll()
  return {
    async poll(maxAttempts = 15) {
      for (let i = 1; i <= maxAttempts; i++) {
        console.log(`  OTP poll ${i}/${maxAttempts}...`);
        try {
          const txt = (await (await fetch(url)).text()).trim();
          if (txt && txt !== 'NO_OTP' && /^\d{4,6}$/.test(txt)) {
            console.log(`  â OTP: ${txt}`);
            return txt;
          }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 5000));
      }
      throw new Error('OTP not received after polling');
    },
  };
}

/** Send WhatsApp notification via Green API */
async function whatsapp(message) {
  if (!GREEN_API_INSTANCE || !GREEN_API_TOKEN) return;
  try {
    await fetch(
      `https://api.green-api.com/waInstance${GREEN_API_INSTANCE}/sendMessage/${GREEN_API_TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: WHATSAPP_GROUP_ID, message }) }
    );
  } catch (_) {}
}

/** Navigate NG-ZORRO calendar to a date and click it */
async function pickDate(page, isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const title = `${m}/${d}/${y}`;
  for (let i = 0; i < 6; i++) {
    const cell = page.locator(`td[title="${title}"]`);
    if (await cell.count() > 0) {
      const cls = await cell.getAttribute('class') || '';
      if (cls.includes('disabled')) throw new Error(`Date ${isoDate} is disabled (min today+9)`);
      await cell.locator('.ant-picker-cell-inner').click();
      return;
    }
    await page.locator('button.ant-picker-header-next-btn').click();
    await page.waitForTimeout(300);
  }
  throw new Error(`Date ${isoDate} not found in calendar`);
}

// ââ Main ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function run() {
  const guestName = `${GUEST_FIRST_NAME} ${GUEST_LAST_NAME}`.trim();
  const guests = parseInt(TOTAL_GUESTS) || 1;

  console.log(`\nâââ Iskaan Registration v2 âââ`);
  console.log(`  Queue: ${QUEUE_ID}  |  Unit: ${APARTMENT_NO}  |  Guest: ${guestName}`);
  console.log(`  Dates: ${CHECKIN_DATE} â ${CHECKOUT_DATE}  |  Portal: ${FORM_URL}\n`);

  fs.mkdirSync(DL_DIR, { recursive: true });
  await updateQueue('processing');

  // ââ Download documents ââ
  console.log('[docs] Downloading...');
  const tradeLicense = await dlFromStorage('company-docs/trade-license/trade_license_2026.pdf', 'trade_license.pdf');
  const eid = await dlFromStorage('company-docs/eid/hillal_medini_eid.jpeg', 'eid.jpeg');
  const passport = await dlFromStorage(PASSPORT_PATH, 'passport.pdf');
  const dtcm = await dlFromStorage(DTCM_FILE_URL, 'dtcm_permit.pdf');

  // ââ Launch browser ââ
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'en-US' })).newPage();

  try {
    // Step 1 â Navigate
    console.log('[1] Navigate to form');
    await page.goto(FORM_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('div.option', { timeout: 10000 });

    // Step 2 â Select "Company"
    console.log('[2] Select Company');
    await page.locator('div.option:has-text("Company")').click();
    await page.waitForTimeout(500);

    // Step 3 â Select unit
    console.log(`[3] Select unit ${APARTMENT_NO}`);
    await page.locator('nz-select').first().click();
    await page.waitForTimeout(300);
    await page.locator('nz-option-item', { hasText: APARTMENT_NO }).click();
    await page.waitForTimeout(500);

    // Step 4 â Enter email
    console.log(`[4] Enter email`);
    await page.locator('nz-form-item:has-text("Email") input').fill(PORTAL_LOGIN);
    await page.waitForTimeout(300);

    // Step 5 â OTP verification
    console.log('[5] OTP verification');
    const otp = await getOTP(PORTAL_LOGIN);

    // Click "Verify Email" button (inside nz-input-group, the search/action button)
    await page.locator('nz-input-group button.ant-input-search-button').click();
    console.log('  Verify Email clicked â waiting for OTP email...');
    await page.waitForTimeout(8000);

    // Poll for fresh OTP
    const code = await otp.poll();

    // Wait for modal to appear
    await page.waitForSelector('.ant-modal-content', { timeout: 10000 });

    // Enter OTP via native setter (Angular needs this)
    await page.evaluate((val) => {
      const input = document.querySelector('.ant-modal-content input');
      if (!input) throw new Error('OTP input not found in modal');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    }, code);
    console.log('  OTP entered');

    // Click Verify/OK button in modal (JS click to bypass nz-modal pointer interception)
    await page.evaluate(() => {
      const btn = document.querySelector('.ant-modal-content button.ant-btn-primary');
      if (btn) btn.click(); else throw new Error('No primary button in modal');
    });
    console.log('  Verify clicked');

    // Wait for modal to close (= OTP accepted)
    await page.waitForSelector('.ant-modal-content', { state: 'hidden', timeout: 15000 });
    console.log('  â OTP accepted â modal closed');
    await page.waitForTimeout(2000);

    // Step 6 â Dates
    console.log(`[6] Set dates ${CHECKIN_DATE} â ${CHECKOUT_DATE}`);
    await page.waitForSelector('nz-date-picker', { state: 'visible', timeout: 10000 });

    const startPicker = page.locator('nz-date-picker').first();
    await startPicker.locator('input').click();
    await page.waitForTimeout(300);
    await pickDate(page, CHECKIN_DATE);
    await page.waitForTimeout(500);

    const endPicker = page.locator('nz-date-picker').nth(1);
    await endPicker.locator('input').click();
    await page.waitForTimeout(300);
    await pickDate(page, CHECKOUT_DATE);
    await page.waitForTimeout(500);

    // Step 7 â Number of guests
    console.log(`[7] Set ${guests} guest(s)`);
    await page.locator('input[placeholder="Number of Guests"]').fill(String(guests));
    await page.waitForTimeout(1000);

    // Step 8 â Guest details
    console.log('[8] Fill guest details');
    await page.locator('input[placeholder="Enter Name here"]').first().fill(guestName);
    if (GUEST_PHONE) {
      const phone = GUEST_PHONE.replace(/[+\s\-()]/g, '').replace(/^971/, '');
      await page.locator('input[placeholder="Enter Mobile Number"]').first().fill(phone);
    }
    if (passport) {
      await page.locator('input[type="file"]').nth(0).setInputFiles(passport);
      await page.waitForTimeout(500);
    }
    // Fill extra guests with placeholder data
    for (let i = 1; i < guests; i++) {
      const nameInputs = page.locator('input[placeholder="Enter Name here"]');
      if (await nameInputs.nth(i).count() > 0) await nameInputs.nth(i).fill(`Guest ${i + 1}`);
      const mobileInputs = page.locator('input[placeholder="Enter Mobile Number"]');
      if (await mobileInputs.nth(i).count() > 0) await mobileInputs.nth(i).fill('501234567');
    }

    // Step 9 â Company documents
    console.log('[9] Upload company docs');
    const fileInputs = page.locator('input[type="file"]');
    if (dtcm)         { await fileInputs.nth(guests).setInputFiles(dtcm);         console.log('  â DTCM'); }
    if (tradeLicense)  { await fileInputs.nth(guests + 1).setInputFiles(tradeLicense); console.log('  â Trade License'); }
    if (eid)           { await fileInputs.nth(guests + 2).setInputFiles(eid);       console.log('  â EID'); }
    await page.waitForTimeout(500);

    // Step 10 â Terms
    console.log('[10] Accept terms');
    await page.locator('label.ant-checkbox-wrapper, input[type="checkbox"]').first().click();
    await page.waitForTimeout(300);

    // Step 11 â Submit
    console.log('[11] SUBMIT');
    await page.locator('button:has-text("Submit")').click();
    await page.waitForTimeout(5000);

    const bodyText = await page.textContent('body');
    const ok = /success|submitted|thank/i.test(bodyText);

    if (ok) {
      console.log('â Submitted successfully');
      await updateQueue('submitted');
      await whatsapp(`â Iskaan enregistrÃ©\nð ${APARTMENT_NO} â ${PORTAL_URL.split('/').pop()}\nð¤ ${guestName}\nð ${CHECKIN_DATE} â ${CHECKOUT_DATE}`);
    } else {
      await page.screenshot({ path: path.join(DL_DIR, 'result.png') });
      console.log('â ï¸ No clear success message â check result.png');
      await updateQueue('submitted', 'No clear success confirmation');
      await whatsapp(`â ï¸ Iskaan soumis (Ã  vÃ©rifier)\nð ${APARTMENT_NO}\nð¤ ${guestName}`);
    }

  } catch (err) {
    console.error('â Error:', err.message);
    await page.screenshot({ path: path.join(DL_DIR, 'error.png') }).catch(() => {});
    await updateQueue('error', err.message);
    await whatsapp(`â Iskaan ERREUR\nð ${APARTMENT_NO}\nð ${err.message.substring(0, 100)}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
