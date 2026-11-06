'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {probe} = require('../scripts/public-probe.cjs');
const {validateInputs} = require('../scripts/release.cjs');

const revision = 'a'.repeat(40);
const origin = 'https://www.memonogi.com';
const bodies = {
  '/api/health': JSON.stringify({service: 'devnogi-react', revision}),
  '/': '<section class="hero" aria-label="아이템 검색"></section><details><summary class="toggle">주요 기능 보기<svg></svg></summary></details>',
  '/auction-history': '<h1>마비노기 경매장 거래내역·아이템 시세 검색</h1>',
  '/sitemap.xml': `<urlset>${['/', '/auction-history', '/community'].map((x) => `<loc>${origin}${x}</loc>`).join('')}</urlset>`,
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
test('auction verification accepts the compact heading and the previous SEO heading', async () => {
  for (const heading of ['경매장 거래내역', '마비노기 경매장 거래내역·아이템 시세 검색']) {
    await probe(fixture({'/auction-history': {body: `<header><h1 class="text-xl">\n ${heading}\n</h1></header>`}}));
  }
});
test('auction verification still rejects missing, unrelated, and error headings', async () => {
  for (const body of [
    '<div>경매장 거래내역</div>',
    '<h2>경매장 거래내역</h2>',
    '<h1>경매장 현재 매물</h1>',
    '<h1>경매장 거래내역 오류</h1>',
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
