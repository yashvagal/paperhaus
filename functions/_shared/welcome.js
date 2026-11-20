/**
 * The "You're in" email the owner sends when adding someone on the invite page
 * (kit/public/people.html), from the owner's own connected Gmail. Same words Yash approved
 * for the first welcome emails (Nov 18, 2026).
 */
import { sendMail } from './gmail.js';

export const WELCOME_SUBJECT = "You're in: Paperhaus";

export function welcomeText(name, email, appUrl, signOff) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  return `Hi ${first},

You now have access to Paperhaus, a private PDF toolkit I've been building. It's free, and it works on your phone and computer.

How to get in
1. Go to ${appUrl}
2. Type this email address (${email}) and press "Send me a code".
3. Enter the code from your inbox. You stay signed in for about a month.

On your phone, tap your initial at the top right, then "Add to home screen", so it opens like an app.

What you can do
- Drop any file on the home page and it shows what you can do with it: make it smaller, combine or split, rotate, convert to or from Word, Excel or PowerPoint, add a password, or black out private details.
- Sign: sign a PDF yourself, or send it to others to sign. They get an email with their own link and don't need an account. Under Sign, then Sent, you can see who has signed and send reminders.
- Scan paper with your phone camera into a clean PDF.
- My documents keeps everything you make, on all your devices, sorted by tool.
- Search (the magnifying glass at the top) finds any tool or document.

Your files are processed on your own device, and anything saved to your account is encrypted.

Questions, or something confusing? Just reply to this email.

${signOff || ''}`.trim();
}

/** Send it from the owner's Gmail (their own address if connected, else their main one). */
export async function sendWelcome(env, owner, ownerName, email, name) {
  const appUrl = env.APP_URL || 'https://paperhaus.pages.dev';
  const first = String(ownerName || '').trim().split(/\s+/)[0];
  await sendMail(env, owner, {
    to: email,
    subject: WELCOME_SUBJECT,
    text: welcomeText(name, email, appUrl, first),
    fromName: ownerName || undefined,
    from: owner,
  });
}
