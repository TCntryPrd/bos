#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Read uncontacted leads
function readUncontactedLeads() {
  const filePath = path.join(__dirname, '../state/outreach/uncontacted.json');
  if (!fs.existsSync(filePath)) {
    throw new Error('uncontacted.json not found. Run read-outreach-sheet.js first.');
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return data.leads;
}

// Generate personalized email draft
function generateEmailDraft(lead) {
  const businessName = lead.business_name || 'there';
  const contactName = lead.contact_name || 'there';

  const subject = `Quick opportunity for ${businessName}`;

  const body = `Hi ${contactName},

I came across ${businessName} and saw some interesting things about what you're doing.

I work with businesses like yours to improve their operations and growth. We've had good success helping similar companies streamline their processes and increase efficiency.

Would you be open to a quick 15-minute call next week to explore if there's a fit?

Best regards,
D. Caine
Reach out: d.caine@dcaine.com`;

  return {
    to: lead.email,
    subject: subject,
    body: body,
    business_name: businessName,
    contact_name: contactName,
    sheet_row: lead.row,
    generated_at: new Date().toISOString()
  };
}

// Main function
async function main() {
  try {
    console.log('Generating outreach email drafts...');

    // Read leads
    const leads = readUncontactedLeads();
    console.log(`Found ${leads.length} uncontacted leads`);

    // Create drafts directory for today
    const today = new Date().toISOString().split('T')[0];
    const draftsDir = path.join(__dirname, `../state/outreach/drafts/${today}`);
    if (!fs.existsSync(draftsDir)) {
      fs.mkdirSync(draftsDir, { recursive: true });
    }

    // Generate drafts
    const drafts = [];
    for (let i = 0; i < Math.min(leads.length, 10); i++) {
      const draft = generateEmailDraft(leads[i]);
      drafts.push(draft);

      // Save individual draft file
      const draftFile = path.join(draftsDir, `${i + 1}.json`);
      fs.writeFileSync(draftFile, JSON.stringify(draft, null, 2));
    }

    // Save manifest
    const manifest = {
      timestamp: new Date().toISOString(),
      date: today,
      total_drafts: drafts.length,
      max_daily_limit: 10,
      drafts: drafts.map(d => ({
        to: d.to,
        subject: d.subject,
        business_name: d.business_name,
        sheet_row: d.sheet_row
      }))
    };

    const manifestFile = path.join(draftsDir, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    console.log(`✓ Generated ${drafts.length} email drafts`);
    console.log(`✓ Saved to ${draftsDir}`);
    console.log(`✓ Ready for 9 AM send routine`);

    return manifest;
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

main();
