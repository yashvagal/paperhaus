# Paperhaus: Phase 0 kit

This folder turns a BentoPDF fork into **Paperhaus**, hosted free on Cloudflare Pages and visible only to you and the friends you allow.

> **Deploying for the first time?** Follow `DEPLOY.md` in the repo root. It covers this app and the public front page in `website/` together. This README is the reference for the app.

What it does on every build:

- Brands the site as Paperhaus: name, logo, and a footer link to your source code, which AGPL-3.0 requires.
- Applies a Paperhaus design in the family of your other sites, with automatic light and dark mode (see "Designs" below).
- Uses BentoPDF's clean "simple mode": only the tools, no marketing pages.
- Adds Paperhaus's own **Scan** tool, a CamScanner-style scanner (see "Scan" below).
- Adds **Request Signatures**: send a PDF to several people and get it back signed by all of them, with a signing certificate (see "Request Signatures" below).
- Adds **PDF to PowerPoint**, **HTML to PDF**, **Redact PDF**, **Summarize PDF** and **Translate PDF**, the tools iLovePDF has that BentoPDF lacks (see "More tools" below).
- Lets you pin Paperhaus to your dock, taskbar or phone home screen straight from the browser (no app store), and shows who is signed in (see "Pin it and stay signed in" below).
- Serves every engine from your own site instead of public CDNs. That covers PyMuPDF, Ghostscript, CoherentPDF, the Tesseract OCR engine with its language data and fonts, LibreOffice for Office files, and OpenCV for scanning. The site loads nothing from third parties.
- Splits LibreOffice's two large files (28 MB and 48 MB) into pieces under Cloudflare's 25 MiB per-file limit, and temporarily patches the loader to put them back together in the browser.
- Writes Cloudflare security headers: a strict Content Security Policy that only allows connections to your own site, the cross-origin isolation headers Office conversion needs, and a header that keeps search engines out.
- Checks the output fits Cloudflare's free plan before finishing.

Nothing in BentoPDF's `src/` folder is permanently changed, so pulling BentoPDF updates stays a clean merge. The Paperhaus tools live in `kit/tools/` and are copied in only for the build, then removed again, even if the build fails.

Tested against BentoPDF v2.8.11 (commit `f638f8e`, Nov 1, 2026).

---

## Setup (about 30 minutes, $0)

### 1. Fork BentoPDF as `paperhaus`

1. Open <https://github.com/alam00000/bentopdf> and click **Fork**.
2. Name it `paperhaus`, keep it **public** (AGPL-3.0 requires the source to be available), and create the fork.
3. Clone it to your computer:

   ```sh
   git clone https://github.com/yashvagal/paperhaus.git
   cd paperhaus
   ```

### 2. Add this kit and push

1. Unzip `paperhaus-phase0-kit.zip` into the repo root, so you have `paperhaus/kit/build.mjs`, `paperhaus/kit/kit.env` and so on.
2. Commit and push:

   ```sh
   git add kit
   git commit -m "Add Paperhaus Phase 0 kit"
   git push
   ```

### 3. Create the Cloudflare Pages project

1. Sign in at <https://dash.cloudflare.com> (a free account is fine).
2. Go to **Workers & Pages → Create → Pages → Connect to Git** and pick `yashvagal/paperhaus`.
3. Use these build settings:

   | Setting | Value |
   | --- | --- |
   | Project name | `paperhaus` |
   | Framework preset | None |
   | Build command | `node kit/build.mjs` |
   | Build output directory | `dist` |
   | Environment variable | `NODE_VERSION` = `22` |

4. Click **Save and Deploy**. The first build takes about 5-10 minutes.
5. So edits to the front page don't rebuild the app, open the project's **Settings → Build → Build watch paths** and add `website/*` under **Exclude paths**.
6. Your site is at `https://paperhaus.pages.dev`. If that name was already taken, Cloudflare shows the address it picked instead.

Every push to `main` redeploys automatically.

### 4. Make it friends-only (free, up to 50 people)

