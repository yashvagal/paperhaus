# Deploy Paperhaus

Two pieces, both free:

| Piece | Folder | Host | Who can open it |
| --- | --- | --- | --- |
| **The app**: all the tools | `kit/` (builds BentoPDF into Paperhaus) | Cloudflare Pages, with Cloudflare Access for sign-in | You and the friends you add |
| **The website**: the public front page | `website/` | Vercel | Anyone |

The website's **Open Paperhaus** and **Sign in** buttons go to the app. The app's account menu has **About Paperhaus**, which goes back to the website.

Time: about 45 minutes. Cost: $0. You'll need free accounts on GitHub, Cloudflare and Vercel. Cloudflare may ask for a card when you turn on Zero Trust, even on the $0 plan; nothing is charged on Free.

---

## 1. Make the repo

1. Open <https://github.com/alam00000/bentopdf> and click **Fork**.
2. Name it `paperhaus`, keep it **public** and under your personal account (not an organization), then create the fork.
   - AGPL-3.0 requires the source to be public.
   - Vercel's free plan can't deploy from a repo owned by an organization.
3. Clone it:

   ```sh
   git clone https://github.com/yashvagal/paperhaus.git
   cd paperhaus
   ```

4. Unzip `paperhaus-deploy.zip` into the repo root. You should now have `paperhaus/kit/`, `paperhaus/website/` and this `paperhaus/DEPLOY.md`.
5. Push:

   ```sh
   git add kit website DEPLOY.md
   git commit -m "Add Paperhaus app kit and website"
   git push
   ```

## 2. Put the app on Cloudflare Pages

1. Sign in at <https://dash.cloudflare.com>.
2. Go to **Workers & Pages → Create → Pages → Connect to Git** and pick `yashvagal/paperhaus`.
3. Build settings:

   | Setting | Value |
   | --- | --- |
   | Project name | `paperhaus` |
   | Framework preset | None |
   | Build command | `node kit/build.mjs` |
   | Build output directory | `dist` |
   | Environment variable | `NODE_VERSION` = `22` |

4. Click **Save and Deploy**. The first build takes about 5-10 minutes.
5. Write down the app's address. It's `https://paperhaus.pages.dev`, or the name Cloudflare picked if that one was taken.
6. Open the project's **Settings → Build → Build watch paths** and add `website/*` under **Exclude paths**. Then edits to the website don't rebuild the app.

## 3. Make the app friends-only

In the Cloudflare dashboard, open **Zero Trust**. The first time, choose a team name and the **Free** plan.

1. Go to **Access → Applications → Add an application → Self-hosted**.
   - Name: `Paperhaus`.
   - Add two hostnames. Leave **Path** empty on both:
     - **Subdomain** empty, **Domain** your app's address (for example `paperhaus.pages.dev`). This is the app itself.
     - **Subdomain** `*`, same **Domain**. This covers preview builds. A `*` alone does not cover the app's main address, so you need both.
   - **Session Duration**: **1 month**.
   - Add a policy: **Action: Allow**, rule **Emails**, listing you and each friend.
2. Under **Settings → Authentication**:
   - Make sure **One-time PIN** is on.
   - Set **Global session timeout** to **1 month**.
3. Let the app icon load before sign-in, so pinning shows the Paperhaus icon.
   - Add a second **Self-hosted** application named `Paperhaus icons`, with **Subdomain** empty and the same **Domain**.
   - Give it three **Paths**: `site.webmanifest`, `images/*` and `favicon.ico`.
   - Add one policy: **Action: Bypass**, **Include: Everyone**.
   - These are only the logo and the app's name, nothing private.
4. Open the app's address in a private window. It should ask for your email and send a code.

To add a friend later, add their email to the `Paperhaus` policy. If an email isn't on the list, Cloudflare sends no code, so check the spelling first.

## 3b. Turn on Request Signatures

Signing requests are stored, encrypted, in Cloudflare KV, and signers open them without an invite.

1. In Cloudflare, go to **Storage & Databases → Workers KV → Create**, and name it `paperhaus-esign`.
2. Open the Pages project, then **Settings → Bindings → Add → KV namespace**. Variable name `ESIGN`, namespace `paperhaus-esign`. Add it for both **Production** and **Preview**.
3. Let signers reach the signing page without signing in. In **Zero Trust → Access → Applications**, edit `Paperhaus icons` and add these **Paths** on the main hostname:
   - `sign-request`
   - `sign-request.html`
   - `api/esign/p/*`
   - `assets/*`
   - `kit-theme/*`
   These are the signing page, the API it uses (every call needs a token from a signing link) and the app's code and styles, which are open source anyway. Creating a request (`api/esign/new`) still needs a Paperhaus sign-in.
4. Retry the latest deployment (**Deployments → ... → Retry deployment**) so the binding takes effect.

## 3c. Send signing emails from Gmail (optional, free)

Without this, Paperhaus opens a Gmail draft for each invite and you press Send. With it,
invites go out on their own from your address, you get an email when someone signs,
declines or everyone is done, and the next signer gets an "it's your turn" note.

