# Paperhaus security and records policies (drafts)

Short, working policies for running Paperhaus as a business tool. They describe what the
code and setup do, so each line can be checked. They are modeled on the controls
that 21 CFR Part 11, HIPAA and SOC 2 ask about, but Paperhaus holds none of those
certifications, and it is not set up for HIPAA-covered data (see "Not covered" below).

Owner: Yash Vagal. Review: every 6 months, and after any incident or major change.

## 1. Access

- Only invited people can open the app. Sign-in is Cloudflare Access with a one-time
  email code; the invite list is the Access policy "Paperhaus friends".
- Adding or removing someone is a change to that policy, made by the owner only. Remove
  people the same day they no longer need access.
- Review the invite list every 3 months.
- Signers of a signing request need no account. Each gets a private link with its own
  token; only SHA-256 hashes of tokens are stored.
- Admin accounts (GitHub, Cloudflare) must use a password manager and two-step sign-in.

## 2. Data

- Most tools run entirely in the browser. Files are not uploaded and nothing is stored
  on a server.
- Recent files (for "keep working") stay in the browser that made them and can be cleared
  from the account menu.
- Signing requests are encrypted in the sender's browser (AES-256-GCM) before upload. The
  key is only in the signing links, after the #, which browsers never send to a server.
  Paperhaus stores ciphertext it cannot read, plus times, IP addresses and browsers for
  the audit trail.
- HTML to PDF fetches the page the user asks for and stores nothing.

## 3. Electronic signatures and records

- Each signer opens their own link and agrees to sign electronically before signing.
- Each signature carries its meaning (Author, Approved, Reviewed, Agreed, Witness,
  Received), shown to the signer and printed in the signing record.
- Every step is written to an audit trail: created, opened, signed, declined, completed,
  sealed. Each entry holds the SHA-256 of the entry before it, so a changed or removed
  entry breaks the chain. The trail can be exported as CSV.
- When everyone has signed, the PDF gets a signing record and an audit trail page, then
  it is sealed with the Paperhaus certificate (ECDSA P-256) and timestamped by an
  independent RFC 3161 time server. Any later change shows as a broken seal in PDF
  readers. The sealed copy's SHA-256 fingerprint is recorded, so any copy can be checked.
- The seal key is generated on the server, kept in Cloudflare KV and never sent to a
  browser. Only a hash of each PDF is sent to be sealed.

## 4. Retention

- Signers have 14 days to sign.
- The sender chooses how long signed records are kept: 14 days, 1 year (default) or
  7 years. Cloudflare deletes them automatically after that.
- The sender can delete a request and its record at any time.
- Keep a downloaded copy of anything that must outlive the chosen period.

## 5. Changes

- All changes are in Git (github.com/yashvagal/paperhaus). The main branch is protected
  from force pushes and deletion (ruleset "Protect main").
- CodeQL scans the code and Trivy scans the dependencies on every push to main and
  weekly. Dependabot alerts on vulnerable dependencies and opens grouped fixes. Secret
  scanning with push protection blocks commits that contain keys or passwords.
- Once a month a scheduled check compares Paperhaus with BentoPDF. Updates worth taking
  are merged on a separate branch, built and tested, and go live only after review.
- Every change deploys through Cloudflare Pages from main; a failed build never replaces
  the live site.
- Before a change to signing, sealing or storage goes live, it is tested end to end
  (create, sign, seal, check the seal, check the audit trail).

## 6. Incidents

- Signs: unexpected sign-ins in Cloudflare Access logs, an audit trail that fails its
  chain check, a seal that shows as broken on an untouched copy, or a dependency alert.
- Steps: contain (remove access, rotate the affected credential, or roll back the
  deployment in Cloudflare Pages), find out what happened, fix, and tell affected people
  within 72 hours if their data may have been exposed.
- Keep a short written record of every incident: what, when, impact, fix.

## 7. Vendors

| Vendor | Used for | Holds |
| --- | --- | --- |
| Cloudflare | Hosting (Pages), sign-in (Access), storage (KV) | Encrypted signing requests, seal key, audit trails |
| GitHub | Source code, scanning, dependency updates | Code only |
| DigiCert, Sectigo, SSL.com | Timestamps (RFC 3161) | Only a hash of the seal signature |
| Gmail or Outlook (the sender's own) | Sending signing links | The emails the sender sends |

## Not covered

- HIPAA: Cloudflare signs a Business Associate Agreement only on its Enterprise plan, so
  do not put patient health information into signing requests. Tools that run in the
  browser do not send files anywhere.
- Signer identity beyond the email link (for example a code sent to the signer, or
  ID checks) is not in place yet.
- The seal certificate is Paperhaus's own, not from a public authority, so PDF readers
  show the document as intact and unchanged with the signer's identity as not verified by
  a public authority.
- Formal audits, penetration tests and computer system validation (Part 11) are not done.