1. In the Cloudflare dashboard, open **Zero Trust**. The first time, it asks you to choose a team name and the **Free** plan. No charge is made.
2. Go to **Access → Applications → Add an application → Self-hosted**.
3. Add two hostnames, both with **Path** empty: **Subdomain** empty with **Domain** `paperhaus.pages.dev` (the app itself), and **Subdomain** `*` with the same domain (preview deployments). A `*` alone doesn't cover the main address, so you need both.
4. Add a policy with **Action: Allow** and an **Emails** rule listing you and each friend.
5. Under **Zero Trust → Settings → Authentication**, make sure **One-time PIN** is enabled.
6. Keep people signed in for a month, so the pinned app opens straight in:
   - In the application's settings, set **Session Duration** to **1 month**.
   - Under **Zero Trust → Settings → Authentication**, set **Global session timeout** to **1 month** too.
7. Let the app icon and app details load before sign-in, so pinning shows the Paperhaus icon. Add a second application: **Access → Applications → Add an application → Self-hosted**, name it "Paperhaus icons", with **Subdomain** empty, the same **Domain**, and these three **Paths**: `site.webmanifest`, `images/*` and `favicon.ico`. Give it one policy with **Action: Bypass** and **Include: Everyone**. These are only the logo and the app's name, nothing private.
8. Save, then open your site in a private window. It should ask for an email and send a code.

To add a friend later, add their email to that policy. If someone enters an email that isn't on the list, Cloudflare silently sends no code, so check the spelling first.

### 5. First-deploy checklist

Open the site in Chrome or Edge and try one file in each of these tools. Each one uses a different engine.

- [ ] **Merge PDF**: pdf-lib and CoherentPDF
- [ ] **OCR PDF**: tick English, run it, then download the searchable PDF and confirm you can select its text
- [ ] **Word to PDF**: LibreOffice. The first use downloads about 75 MB once, then it's cached.
- [ ] **PDF to PDF/A**: Ghostscript
- [ ] **PDF to Markdown**: PyMuPDF
- [ ] **Scan to PDF**: OpenCV. Open it on your phone, tap **Open camera**, allow camera access, and hold a page in view until it captures itself. The first use downloads about 11 MB once.
- [ ] **Pin it on your phone**: tap **Add to home screen** at the top right, open Paperhaus from the home screen, sign in once, then close and reopen it. It should open straight in, with your initial at the top right.

All five passed in an automated test with nothing loaded from outside the site. Word to PDF converted correctly once, but in later runs in that test environment LibreOffice stalled partway through converting. It stalled the same way with BentoPDF's original, unsplit files, so the kit isn't the cause; the likely culprit is the test machine's 2-core headless browser. Still, confirm Word to PDF on your real machine first. If it hangs there too, send me the browser console output.

---

## Scan

**Scan to PDF** is first in Popular Tools, and has its own **Scan** section on the home page. It works like CamScanner, entirely in the browser:

| Feature | How it works |
| --- | --- |
| Camera scanning | Live page outline, auto-capture once the page is steady, a manual shutter and a flashlight on phones that have one. A page is never captured twice in a row; show a new page or move the camera away first. |
| One page or many | A switch under the top bar. **Many pages** (the default) keeps the camera open and adds each page you show it, counting as it goes, until you tap **Done**. **One page** closes the camera after the first capture. The choice is remembered. |
| Set the corners yourself | If the camera can't find the page, the hint says so after a few seconds. Tap the shutter anyway: the crop screen opens with corners to drag onto the page, then the camera comes back for the next page. Photos imported without found edges are marked **Set corners** in Pages, and a single one opens straight in the crop screen. |
| Phone camera app | On phones, uses the built-in camera app for full-resolution photos, one at a time, with its own tap to focus. For several pages in a row, use **Open camera** with **Many pages**. |
| Import photos | Pick or drop any number of photos; each one is cropped automatically |
| Crop | Corners found automatically and straightened. Drag corners or edges to adjust, with a magnifier under your finger. **Auto** goes back to the found edges, **Whole photo** uses everything. |
| Enhance | Magic (removes shadows, white paper, crisp ink), Original, Lighten, Grayscale, Black & white, Whiteboard, plus brightness and contrast. Pick the look for new pages in Save, or apply one look to every page. |
| Pages | Drag to reorder, rotate, delete |
| ID card | Front and back on one A4 or Letter page at real card size (85.6 x 54 mm), ready to print |
| Book | A photo of two facing pages becomes two PDF pages, with an adjustable split |
| QR code | Reads QR codes from the camera or a picture. Links are shown with Copy and Open, never opened automatically. |
| Save | PDF (fit to scan, A4 or Letter; high, balanced or small), searchable text (OCR), a password (AES-256), images (a ZIP for several pages), Copy text, and Share on phones (email, messages and other apps) |
| Keeps your work | Unfinished scans stay in that browser on that device until you tap **Clear all**, so closing the tab loses nothing. Nothing is uploaded. |

