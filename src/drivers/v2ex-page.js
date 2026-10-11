// Read-only readiness check. A security interstitial is not an invalid session.
export async function waitForV2EXPage(page, { timeout = 15000, pollMs = 500 } = {}) {
  const budget = Math.max(0, Math.min(Number(timeout) || 0, 60000));
  const interval = Math.max(1, Number(pollMs) || 500);
  const deadline = performance.now() + budget;
  let lastSnapshot = null;
  async function bounded(operation) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation).catch(() => null),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - performance.now())); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  for (;;) {
    const snapshot = await bounded(() => page.evaluate(() => {
      const title = document.title;
      const text = document.body?.innerText || '';
      return {
        title,
        text,
        challenge: Boolean(document.querySelector('#challenge-running, #challenge-stage, form#challenge-form'))
          || /Just a moment|请稍候|Attention Required/i.test(title)
          || /正在安全验证|Checking your browser|Verifying you are human/i.test(text),
        authenticated: Boolean(document.querySelector('a[href="/settings"], a[href^="/signout"]')),
        loginForm: Boolean(document.querySelector('form[action="/signin"] input[type="password"]')),
      };
    })); // Cloudflare can replace the document while being read.
    if (snapshot) lastSnapshot = snapshot;
    if (snapshot && !snapshot.challenge) {
      return { ...snapshot, state: snapshot.authenticated ? 'authenticated' : snapshot.loginForm ? 'unauthenticated' : 'unknown' };
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { ...(lastSnapshot || {}), state: lastSnapshot?.challenge ? 'challenge' : 'unknown' };
    await bounded(() => page.waitForTimeout(Math.min(interval, remaining)));
  }
}
