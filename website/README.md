# Paperhaus website

The public front page for Paperhaus. Plain HTML, CSS and a little JavaScript, with no build step and nothing loaded from other sites: the fonts and icons are served from here too.

| File | What it is |
| --- | --- |
| `index.html` | The front page |
| `config.js` | **The app's address.** Every Open Paperhaus, Sign in and tool link points here |
| `styles.css` | The soft cream and pastel orange design, light and dark |
| `site.js` | Points the app links at `config.js`, and shows the pin steps for the visitor's device |
| `404.html` | Page not found |
| `vercel.json` | Security headers, and skips rebuilding when a push doesn't touch this folder |
| `fonts/` | Poppins and Geist, with their licences (SIL Open Font License) |
| `images/` | App icon, share preview (`og.png`) and the logo used on the sign-in page |

Deploy steps are in `DEPLOY.md` at the repo root.

To preview it on your computer:

```sh
npx serve website
```

To edit copy, change `index.html` directly. The tool counts on the family cards match BentoPDF v2.8.8 plus the kit's Scan tools. If you hide tools with `DISABLE_TOOLS` in `kit/kit.env`, update the counts here too.