The camera needs HTTPS, which Cloudflare Pages always provides. The security headers allow the camera for your own site only.

---

## Request Signatures

**Request Signatures** sits next to **Sign PDF**. You place fields for each signer, Paperhaus makes one private link per signer, and you email the links from your own email account. Signers need no account and no invite: whoever has a link can open it and sign.

| Step | What happens |
| --- | --- |
| 1. Document | Choose a PDF, up to 20 MB, and give it a title. |
| 2. Signers | Up to 10, each with a name and email. **Add me** adds you (your Paperhaus sign-in email). **Sign in this order** makes each person wait for the one before. |
| 3. Fields | Pick a signer, pick a field (Signature, Initials, Date signed, Full name, Text, Checkbox) and tap the page. Drag to move, pull the corner to resize, the x to remove. Every signer needs at least one Signature or Initials field. |
| 4. Send | **Send from** is the email the invitations go out from, filled in with your sign-in email and remembered. Press **Create signing links**, then for each signer press **Gmail** or **Outlook** (a draft opens in that account, addressed and written, you press Send), **Email app**, or **Copy link**. Gmail opens the account that matches **Send from**, so a work address like `you@yourcompany.com` works when it is a Google Workspace account signed in to that browser. For Microsoft 365 addresses use **Outlook**. |
| Signing | The signer opens the link, taps each highlighted field, adopts a signature (typed in one of three handwriting styles, or drawn with a finger, pen or mouse), agrees to sign electronically, and presses **Finish**. They can also **Decline**, with a reason. |
| Tracking | **Sent for signature**, at the top of the page, lists your requests on that device with who has opened and signed. Send a reminder with the same buttons. **Cancel** deletes a request and stops its links. |
| Finished copy | Once everyone signs, **Signed PDF** downloads the document with every field drawn in, plus a signing certificate page: the original's SHA-256 fingerprint, and each signer's email, view and signing times, IP address and device. **Send everyone the signed copy** emails a read-only download link to all signers. The last signer can download it straight away too. |

How it keeps documents private:

- The PDF and everything about the request (names, emails, fields, signatures) are encrypted in your browser with AES-256-GCM before upload. The key is only in the signing links, after the `#`, which browsers never send to a server. Paperhaus's server stores encrypted bytes it cannot read.
- Each signer has their own link, and the server keeps only a hash of each link's token. A signer's link can only sign as that signer.
- Everything is stored in Cloudflare KV and deleted automatically 14 days after sending, or right away on **Cancel**. Download the signed copy before then.
- Paperhaus sends no email itself. Invitations come from your own account, so they reach inboxes and replies come back to you.
- Your list of sent requests, and their keys, stay in that browser on that device. To track a request from another device, open the same page there after sending from it, or keep the signed copy.

Setup (once, free): in Cloudflare create a KV namespace and bind it to the Pages project as `ESIGN`, and let signers past the Paperhaus sign-in for the signing page only. Step 3b of `DEPLOY.md` has the clicks. Until the binding exists, **Create signing links** says e-sign is not set up yet.

