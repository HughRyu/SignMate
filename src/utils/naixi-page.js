// Naixi's sign page is server-rendered; only document responses are needed.
export async function prepareNaixiPage(page) {
  // Slow stylesheets and synchronous scripts can prevent DOMContentLoaded even
  // after the HTML returns 200. Login, qiandao links and stats are in that HTML;
  // the driver navigates to the sign URL itself, without the site's JS handler.
  await page.route('**/*', route => route.request().resourceType() === 'document'
    ? route.continue()
    : route.abort());
}
