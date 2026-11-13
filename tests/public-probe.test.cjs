'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {probe} = require('../scripts/public-probe.cjs');
const {validateInputs} = require('../scripts/release.cjs');

const revision = 'a'.repeat(40);
const origin = 'https://www.memonogi.com';
const children = ['/sitemap-static.xml', '/sitemap-posts.xml', '/sitemap-outfits.xml', '/sitemap-items.xml'];
const urlset = (paths) => `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((x) => `<url><loc>${origin}${x}</loc></url>`).join('')}</urlset>`;
const index = (paths) => `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((x) => `<sitemap><loc>${origin}${x}</loc></sitemap>`).join('')}</sitemapindex>`;
const bodies = {
  '/api/health': JSON.stringify({service: 'devnogi-react', revision}),
  '/': '<section class="hero" aria-label="아이템 검색"></section><details><summary class="toggle">주요 기능 보기<svg></svg></summary></details>',
  '/auction-history': '<h1>마비노기 경매장 거래내역·시세</h1>',
  '/sitemap.xml': index(children),
  '/sitemap-static.xml': urlset(['', '/auction-history', '/community']),
  '/sitemap-posts.xml': urlset(['/community/2']),
  '/sitemap-outfits.xml': urlset(['/outfits/3']),
  '/sitemap-items.xml': urlset(['/items/WyJpdGVtIl0']),
  '/robots.txt': `Sitemap: ${origin}/sitemap.xml`,
};
function fixture(changes = {}, failFirst = false) {
  let time = 0; let count = 0;
  return {
    origin, revision, timeout: 10, now: () => time, wait: async (ms) => { time += ms; },
    request: async (url, options) => {
      assert.equal(options.redirect, 'manual');
      const path = url.slice(origin.length);
      const item = changes[path] || {};
      const first = failFirst && count++ === 0;
      return {status: first ? 503 : (item.status ?? 200), text: async () => item.body ?? bodies[path]};
    },
  };
}
test('public verification succeeds and retries transient failure', async () => {
  await probe(fixture());
  await probe(fixture({}, true));
});

test('sitemap verification accepts the previous URL set and normalizes the home slash', async () => {
  await probe(fixture({'/sitemap.xml': {body: urlset(['/', '/auction-history', '/community'])}}));
  await probe(fixture({'/sitemap.xml': {body: urlset(['', '/auction-history', '/community'])}}));
});

test('sitemap index checks only four required children even with continuation pages', async () => {
  const config = fixture({'/sitemap.xml': {body: index([...children, '/sitemap-items.xml?cursor=abc_123', '/sitemap-posts.xml?cursor=12'])}});
  const requested = [];
  const request = config.request;
  config.request = async (url, options) => { requested.push(url); return request(url, options); };
  await probe(config);
  assert.deepEqual(requested.filter((url) => /\/sitemap-/.test(url)), children.map((path) => `${origin}${path}`));
});

test('sitemap verification rejects malformed, incomplete, foreign, and unavailable children', async () => {
  for (const changes of [
    {'/sitemap.xml': {body: index(children.slice(0, -1))}},
    {'/sitemap.xml': {body: index(children).replace('</sitemapindex>', '')}},
    {'/sitemap.xml': {body: index(children).replace(`${origin}/sitemap-items.xml`, 'https://other.example/sitemap-items.xml')}},
    {'/sitemap.xml': {body: index([...children, '/api/private'])}},
    {'/sitemap.xml': {body: index([...children, '/sitemap-items.xml?cursor=a&amp;cursor=b'])}},
    {'/sitemap.xml': {body: index([...children, '/sitemap-static.xml?cursor=12'])}},
    {'/sitemap-static.xml': {body: urlset(['/', '/auction-history'])}},
    {'/sitemap-static.xml': {body: '<urlset><loc>https://www.memonogi.com/</loc></urlset>'}},
    {'/sitemap-posts.xml': {body: urlset(['/outfits/2'])}},
    {'/sitemap-items.xml': {body: '<urlset><url><loc>bad&amp;broken</loc></url></urlset>'}},
    ...children.flatMap((path) => [{[path]: {status: 503}}, {[path]: {status: 308}}, {[path]: {body: '<html>upstream error</html>'}}]),
  ]) await assert.rejects(probe(fixture(changes)), /Public verification failed/);
});

