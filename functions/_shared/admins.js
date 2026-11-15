/** The Paperhaus owner(s): ADMIN_EMAILS (comma-separated), or yashvagal@gmail.com. */
export function adminEmails(env) {
  return String((env && env.ADMIN_EMAILS) || 'yashvagal@gmail.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdmin(request, env) {
  const user = (request.headers.get('cf-access-authenticated-user-email') || '').toLowerCase();
  return !!user && adminEmails(env).includes(user);
}
