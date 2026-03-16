# MPA Procurement MCP — Google Sheets Setup

## What this does
The `push_to_sheet` tool writes scored procurement opportunities directly to your Google Sheet using the Sheets API (~200ms per call instead of 1.5-5.7s through Pipedream). It scores each opportunity, deduplicates against existing data, and applies formatting automatically.

## New MCP tools added
- **`push_to_sheet`** — Score + dedup + upsert opportunities into the pipeline sheet
- **`rescore_sheet`** — Re-score all existing rows (use after tweaking scoring logic)
- **`sheet_status`** — Quick pipeline summary (counts, top opps)

---

## Setup (10 minutes)

### Step 1: Create a Google Cloud project

1. Go to https://console.cloud.google.com
2. Click the project dropdown (top-left) → "New Project"
3. Name it `mpa-procurement` → Create
4. Make sure it's selected as the active project

### Step 2: Enable the Google Sheets API

Run this in your browser's address bar after logging into Google Cloud Console:

```
https://console.cloud.google.com/apis/library/sheets.googleapis.com
```

Click **Enable**.

### Step 3: Create a service account

1. Go to https://console.cloud.google.com/iam-admin/serviceaccounts
2. Click **+ Create Service Account**
3. Name: `mpa-sheets-writer`
4. Description: `Writes procurement data to MPA Pipeline sheet`
5. Click **Create and Continue**
6. Skip the optional role/access steps → Click **Done**

### Step 4: Generate the JSON key

1. Click on the `mpa-sheets-writer` service account you just created
2. Go to the **Keys** tab
3. Click **Add Key** → **Create new key**
4. Select **JSON** → **Create**
5. A `.json` file downloads automatically — this is your credentials file

### Step 5: Move the key file

```cmd
mkdir credentials
move %USERPROFILE%\Downloads\mpa-procurement-*.json credentials\google-service-account.json
```

### Step 6: Share the spreadsheet with the service account

1. Open the JSON key file and find the `client_email` field — it looks like:
   ```
   mpa-sheets-writer@mpa-procurement-XXXXX.iam.gserviceaccount.com
   ```
2. Open the Google Sheet: https://docs.google.com/spreadsheets/d/1ze-9C0g924sotn3emm5j7N_jtw-MvRiBWDrh1T1tJa8/edit
3. Click **Share** (top-right)
4. Paste the service account email → Set to **Editor** → **Share**
5. Uncheck "Notify people" if prompted — it's a bot account

### Step 7: Update your .env

Add these two lines to your `.env` file:

```
GOOGLE_SHEETS_CREDS_PATH=./credentials/google-service-account.json
PROCUREMENT_SHEET_ID=1ze-9C0g924sotn3emm5j7N_jtw-MvRiBWDrh1T1tJa8
```

### Step 8: Install the new dependency

```cmd
npm install
```

This pulls in `googleapis` (the only new dep).

### Step 9: Add credentials to .gitignore

Make sure your service account key never gets committed:

```cmd
echo credentials/ >> .gitignore
```

---

## Test it

Start the MCP server and test the new tools:

```
push_to_sheet with a test opportunity:
{
  "opportunities": [{
    "title": "Test Opportunity - Delete Me",
    "agency": "Test Agency",
    "portal": "Manual",
    "state": "FL",
    "deadline": "2026-04-15",
    "estValue": "$50K"
  }],
  "dry_run": true
}
```

The `dry_run: true` flag scores and checks for dupes without writing to the sheet.

---

## How scoring works

Each opportunity gets a 0-100 composite score:

| Component | Max Points | Factors |
|-----------|-----------|---------|
| **MPA Fit** | 50 | Service match (25), Geography (15), Size (10) |
| **ROI** | 50 | Deadline (15), Competition (10), Contract type (15), Effort (10) |

| Score | Decision | Meaning |
|-------|----------|---------|
| 75+ | **BID** | Strong fit — pursue actively |
| 50-74 | **REVIEW** | Worth a closer look |
| 0-49 | **SKIP** | Poor fit — don't waste time |

---

## Security notes

- The service account JSON key has **write access only to sheets you explicitly share with it**
- It cannot read your email, calendar, or any other Google data
- Store it in `credentials/` which is gitignored
- If compromised: delete the key from Google Cloud Console → Keys tab → Delete
