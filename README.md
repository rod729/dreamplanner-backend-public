# DreamPlanner setup guide (HighLevel + Netlify)

How it fits together:

    Customer on your HighLevel page
        -> fills the form, page builds the PDF in their browser
        -> page sends lead + PDF to YOUR Netlify function (HTTPS, background request)
        -> function uploads the PDF to your HighLevel Media Library
        -> function sends lead + PDF link to your HighLevel Inbound Webhook
        -> HighLevel workflow creates/updates the contact and emails the PDF link

Files:
- `netlify/functions/dreamplanner-submit.js`  the function
- `public/assets/*.png`                       the three logos (hosted here so the page stays small)
- `netlify.toml`                              Netlify settings (functions folder + image CORS headers)
- `.env.example`                              the settings you must enter in Netlify

The page file is `DreamSpace Designer - Casual Marketplace.html` (now about 129 KB).

---

## Step 1 - Put the backend on Netlify

1. Create a GitHub repo and upload the contents of this `dreamplanner-backend` folder
   (`netlify/`, `public/`, `netlify.toml`, `package.json`, `.env.example`, this README).
2. In Netlify: **Add new project -> Import an existing project -> GitHub** -> pick the repo.
3. Leave the build command empty. Publish directory should show `public`
   and functions directory `netlify/functions` (they come from `netlify.toml`). Deploy.
4. Write down your site address, for example `https://dreamplanner-abc123.netlify.app`.
5. Check it: open `https://YOUR-SITE.netlify.app/assets/logo-link.png`. The logo should show.

(Alternative to GitHub: install Node, run `npm i -g netlify-cli`, `netlify login`,
`netlify deploy --prod` from this folder.)

## Step 2 - Set up HighLevel

Do these in the sub-account that owns the funnel.

1. **Workflow.** Automation -> Workflows -> Create workflow (start from scratch).
2. **Trigger:** add "Inbound Webhook". Copy the Webhook URL it shows. Keep this URL private.
3. **Teach it the fields.** Send one sample request so HighLevel sees the field names
   (use the real URL):

       curl -X POST 'PASTE_WEBHOOK_URL_HERE' -H 'Content-Type: application/json' -d '{
         "source":"DreamPlanner","first_name":"Test","last_name":"Person","name":"Test Person",
         "email":"you@yourdomain.com","phone":"5550100","timeline":"soon",
         "design_pdf_url":"https://example.com/sample.pdf","design_pdf_status":"uploaded",
         "design_file_name":"sample.pdf","submitted_at":"2026-01-01T00:00:00Z"}'

   Then in the trigger, choose that request as the sample ("Fetch sample requests").
4. **Contact:** add a "Create/Update Contact" action mapping first_name, last_name, email, phone
   (HighLevel may already do this automatically from the webhook).
5. **Optional:** an "Add Tag" action (for example `dreamplanner-lead`) so you can filter these contacts.
6. **Email:** add a "Send Email" action to the contact. In the body, add a button or link whose
   URL is the webhook field `design_pdf_url` (insert it from the merge-field picker under the
   Inbound Webhook / trigger data; do not type it by hand).
7. **Handle a failed PDF upload (recommended):** add an If/Else on `design_pdf_status`.
   If it is `failed`, send an email without the link ("we'll send your design shortly")
   and notify your team.
8. **Publish** the workflow (toggle it on and save).
9. **Private Integration token:** Settings -> Private Integrations -> Create new integration.
   Give it only the media scope (`medias.write`). Copy the token once; it is shown one time.
10. **Location ID:** Settings -> Business Profile (or the ID in the sub-account URL).

## Step 3 - Give Netlify the secrets

Netlify -> your site -> Site configuration -> Environment variables. Add:

| Name | Value |
|---|---|
| `GHL_PRIVATE_TOKEN` | the token from Step 2.9 (mark as secret) |
| `GHL_INBOUND_WEBHOOK_URL` | the URL from Step 2.2 (mark as secret) |
| `GHL_LOCATION_ID` | from Step 2.10 |
| `ALLOWED_ORIGINS` | `*` for now (locked down in Step 6) |

Environment variables only apply to new deploys: Deploys -> Trigger deploy -> Deploy site.

## Step 4 - Test the function by itself (before touching the page)

Replace the address with yours:

    curl -i -X POST 'https://YOUR-SITE.netlify.app/.netlify/functions/dreamplanner-submit' \
      -H 'Content-Type: application/json' \
      -d '{"name":"Test Person","email":"you@yourdomain.com","timeline":"soon"}'

Expected: `HTTP 200` and `{"success":true,"pdf":"none"}`. Within a minute the HighLevel workflow
should show a new run (Automation -> Workflows -> your workflow -> Execution Logs), with the
contact created.

| Result | Meaning |
|---|---|
| 200 success, workflow runs | Function + webhook work |
| 500 "Server is not configured" | `GHL_INBOUND_WEBHOOK_URL` missing, or you did not redeploy after adding it |
| 502 "Could not deliver to HighLevel" | Webhook URL wrong or the workflow is not published. Netlify -> Logs -> Functions shows the reason |
| 404 | Function not deployed. Check the deploy log and that `netlify/functions` is in the repo |

## Step 5 - Point the page at your site

1. Open `DreamSpace Designer - Casual Marketplace.html` in a text editor.
2. Find and replace **all** occurrences of `YOUR-SITE.netlify.app` with your real Netlify
   host (for example `dreamplanner-abc123.netlify.app`). There are 5: the function URL and 4 logos.
3. Search the file for `YOUR-SITE`. It should now find nothing.

## Step 6 - Put it in HighLevel

1. Funnels -> your funnel -> the step -> open the editor.
2. Add a **Full width** section with zero padding, then drag in a **Custom JS/HTML** element.
3. Paste the whole contents of the HTML file into it and save, then publish the step.
   Paste it directly; do not use an iframe, or the Meta Pixel `Lead` event cannot fire.
4. Open the published page (not the editor preview) in a normal browser tab.
5. **Lock down access:** in Netlify, change `ALLOWED_ORIGINS` to your page's exact domain,
   for example `https://go.yourdomain.com` (comma-separated if more than one), and redeploy.

## Step 7 - Full test on the live page

1. Open the page with browser DevTools -> Network tab open.
2. Place a few items, click **Send Me My Design**, fill in your own email, submit.
3. In Network, find `dreamplanner-submit`: you should see an OPTIONS and a POST, both 200.
   The page should show "Your design has been sent!".
4. Check, in order: Netlify -> Logs -> Functions (no errors), HighLevel contact created with the
   tag, workflow execution log, your inbox (email with the PDF link; open the link to see the PDF).
5. In Meta Pixel Helper, confirm a `Lead` event fires on submit.

## If something fails

| What you see | Likely cause |
|---|---|
| Red toast, DevTools shows a CORS error | `ALLOWED_ORIGINS` does not match the page's domain exactly (https, no trailing slash) |
| Red toast, request goes to `YOUR-SITE.netlify.app` | Step 5 find/replace not done or not re-pasted into HighLevel |
| Toast says sent, email has no PDF link | Upload failed. Netlify function log shows "PDF upload failed". Check the token scope (`medias.write`) and that it belongs to the same sub-account |
| Logos missing on the page or PDF | Step 1.5 failed, or Step 5 not done |
| Submit works but no workflow run | Workflow not published, or trigger sample not saved |
| 413 / request too large | PDF over about 6 MB. Should not happen now (typical PDF is under 0.5 MB) |
