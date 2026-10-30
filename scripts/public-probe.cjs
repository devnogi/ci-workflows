'use strict';

const ORIGIN = 'https://www.memonogi.com';
const routes = [
  ['/api/health', (body, revision) => { const data = JSON.parse(body); return data.service === 'devnogi-react' && data.revision === revision; }],
  ['/', (body) => /<h1\b[^>]*>\s*마비노기 경매장·시세·아이템 정보\s*<\/h1>/.test(body)],
  ['/auction-history', (body) => /<h1\b[^>]*>\s*마비노기 경매장 거래내역·아이템 시세 검색\s*<\/h1>/.test(body)],
  ['/sitemap.xml', (body) => ['/', '/auction-history', '/community'].every((path) => body.includes(`<loc>${ORIGIN}${path}</loc>`))],
  ['/robots.txt', (body) => body.includes(`Sitemap: ${ORIGIN}/sitemap.xml`)],
];

async function probe({origin, revision, timeout, request = fetch, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))}) {
  if (origin !== ORIGIN || !/^[a-f0-9]{40}$/.test(revision) || !/^[1-9][0-9]{0,2}$/.test(String(timeout)) || +timeout > 600) throw Error('Invalid public probe inputs');
  const deadline = now() + timeout * 1000;
  while (now() < deadline) {
    let passed = true;
    for (const [path, check] of routes) {
      const remaining = deadline - now();
      if (remaining <= 0) { passed = false; break; }
      try {
        const response = await request(`${origin}${path}`, {redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(Math.min(5000, remaining))});
        if (response.status !== 200 || !check(await response.text(), revision)) { passed = false; break; }
      } catch { passed = false; break; }
    }
    if (passed) return;
    const remaining = deadline - now();
    if (remaining > 0) await wait(Math.min(5000, remaining));
  }
  throw Error('Public verification failed or timed out');
}

module.exports = {probe, routes};
if (require.main === module) probe({origin: process.env.PUBLIC_ORIGIN, revision: process.env.ARTIFACT_REVISION, timeout: process.env.HEALTH_TIMEOUT}).catch((error) => { console.error(error.message); process.exitCode = 1; });