test('empty dynamic URL sets remain valid while all required children must respond', async () => {
  await probe(fixture(Object.fromEntries(children.slice(1).map((path) => [path, {body: urlset([])}]))));
});

test('sitemap requests allow thirty seconds while respecting the overall deadline', async () => {
  const original = AbortSignal.timeout;
  const budgets = [];
  try {
    AbortSignal.timeout = (ms) => { budgets.push(ms); return new AbortController().signal; };
    await probe({...fixture(), timeout: 60});
    assert.deepEqual(budgets, [5000, 5000, 5000, 30000, 30000, 30000, 30000, 30000, 5000]);
    budgets.length = 0;
    await probe({...fixture(), timeout: 2});
    assert.ok(budgets.every((ms) => ms === 2000));
  } finally { AbortSignal.timeout = original; }
});
test('auction verification accepts the current SEO heading and both previous headings', async () => {
  for (const heading of ['마비노기 경매장 거래내역·시세', '경매장 거래내역', '마비노기 경매장 거래내역·아이템 시세 검색']) {
    await probe(fixture({'/auction-history': {body: `<header><h1 class="text-xl">\n ${heading}\n</h1></header>`}}));
  }
});
test('auction verification still rejects missing, unrelated, and error headings', async () => {
  for (const body of [
    '<div>경매장 거래내역</div>',
    '<h2>경매장 거래내역</h2>',
    '<h1>경매장 현재 매물</h1>',
    '<h1>경매장 거래내역 오류</h1>',
    '<h2>마비노기 경매장 거래내역·시세</h2>',
    '<h1>마비노기 경매장 거래내역·시세 오류</h1>',
    '<h1>문제가 발생했습니다</h1>',
  ]) await assert.rejects(probe(fixture({'/auction-history': {body}})), /Public verification failed/);
});
test('every public assertion fails closed', async () => {
  for (const changes of [
    {'/api/health': {body: JSON.stringify({service: 'devnogi-react', revision: 'b'.repeat(40)})}},
    {'/api/health': {body: '{'}}, {'/api/health': {body: JSON.stringify({service: 'wrong', revision})}},
    {'/': {status: 307}},
    {'/': {body: '<h1>마비노기 경매장·시세·아이템 정보</h1>'}},
    {'/': {body: '<section aria-label="아이템 검색"></section>'}},
    {'/': {body: '<details><summary>주요 기능 보기</summary></details>'}},
    {'/auction-history': {body: '<h1>wrong</h1>'}}, {'/auction-history': {status: 302}},
    {'/sitemap.xml': {status: 404}}, {'/sitemap.xml': {body: `<loc>${origin}/</loc>`}},
    {'/robots.txt': {status: 500}}, {'/robots.txt': {body: 'wrong'}},
  ]) await assert.rejects(probe(fixture(changes)), /Public verification failed/);
});
test('React origin is required and must be the exact approved origin', () => {
  const env = {GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: revision, GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'devnogi/devnogi-react', SERVICE_NAME: 'react', SERVICE_PROFILE: 'react', DEPLOYMENT_TARGET: 'prod2', COMPOSE_FILE: 'compose.yml', DOCKERFILE: 'Dockerfile', HEALTH_TIMEOUT: '60', PLATFORM: 'linux/amd64', PUBLIC_ORIGIN: origin};
  assert.doesNotThrow(() => validateInputs(env));
  for (const value of ['', 'http://www.memonogi.com', 'https://other.com', 'https://user@www.memonogi.com', `${origin}:443`, `${origin}/`, `${origin}?x=1`, `${origin}#x`]) assert.throws(() => validateInputs({...env, PUBLIC_ORIGIN: value}));
});
