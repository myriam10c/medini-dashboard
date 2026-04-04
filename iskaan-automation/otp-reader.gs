/**
 * Google Apps Script — Iskaan OTP Reader
 * Deploy as Web App (Execute as: Me, Access: Anyone)
 *
 * GET ?email=admin@medini-homes.com
 * Returns the latest 6-digit OTP from noreply@mail.iskaan.com
 * received in the last 5 minutes.
 *
 * SETUP:
 * 1. Go to https://script.google.com
 * 2. Create new project "Iskaan OTP Reader"
 * 3. Paste this code
 * 4. Deploy → Web App → Execute as: Me, Access: Anyone
 * 5. Copy the web app URL → add as GitHub secret OTP_APPS_SCRIPT_URL
 *
 * NOTE: Deploy this under admin@medini-homes.com account.
 * For mrbnbdubai@gmail.com, deploy a second instance under that account.
 */

function doGet(e) {
  try {
    // Search for recent Iskaan OTP emails (last 5 minutes)
    var searchQuery = 'from:noreply@mail.iskaan.com newer_than:5m';
    var threads = GmailApp.search(searchQuery, 0, 3);

    if (threads.length === 0) {
      return ContentService.createTextOutput('NO_OTP')
        .setMimeType(ContentService.MimeType.TEXT);
    }

    // Get the most recent message
    var messages = threads[0].getMessages();
    var latestMessage = messages[messages.length - 1];
    var body = latestMessage.getPlainBody() || latestMessage.getBody();

    // Extract 4-6 digit OTP code
    var match = body.match(/\b(\d{4,6})\b/);

    if (match) {
      var otp = match[1];
      Logger.log('OTP found: ' + otp);

      // Mark as read to avoid re-reading
      latestMessage.markRead();

      return ContentService.createTextOutput(otp)
        .setMimeType(ContentService.MimeType.TEXT);
    }

    return ContentService.createTextOutput('NO_OTP')
      .setMimeType(ContentService.MimeType.TEXT);

  } catch (error) {
    Logger.log('Error: ' + error.message);
    return ContentService.createTextOutput('ERROR:' + error.message)
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

// Test function — run in Apps Script editor
function testOTP() {
  var result = doGet({});
  Logger.log('Result: ' + result.getContent());
}
