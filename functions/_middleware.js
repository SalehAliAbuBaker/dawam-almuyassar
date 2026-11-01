// Dawam stage — inject a small, versioned navigation enhancement into the
// existing large app shell without replacing or rebuilding its contents.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const res = await context.next();
  if (context.request.method !== 'GET' ||
      !['/', '/index.html'].includes(url.pathname) ||
      !res.ok || !(res.headers.get('content-type') || '').includes('text/html')) {
    return res;
  }
  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append('<link rel="manifest" href="/dawam.webmanifest"><script defer src="/app-integration.js?v=0.2.18-dev"></script>', {html: true});
      }
    })
    .transform(res);
}
