/**
 * Paperhaus signing reminders.
 *
 * When a request is set up for Gmail with reminders on (the Sign page's "Remind people who
 * haven't signed" box), /api/mail/esign leaves a marker `rm:<id>` whose metadata says when the
 * next reminder is due. runReminders() looks at the due markers and, for each signer who still
 * has to sign (only the current one when the order is fixed), sends a short reply in their
 * invite thread from the sender's Gmail: "A reminder to sign ...". The invite with the signing
 * link sits right above it in the thread, so the server never needs the link (it can't read it).
 *
 * Every REMIND_EVERY_DAYS days, at most MAX_REMINDERS per signer, only while the request is
 * open. Signers invited by hand (not through Paperhaus) have no thread and get none.
 *
 * What runs it: a GitHub Actions schedule (.github/workflows/sign-reminders.yml) calls
 * /api/esign/p/run-reminders every hour, and the Sign page's own API calls run it too, at most
 * every RUN_GAP_MIN minutes. Running it more often only checks; it sends nothing extra.
 */
import { getRequestMail, saveRequestMail, sendMail, mailConfigured } from './gmail.js';

export const REMIND_EVERY_DAYS = 3;
export const MAX_REMINDERS = 4;
const DAY = 86400000;
const RUN_GAP_MIN = 15;
// Local testing only: REMIND_TEST_EVERY_MS shortens the interval and skips the run throttle.
const every = (env) => (env.REMIND_TEST_EVERY_MS ? Number(env.REMIND_TEST_EVERY_MS) : REMIND_EVERY_DAYS * DAY);

/** Start (or keep) the reminder schedule for a request. */
export async function scheduleReminders(env, id, meta) {
  const key = `rm:${id}`;
  const have = await env.ESIGN.getWithMetadata(key);
  if (have && have.value !== null) return;
  const expiration = Math.floor(meta.expires / 1000);
  if (expiration < Date.now() / 1000 + 120) return;
  await env.ESIGN.put(key, '1', { expiration, metadata: { next: Date.now() + every(env) } });
}

export async function stopReminders(env, id) {
  await env.ESIGN.delete(`rm:${id}`);
}

/** Send the reminders that are due. Returns a short report. Throttled unless forced. */
export async function runReminders(env, { force = false } = {}) {
  if (!env.ESIGN || !mailConfigured(env)) return { skipped: 'not_configured' };
  const now = Date.now();
  if (!force && !env.REMIND_TEST_EVERY_MS) {
    const last = Number(await env.ESIGN.get('rm-last')) || 0;
    if (now - last < RUN_GAP_MIN * 60000) return { skipped: 'recent' };
  }
  await env.ESIGN.put('rm-last', String(now));
  const list = await env.ESIGN.list({ prefix: 'rm:', limit: 200 });
  let sent = 0;
  let checked = 0;
  for (const k of list.keys) {
    const next = (k.metadata && k.metadata.next) || 0;
    if (next > now) continue;
    checked++;
    try {
      sent += await remindOne(env, k.name.slice(3), now);
    } catch (err) {
      console.warn('Paperhaus reminders:', err && (err.code || err.message));
    }
  }
  return { checked, sent };
}

/** The indexes of signers who still have to sign. */
export async function pendingSigners(env, id, meta) {
  const done = new Set();
  const signed = await env.ESIGN.list({ prefix: `s:${id}:` });
  for (const k of signed.keys) done.add(Number(k.name.split(':')[2]));
  const out = [];
  for (let i = 0; i < meta.n; i++) if (!done.has(i)) out.push(i);
  return meta.ordered ? out.slice(0, 1) : out;
}

async function remindOne(env, id, now) {
  const key = `rm:${id}`;
  const meta = await env.ESIGN.get(`m:${id}`, 'json');
  if (!meta || meta.status !== 'out' || now > meta.expires) {
    await stopReminders(env, id);
    return 0;
  }
  const rec = await getRequestMail(env, id);
  if (!rec || rec.remind === false) {
    await stopReminders(env, id);
    return 0;
  }
  const pending = await pendingSigners(env, id, meta);
  if (!pending.length) {
    await stopReminders(env, id);
    return 0;
  }
  let sent = 0;
  let more = false;
  for (const i of pending) {
    const s = rec.signers[i];
    if (!s || s.me || !s.email || !s.threadId) continue;
    const count = (s.reminders || []).length;
    // Wait a full interval after the invite or the last reminder (manual ones count too).
    const last = Math.max(s.sentAt || 0, ...(s.reminders || []));
    if (count >= MAX_REMINDERS) continue;
    if (now - last < every(env) * 0.98) {
      more = true;
      continue;
    }
    await sendReminder(env, meta, rec, i);
    sent++;
    if (count + 1 < MAX_REMINDERS) more = true;
  }
  // In a fixed order, the next person may need reminders after the current one signs.
  if (meta.ordered && pending.length) more = true;
  if (sent) await saveRequestMail(env, id, rec, Math.floor((meta.retainUntil || meta.expires) / 1000));
  if (!more) {
    await stopReminders(env, id);
    return sent;
  }
  await env.ESIGN.put(key, '1', { expiration: Math.floor(meta.expires / 1000), metadata: { next: now + every(env) } });
  return sent;
}

/** One reminder to signer i, as a reply in their invite thread when there is one. */
export async function sendReminder(env, meta, rec, i, link) {
  const s = rec.signers[i];
  const first = String(s.name || '').split(/\s+/)[0] || 'there';
  const until = new Date(meta.expires).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  const where = link ? `Here is your signing link again:\n${link}` : 'Use the signing link in my earlier email in this thread.';
  const text = `Hi ${first},\n\nA quick reminder to sign "${rec.title}". ${where}\n\nIt is open until ${until}.\n\n${rec.senderName || ''}`.trim();
  const out = await sendMail(env, meta.sender, {
    to: s.email,
    subject: s.threadId ? `Re: Please sign: ${rec.title}` : `Reminder: please sign ${rec.title}`,
    text,
    threadId: s.threadId,
    inReplyTo: s.messageId,
    fromName: rec.senderName,
    from: rec.gmail,
  });
  const at = Date.now();
  rec.signers[i] = {
    ...s,
    reminders: [...(s.reminders || []), at].slice(-10),
    ...(s.threadId ? {} : { threadId: out.threadId, messageId: out.messageId, sentAt: at }),
  };
  return at;
}
