// Google Search Console ownership check for https://paperhaus.pages.dev/ (needed for Google's
// OAuth app verification). Served by a function so Pages does not redirect away the ".html".
// Keep it: removing it un-verifies the site.
export function onRequest() {
  return new Response('google-site-verification: googlecf5f1722fa136511.html', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
