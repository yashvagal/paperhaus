// The invite page is the owner's only: anyone else signed in gets "not found".
import { isAdmin } from './_shared/admins.js';
export async function onRequest(context) {
  if (!isAdmin(context.request, context.env)) return new Response('Not found', { status: 404 });
  return context.next();
}
