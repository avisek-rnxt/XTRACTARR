# XTRACTARR

Sales Navigator data extractor Chrome extension (MV3) for local proof-of-concept usage.

## What It Does

- Captures Sales Navigator profile/search payloads from LinkedIn network calls.
- Builds a merged record set across multiple result pages (up to 50 pages per run).
- Enriches company fields from LinkedIn Sales company API when available.
- Exports once at the end as:
  - `xtractarr-export-<timestamp>.json`
  - `xtractarr-export-<timestamp>.csv`
- Saves files automatically to your Downloads folder.

## Current Flow

1. Open a Sales Navigator people search page.
2. Open extension popup `XTRACTARR`.
3. Set `Pages (1-50)`.
4. Click `START EXTRACTION`.
5. For each page, extension does:
   - capture data from current page
   - scroll to bottom
   - wait exactly 2 seconds
   - click next page
6. After last page (or no next page), it exports combined results.

## Fields Exported (CSV)

- Name
- First name
- Last name
- Title
- Linkedin
- Location
- Added On
- Company Name
- Company Domain
- Company Website
- Company Employee Count
- Company Employee Count Range
- Company Founded
- Company Industry
- Company Type
- Company Headquarters
- Company Revenue Range
- Company Crunchbase Url
- Company Logo Url
- Profile ID
- Entity URN
- Company LinkedIn ID
- Connection Degree
- Pending Invitation

Notes:
- Email fields are intentionally excluded.
- Funding-specific fields are currently excluded.

## Project Structure

- `manifest.json` - MV3 config, permissions, popup, background worker.
- `src/background.js` - session state, aggregation, pagination orchestration, export.
- `src/contentScript.v2.js` - page bridge + scroll/next-page actions + message handling.
- `src/interceptor.js` - fetch/xhr interception injected into page context.
- `src/popup.html` / `src/popup.css` / `src/popup.js` - extension UI.

## Installation (Unpacked Extension)

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder:
   - `sales-nav-poc`
5. Pin `XTRACTARR` from extensions toolbar.

## How To Use

1. Log into LinkedIn and open Sales Navigator people search results.
2. Open XTRACTARR popup.
3. Enter target pages (example: `10`).
4. Click `START EXTRACTION`.
5. Keep the Sales Navigator tab open until completion.
6. Check Downloads for JSON and CSV files.

## Action Status Text (Popup)

You should see live phases like:

- `reloading page`
- `processing page data`
- `scrolling to page bottom`
- `waiting 2.0s`
- `moving to next page`
- `loading page N`
- `finalizing export`
- `completed`

## Troubleshooting

### Extension click does nothing

- Verify you are on a `linkedin.com/sales/...` page.
- Reload extension from `chrome://extensions`.
- Hard refresh Sales Navigator tab.

### Stuck on page 1

- Check popup action text for where it is blocked.
- Open service worker logs:
  - `chrome://extensions` -> XTRACTARR -> `Service worker` -> `Inspect`
- Look for logs with `[XTRACTARR][BG]`.

### No files exported

- Ensure at least one record was captured.
- Confirm Downloads permission is allowed.
- Check browser download restrictions/prompt settings.

### Content script context errors

- Reload extension.
- Refresh the LinkedIn page.
- Retry extraction from popup.

## Development

No build step is required; source files are loaded directly.

### Quick local checks

```powershell
node --check src/background.js
node --check src/contentScript.v2.js
node --check src/popup.js
```

## Permissions Used

- `downloads` - save export files.
- `tabs` - active tab and navigation control.
- `scripting` - content-script injection fallback.
- host permission `*://www.linkedin.com/*` - access Sales Navigator pages/API calls.

## Disclaimer

This repository is for proof-of-concept and local testing. Ensure your usage complies with LinkedIn terms, applicable laws, and your organizational policies.
