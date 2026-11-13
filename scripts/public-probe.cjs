'use strict';

const ORIGIN = 'https://www.memonogi.com';
const sitemapChildren = ['/sitemap-static.xml', '/sitemap-posts.xml', '/sitemap-outfits.xml', '/sitemap-items.xml'];

function sitemapLocations(body, root) {
  const match = new RegExp(`^\\s*(?:<\\?xml[^?]*\\?>\\s*)?<${root}(?:\\s+xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")?\\s*>([\\s\\S]*)</${root}>\\s*$`).exec(body);
  if (!match) throw Error('Invalid sitemap document');
  const entry = root === 'sitemapindex' ? 'sitemap' : 'url';
  const locations = [];
  const remainder = match[1].replace(new RegExp(`<${entry}>\\s*<loc>([^<>]+)</loc>\\s*(?:<lastmod>[^<>]+</lastmod>\\s*)?</${entry}>`, 'g'), (_, value) => {
    if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) throw Error('Invalid sitemap location');
    const decoded = value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"})[entity]);
    const url = new URL(decoded);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash) throw Error('Unexpected sitemap origin');
    locations.push(url);
    return '';
  });
  if (remainder.trim()) throw Error('Invalid sitemap entries');
  return locations;
}

function essentialUrls(locations) {
  return ['/', '/auction-history', '/community'].every((path) => locations.some((url) => url.pathname === path && !url.search));
}

async function checkSitemap(body, _revision, read) {
  if (!/<sitemapindex(?:\s|>)/.test(body)) return essentialUrls(sitemapLocations(body, 'urlset'));
  const locations = sitemapLocations(body, 'sitemapindex');
  if (!locations.every((url) => sitemapChildren.includes(url.pathname)
    && (url.pathname === '/sitemap-static.xml' ? !url.search : [...url.searchParams.keys()].every((key) => key === 'cursor')
      && url.searchParams.getAll('cursor').length <= 1
      && (!url.search || /^[\w-]{1,2048}$/.test(url.searchParams.get('cursor') || ''))))) return false;
  if (!sitemapChildren.every((path) => locations.some((url) => url.pathname === path && !url.search))) return false;
  for (const path of sitemapChildren) {
    const entries = sitemapLocations(await read(path), 'urlset');
    if (path === '/sitemap-static.xml') {
      if (!essentialUrls(entries)) return false;
    } else {
      const pattern = path === '/sitemap-posts.xml' ? /^\/community\/[1-9]\d*$/
        : path === '/sitemap-outfits.xml' ? /^\/outfits\/[1-9]\d*$/ : /^\/items\/[\w-]+$/;
      if (!entries.every((url) => !url.search && pattern.test(url.pathname))) return false;
    }
  }
  return true;
}

const routes = [
  ['/api/health', (body, revision) => { const data = JSON.parse(body); return data.service === 'devnogi-react' && data.revision === revision; }],
  ['/', (body) => /<section\b[^>]*\baria-label="아이템 검색"[^>]*>/.test(body)
    && /<summary\b[^>]*>[\s\S]*?주요 기능 보기[\s\S]*?<\/summary>/.test(body)],
  ['/auction-history', (body) => /<h1\b[^>]*>\s*(?:마비노기 경매장 거래내역·시세|경매장 거래내역|마비노기 경매장 거래내역·아이템 시세 검색)\s*<\/h1>/.test(body)],
  ['/sitemap.xml', checkSitemap],
  ['/robots.txt', (body) => body.includes(`Sitemap: ${ORIGIN}/sitemap.xml`)],
];

async function probe({origin, revision, timeout, request = fetch, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))}) {
  if (origin !== ORIGIN || !/^[a-f0-9]{40}$/.test(revision) || !/^[1-9][0-9]{0,2}$/.test(String(timeout)) || +timeout > 600) throw Error('Invalid public probe inputs');
  const deadline = now() + timeout * 1000;
  const read = async (path) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw Error('Public verification deadline exceeded');
    const response = await request(`${origin}${path}`, {redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(Math.min(path.startsWith('/sitemap') ? 30000 : 5000, remaining))});
    if (response.status !== 200) throw Error('Public endpoint unavailable');
    return response.text();
  };
  while (now() < deadline) {
    let passed = true;
    for (const [path, check] of routes) {
      const remaining = deadline - now();
      if (remaining <= 0) { passed = false; break; }
      try {
        if (!await check(await read(path), revision, read)) { passed = false; break; }
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
