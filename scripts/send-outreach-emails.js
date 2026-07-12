#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration
const BOSS_API = 'http://localhost:8010';
const SEND_ACCOUNT = 'd.caine@dcaine.com';
const MAX_EMAILS_PER_DAY = 10;

// Helper to make HTTP requests
function makeRequest(url, options = {}, data = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = url.startsWith('https');
    const http = isHttps ? require('https') : require('http');

    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': options.authorization || 'Bearer internal',
        ...options.headers
      }
    };

    const req = http.request(requestOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: body ? JSON.parse(body) : body
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: body
          });
        }
      });
    });

    req.on('error', reject);
    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }
    req.end();
  });
}

// Check how many emails already sent today
function checkDailySendCount() {
  const logPath = path.join(__dirname, '../state/outreach/send-log.json');
  if (!fs.existsSync(logPath)) {
    return 0;
  }

  const logData = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  if (!logData.emails) return 0;

  const today = new Date().toISOString().split('T')[0];
  return logData.emails.filter(e => e.date === today).length;
}

// Send email via IR Custom AIOS Gmail API
async function sendEmail(draft) {
  try {
    const response = await makeRequest(`${BOSS_API}/api/email/send`, {
      method: 'POST',
      authorization: 'Bearer internal'
    }, {
      account: SEND_ACCOUNT,
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
      type: 'text/plain'
    });

    if (response.status === 200 && response.body.message_id) {
      return {
        success: true,
        messageId: response.body.message_id,
        timestamp: new Date().toISOString()
      };
    } else {
      throw new Error(`API returned ${response.status}: ${JSON.stringify(response.body)}`);
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// Update send log
function logSend(draft, result) {
  const logPath = path.join(__dirname, '../state/outreach/send-log.json');
  let logData = { emails: [], lastUpdated: new Date().toISOString() };

  if (fs.existsSync(logPath)) {
    logData = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  }

  const today = new Date().toISOString().split('T')[0];
  const entry = {
    date: today,
    timestamp: result.timestamp,
    to: draft.to,
    subject: draft.subject,
    business_name: draft.business_name,
    sheet_row: draft.sheet_row,
    success: result.success,
    message_id: result.messageId || null,
    error: result.error || null
  };

  logData.emails.push(entry);
  logData.lastUpdated = new Date().toISOString();

  fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));
  return entry;
}

// Main function
async function main() {
  try {
    console.log('Sending outreach emails...');

    // Check daily limit
    const alreadySent = checkDailySendCount();
    if (alreadySent >= MAX_EMAILS_PER_DAY) {
      console.log(`⚠ Already sent ${alreadySent} emails today. Hard limit of ${MAX_EMAILS_PER_DAY} reached.`);
      return;
    }

    // Find today's drafts
    const today = new Date().toISOString().split('T')[0];
    const draftsDir = path.join(__dirname, `../state/outreach/drafts/${today}`);

    if (!fs.existsSync(draftsDir)) {
      console.log(`No drafts found for today (${today}). Run generate-outreach-drafts.js first.`);
      return;
    }

    // Read manifests
    const manifestPath = path.join(draftsDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      console.log('No manifest found. Run generate-outreach-drafts.js first.');
      return;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    console.log(`Found ${manifest.total_drafts} drafts for today`);

    // Send each draft
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < manifest.drafts.length; i++) {
      if (alreadySent + successCount >= MAX_EMAILS_PER_DAY) {
        console.log(`⚠ Reached daily limit of ${MAX_EMAILS_PER_DAY}. Stopping.`);
        break;
      }

      const draftFile = path.join(draftsDir, `${i + 1}.json`);
      if (!fs.existsSync(draftFile)) continue;

      const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
      console.log(`[${i + 1}] Sending to ${draft.to}...`);

      const result = await sendEmail(draft);
      logSend(draft, result);

      if (result.success) {
        console.log(`  ✓ Sent (${result.messageId})`);
        successCount++;
      } else {
        console.log(`  ✗ Failed: ${result.error}`);
        failureCount++;
      }

      // Small delay between sends
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`\n✓ Sent ${successCount} emails`);
    if (failureCount > 0) {
      console.log(`✗ Failed ${failureCount} emails`);
    }
    console.log(`Total today: ${alreadySent + successCount}/${MAX_EMAILS_PER_DAY}`);

  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

main();