1. Go to console.cloud.google.com and create a project named **Paperhaus**.
2. **APIs & Services → Library**: search **Gmail API** and press **Enable**.
3. **Google Auth Platform → Branding** (or **OAuth consent screen**): app name **Paperhaus**,
   your email as support and developer contact. Audience: **External**.
4. **Data access → Add or remove scopes**: add `.../auth/gmail.send`. Save.
5. **Audience → Publish app** (to Production). Leaving it in Testing makes the connection
   expire every 7 days. Google shows people a "Google hasn't verified this app" screen
   once when they connect; press **Advanced → Go to Paperhaus**. That is expected for a
   private app.
6. **Clients → Create client → Web application**, name **Paperhaus**. Under **Authorized
   redirect URIs** add `https://paperhaus.pages.dev/api/mail/callback`. Create, then copy
   the **Client ID** and **Client secret**.
7. In Cloudflare: **Workers & Pages → paperhaus → Settings → Variables and Secrets → Add**:
   `GOOGLE_CLIENT_ID` (text) with the client ID, and `GOOGLE_CLIENT_SECRET` (secret) with
   the client secret, for **Production**. Save, then **Deployments → Retry deployment** on
   the latest one so the new variables apply.
8. On the Sign page, under **Send from**, type the address to send from, press **Connect** and allow sending (add more addresses with **Another address...**). Everyone else who sends
   requests presses it once for their own Gmail.

The `gmail.send` permission can send email only; it cannot read your mail. You can
disconnect from the Sign page, or remove Paperhaus at myaccount.google.com/permissions.

## 4. Put the website on Vercel

1. Sign in at <https://vercel.com> and click **Add New → Project**.
2. Import `yashvagal/paperhaus`.
3. Settings:

   | Setting | Value |
   | --- | --- |
   | Project name | `paperhaus` |
   | Framework preset | Other |
   | Root directory | `website` |
   | Build command, output directory, install command | leave empty |

4. Click **Deploy**. It takes under a minute.
5. Write down the website's address. It's `https://paperhaus.vercel.app`, or the name Vercel picked.

`website/vercel.json` adds security headers. It also skips a rebuild when a push doesn't touch `website/`, so app changes don't redeploy the website.

## 5. Connect the two

1. In `website/config.js`, set the app's address from step 2. No slash at the end:

   ```js
   window.PAPERHAUS_APP_URL = 'https://paperhaus.pages.dev';
   ```

2. In `kit/kit.env`, set the website's address from step 4:

   ```
   SITE_URL=https://paperhaus.vercel.app
   ```

3. Push:

   ```sh
   git commit -am "Connect the Paperhaus app and website"
   git push
   ```

   Vercel redeploys the website in under a minute. Cloudflare rebuilds the app in about 5-10 minutes.

## 6. Brand the sign-in page

Cloudflare shows its own sign-in screen before the app. Make it look like Paperhaus:

1. In **Zero Trust**, open **Settings → Custom pages**. On some dashboards it's under **Reusable components → Custom pages**.
2. Next to **Login page**, choose **Customize**:

   | Field | Value |
   | --- | --- |
   | Organization name | `Paperhaus` |
   | Logo URL | your website address + `/images/paperhaus-icon.png`, for example `https://paperhaus.vercel.app/images/paperhaus-icon.png` |
   | Background color | `#FBF1E4` |
   | Header text | `Sign in to Paperhaus` |
   | Footer text | `Invite only. Ask Yash for access.` |

3. Save, and check it in a private window.

## 7. Check it

- [ ] The website opens at its address, on your phone and your computer.
- [ ] **Open Paperhaus** asks for your email, sends a code, and opens the app.
- [ ] **Try Scan** opens Scan to PDF in the app, after sign-in.
- [ ] In the app, your initial at the top right opens a menu with **About Paperhaus** (goes back to the website) and **Sign out**.
- [ ] A private window shows the sign-in page in Paperhaus colors.
- [ ] Pin it on your phone: in the app, tap **Add to home screen** at the top right, open it from the home screen, and sign in once. Close it and reopen it. It should open straight in.
- [ ] Then the tool checklist in `kit/README.md` (section 5): Merge, OCR, Word to PDF, PDF/A, Markdown and Scan.

---

## Later: your own domain (optional, about $10 a year)

1. Buy a domain, for example at Cloudflare Registrar, which sells at cost.
2. Website: in Vercel, **Settings → Domains**, add `yourdomain.com`.
3. App: in Cloudflare Pages, **Custom domains**, add `app.yourdomain.com`.
4. In the `Paperhaus` and `Paperhaus icons` Access applications, change the domain to `app.yourdomain.com`.
5. Update `website/config.js` and `SITE_URL` in `kit/kit.env` to the new addresses, then push.

## If something goes wrong

- **The app build fails or times out on Cloudflare** (the free plan stops builds after 20 minutes): build on your computer and upload instead. See "Building on your own computer" in `kit/README.md`.
- **A friend gets no code:** check their email is in the `Paperhaus` policy exactly as they type it.
- **Open Paperhaus goes to the wrong place:** check `website/config.js` has the app's address with `https://` and no slash at the end.
- **No About Paperhaus in the app's menu:** check `SITE_URL` in `kit/kit.env` starts with `https://`, then push to rebuild.
