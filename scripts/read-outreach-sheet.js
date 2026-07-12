#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Configuration
const SHEET_ID = '1Z1ZReCWmFr8e_OgrlUZ_Ee1c86B69AEXjGcp2fd3gjU';

// Token file path
const tokenFile = path.join(__dirname, '../.google-sheets-token.json');

// Helper to make HTTPS requests
function makeRequest(url, options = {}, data = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {
        'Content-Type': 'application/json',
        'User-Agent': 'outreach-sheet-reader/1.0'
      }
    };

    const req = https.request(requestOptions, (res) => {
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

// Read sheet with API key (public sheets)
async function readSheet(accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A:S?key=${process.env.GOOGLE_API_KEY || ''}`;

  try {
    const response = await makeRequest(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.status !== 200) {
      throw new Error(`Sheet API error: ${response.status}`);
    }

    return response.body;
  } catch (error) {
    console.error('Failed to read sheet:', error.message);
    throw error;
  }
}

// Refresh an expired access token using the stored refresh token
async function refreshAccessToken(tokenData) {
  const clientId = tokenData.client_id;
  const clientSecret = tokenData.client_secret;
  const refreshToken = tokenData.refresh_token;

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  const response = await makeRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, params.toString());

  if (response.status !== 200 || !response.body.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(response.body)}`);
  }

  const updated = {
    ...tokenData,
    access_token: response.body.access_token,
    expires_at: Date.now() + (response.body.expires_in - 60) * 1000
  };
  fs.writeFileSync(tokenFile, JSON.stringify(updated, null, 2));
  return updated.access_token;
}

// Get access token from stored refresh token or request new one
async function getAccessToken() {
  // Try to load stored token
  if (fs.existsSync(tokenFile)) {
    try {
      const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (tokenData.access_token && tokenData.expires_at > Date.now()) {
        return tokenData.access_token;
      }
      // Token expired, try to refresh
      if (tokenData.refresh_token) {
        return await refreshAccessToken(tokenData);
      }
    } catch (e) {
      console.log('Token file error:', e.message);
    }
  }

  // Fall back to IR Custom AIOS API (port 8001)
  return await getTokenFromIR Custom AIOS();
}

async function getTokenFromIR Custom AIOS() {
  try {
    const response = await makeRequest('http://localhost:8001/api/connectors/google/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer internal'
      }
    }, {
      account: 'd.caine@dcaine.com'
    });

    if (response.status === 200 && response.body.access_token) {
      return response.body.access_token;
    }

    throw new Error('Could not get token from IR Custom AIOS');
  } catch (e) {
    console.error('IR Custom AIOS token request failed:', e.message);
    throw e;
  }
}

// Parse sheet data and extract uncontacted leads
function parseLeads(sheetData) {
  if (!sheetData || !sheetData.values || sheetData.values.length === 0) {
    return [];
  }

  const rows = sheetData.values;

  // Column indices (0-based) per actual sheet headers:
  // A=id, B=first_name, C=last_name, D=name(company), E=company_description,
  // F=title, G=mobile_phone, H=direct_number, I=people_email, J=linkedin,
  // K=website, L=location, M=state, N=gender, O=email_draft,
  // P=email_status, Q=sending_status, R=date_of_initial, S=scheduled_meeting, T=follow_up
  const COL_FIRST_NAME = 1;
  const COL_LAST_NAME = 2;
  const COL_COMPANY = 3;
  const COL_TITLE = 5;
  const COL_EMAIL = 8;
  const COL_LOCATION = 11;
  const COL_STATE = 12;
  const COL_EMAIL_STATUS = 15; // Column P
  const COL_DATE_INITIAL = 17; // Column R

  const leads = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const email = row[COL_EMAIL];
    if (!email) continue; // Skip rows without email

    const statusP = row[COL_EMAIL_STATUS] || '';
    const dateR = row[COL_DATE_INITIAL] || '';

    // Uncontacted: Column P is NOT "R" or "B", and Column R (date) is blank
    if (statusP !== 'R' && statusP !== 'B' && !dateR) {
      leads.push({
        row: i + 1,
        business_name: row[COL_COMPANY] || '',
        contact_name: [row[COL_FIRST_NAME], row[COL_LAST_NAME]].filter(Boolean).join(' '),
        email: email,
        title: row[COL_TITLE] || '',
        city: row[COL_LOCATION] || '',
        state: row[COL_STATE] || '',
        email_status: statusP,
        notes: row[19] || ''
      });
    }
  }

  return leads;
}

// Main function
async function main() {
  try {
    console.log('Reading outreach Google Sheet...');

    let accessToken;
    try {
      accessToken = await getAccessToken();
    } catch (e) {
      console.log('Warning: Could not get access token, will attempt with limited access');
      accessToken = 'public';
    }

    const sheetData = await readSheet(accessToken);
    const leads = parseLeads(sheetData);

    const output = {
      timestamp: new Date().toISOString(),
      sheet_id: SHEET_ID,
      total_rows: sheetData.values ? sheetData.values.length - 1 : 0,
      uncontacted_count: leads.length,
      leads: leads
    };

    // Ensure output directory exists
    const outDir = path.join(__dirname, '../state/outreach');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    // Write output file
    const outputPath = path.join(outDir, 'uncontacted.json');
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

    console.log(`✓ Extracted ${leads.length} uncontacted leads from ${output.total_rows} total rows`);
    console.log(`✓ Written to ${outputPath}`);

    return output;
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

main();