The pieces: `kit/tools/esign/` (the two pages and their code) and `functions/api/esign/` (the small storage API, a Cloudflare Pages Function). The build adds `_routes.json` so only `/api/*` runs as a Function; the free plan allows 100,000 Function requests a day.

---

## More tools

Five tools fill the gaps against iLovePDF's list. They were written for Paperhaus from its own spec; see `kit/PROVENANCE.md`. All run in the browser. The one exception is HTML to PDF, which fetches web pages through a small function that only signed-in people can use.

| Tool | Where | What it does |
| --- | --- | --- |
| PDF to PowerPoint | Convert from PDF | One slide per page. **Editable text** puts text boxes, with the original colors, sizes and bold, over the page background with its words taken out. **Pictures** keeps the exact look. The page text goes into the speaker notes. Pages with turned text stay pictures. |
| HTML to PDF | Convert to PDF | Paste a web address or choose an .html file. **Selectable text** lays the page out with MuPDF. **Exact look** draws it as the browser shows it, split into pages at blank rows. Scripts don't run, so pages that build themselves with JavaScript, or that need a login, come out empty. |
| Redact PDF | Secure PDF, Popular Tools | Find words (match case, whole words) and patterns: emails, phone numbers, SSNs, card numbers (checked with the Luhn test) and dates. Draw boxes anywhere, and tap a match to skip it. Each redacted page is rebuilt as a 200 dpi picture with black boxes, and the words outside the boxes go back as invisible text, so search still works. Paperhaus then reads the file back to check that nothing redacted can be found. It can also remove document info, attachments and comments. |
| Summarize PDF | AI on this device | Key points, a short summary or one line, in three lengths. Long files are summarized in parts, then together, with an optional summary per part. Uses Chrome's built-in Summarizer (Gemini Nano on the computer). |
| Translate PDF | AI on this device | Detects the language. **Same layout** redraws each page without its words and paints the translation into each block. It's drawn as a picture, so Hindi, Marathi, Arabic and Chinese all show correctly. **Translated text** saves a .txt. Uses Chrome's built-in Translator. |

Summarize and Translate need Google Chrome 138 or newer on a computer, not a phone. Summaries also need about 22 GB free for Chrome's model, which downloads once. Elsewhere the pages say so. Summarize then offers **Copy text for Claude**.

---

## Pin it and stay signed in

Paperhaus is not an App Store or Play Store app. It's your website, pinned so it opens in its own window like an app, with nothing to install or update.

- **Pin app** sits at the top right of every page.
  - On Chrome, Edge and Android it pins in one tap.
  - On iPhone, iPad and Mac Safari it shows the two steps: **Share → Add to Home Screen** on iPhone and iPad, and **File → Add to Dock** on a Mac.
  - It disappears once you're using the pinned app.
- **Signing in:** the first time, enter your email and the code Cloudflare sends. After that the pinned app opens straight in for a month (steps 6 and 7 above).
  - On iPhone, a home screen app keeps its own sign-in, separate from Safari, so sign in once inside it.
- **Your name:** once signed in, your initial and name show at the top right. Its menu has **About Paperhaus** (when `SITE_URL` is set) and **Sign out**.
- **Shortcuts:** press and hold the icon on a phone, or right-click it on a computer, for Scan, Merge, Compress and Sign.

Your files still stay on each device. A scan started on your phone is on your phone; Phase 1 adds sending files between your own devices and to friends.

---

## Changing settings

Everything lives in `kit/kit.env`. Edit, commit, push, and Cloudflare rebuilds.

| Setting | What it does |
| --- | --- |
| `BRAND_NAME` | Name in the header, tab titles and footer |
| `BRAND_LOGO` | Leave empty for the Paperhaus brand mark (`kit/brand/`), or point at your own SVG or PNG in the repo |
| `SOURCE_URL` | Your public source code, linked as "Source code" in the account menu (the AGPL asks for this offer) |
| `FOOTER_TEXT` | Optional line at the bottom of every page. Empty by default |
| `SITE_URL` | Your public Paperhaus website (the front page in `website/`). Adds **About Paperhaus** to the account menu. Leave empty for no link |
| `OCR_LANGUAGES` | OCR languages served from your site, such as `eng,spa,hin`. Each adds a few MB |
| `DISABLE_TOOLS` | Comma-separated tool IDs to hide. The ID is the page name in the URL, such as `bates-numbering` |
| `DEFAULT_LANGUAGE` | Interface language friends see first |
| `THEME` | `soft`, `studio`, `lofi` or `crayon` (see "Designs" below), or `none` for BentoPDF's original dark look |
| `HOME_TITLE`, `HOME_SUBTITLE`, `HOME_NOTE` | Home page copy. Wrap one word of the title in `*stars*` for the italic accent word |

For a one-off test without editing the file, add a Cloudflare environment variable named `KIT_` plus the setting, such as `KIT_BRAND_NAME`.

---

## Brand

The brand kit lives in `kit/brand/`, and every design uses it:

| File | Used for |
| --- | --- |
| `paperhaus-mark.svg` | Logo beside the name in the header and footer |
| `paperhaus-favicon.svg` | Browser tab icon |
| `paperhaus-app-icon.svg` | Home screen and dock icon when Paperhaus is pinned (`icons/` holds the sizes made from it) |
| `paperhaus-logo.png`, `paperhaus-logo-on-dark.png`, `paperhaus-mark-on-dark.svg`, `paperhaus-app-icon-1024.png`, `paperhaus-favicon-512.png` | Kept for use outside the site: slides, docs, social profiles |

The name is set as the wordmark: lowercase "paperhaus" in Geist SemiBold, ink `#3A2A1F` (cream `#FBF1E4` in dark mode). Brand colours: orange `#F7A86E`, light peach `#FCD2B0`, cream `#FBF1E4`, ink `#3A2A1F`. Links and the italic headline word use a deeper `#B35A22`, because the brand orange is too light to read as text on cream.

To change the mark later, replace the files in `kit/brand/` with the same names. The `icons/` sizes were made from `paperhaus-app-icon.svg` and `paperhaus-favicon.svg`; send me new artwork and I'll regenerate them.

## Designs

Four directions, all in cream and pastel orange with espresso ink, and all switching to a warm cocoa dark mode with the device. Each uses your headline voice ("your files stay *yours.*").

| `THEME` | Look |
| --- | --- |
| `soft` (default) | Pillowy and calm. Brand cream `#FBF1E4` with a faint peach glow, white cards with 26px corners and warm diffused shadows instead of borders, Poppins throughout. The home header is a sunset card with a cream sun over rolling apricot hills (dusk after dark). Tool icons sit in pastel circles, a different tint per category (peach, apricot, coral, butter, blush, sand). Pill buttons in the brand orange, a gradient from `#FCC59B` to `#F7A86E` |
| `studio` | The Studiko sibling. Paper cream `#FAF6EE`, Geist with one Instrument Serif italic word, lowercase headlines, hairline borders, `#label` section titles. Burnt orange `#A84C1C` for links, pastel orange `#F6B88A` buttons |
| `lofi` | The QuackCode sibling. Oat cream `#F7EFE2` and cocoa ink `#3A2A20`, lowercase IBM Plex Mono headlines over Plex Sans, soft long shadows. The home header is one pastel apricot band `#F8CBA6` |
| `crayon` | The StudiUp sibling. Bricolage Grotesque over Figtree, a floating pill nav, espresso pill buttons with a pastel orange lip, a tilted peach sticker, a pastel highlighter, and a pastel per category |

In every direction, solid buttons use the design's button colour and the accent stays for links, icons and focus rings, so nothing that isn't a delete button looks like one.

How it's built:

- `kit/theme/base.css` is the shared engine. It points Tailwind's colour variables at a small set of tokens (background, surface, lines, text, accent, button), so every page, light and dark, follows the design without touching BentoPDF's code.
- `kit/theme/<name>/theme.css` sets a direction's tokens and its signature touches. The logo and icons come from the brand kit, the same for every design.
- `kit/theme/fonts/` holds the fonts, served from your own site, with their licences (all SIL Open Font License).
- The build replaces BentoPDF's "PDF Tools" heading on the home page with the `HOME_*` copy from `kit.env`.

To compare directions on a build you already have, switch in seconds without rebuilding:

```sh
KIT_THEME=studio node kit/build.mjs --theme-only
npx wrangler pages dev dist
```

When you've picked one, set `THEME` in `kit.env` and push. To fine-tune, edit that direction's `theme.css` and run `node kit/build.mjs --theme-only` again.

The working areas inside the embedded editors (the PDF editor canvas, the text editor, the Markdown editor) keep their own built-in styling.

---

## Pulling BentoPDF updates

BentoPDF ships often. Merge their changes about once a month:

```sh
git remote add upstream https://github.com/alam00000/bentopdf.git   # first time only
git fetch upstream
git merge upstream/main
git push
```

Because the kit lives in its own `kit/` folder and leaves `src/` untouched, these merges shouldn't conflict.

If a build ever fails with **"BentoPDF changed vite.config.ts"** or **"src/js/config/tools.ts"**, upstream reorganized the files the kit uses to list the Scan tool. Update the anchors in `installKitTools()` in `kit/build.mjs`, or send me the new files and I'll update it.

If a build ever fails with **"BentoPDF changed src/js/utils/libreoffice-loader.ts"**, upstream rewrote the function the kit patches. Office conversion needs that patch on Cloudflare, so the build stops instead of shipping a broken tool. Update `LOADER_ANCHOR` in `kit/build.mjs` to match the new code, or send me the new file and I'll update it.

---

## Building on your own computer (optional)

Useful for trying changes before pushing, or as a fallback if a Cloudflare build ever runs out of time or memory.

```sh
npm ci
node kit/build.mjs
npx wrangler pages dev dist           # preview at http://127.0.0.1:8788
npx wrangler pages deploy dist --project-name paperhaus   # deploy straight from your machine
```

BentoPDF's own build regenerates a few tracked files (blog pages, a partial, a header config). The kit puts them back afterward, so a local build leaves nothing new to commit.

---

## Known limits in Phase 0

- **Folder access:** files are uploaded to the browser tab and downloaded back. Opening and saving inside a folder comes in Phase 1.
- **Certificate signatures:** the Digital Signature tool works with your own certificate file. Fetching a certificate's issuer chain or a trusted timestamp needs outside servers, which the security policy blocks. Self-signed certificates and the regular Sign PDF tool are unaffected.
- **OCR languages:** only the languages in `OCR_LANGUAGES` are offered, in OCR PDF and in Scan.
- **Scan edge detection:** works best with a page on a darker or contrasting surface. On a white desk, or with a dark band at the page edge, drag the corners into place.
- **Summarize and Translate PDF:** they need desktop Chrome's built-in AI. Translated "same layout" pages are pictures, so their text can't be selected; use **Translated text** to get it as text.
- **HTML to PDF:** no JavaScript runs, so app-like pages may be blank. Pages behind a login can't be fetched.
- **Request Signatures:** these are electronic signatures with an audit certificate, like typical e-sign services, not certificate-based digital signatures. For a certificate signature on top, run the finished PDF through Digital Signature. Requests last 14 days.
- **App icons:** the home screen and dock icons come from `kit/brand/icons/`. A custom `BRAND_LOGO` changes the logo in the header and browser tab, not those icons.
- **Search engines:** the site sends `noindex` and its `robots.txt` blocks crawlers, so it stays unlisted.

## Cost

$0. Cloudflare Pages free plan (500 builds a month, 20,000 files a site; this site uses about 5,000), Cloudflare Zero Trust free plan (up to 50 users), Cloudflare KV free plan for signing requests (1 GB stored, 1,000 writes a day, enough for well over a hundred requests a day), a public GitHub repo, and open-source engines.
