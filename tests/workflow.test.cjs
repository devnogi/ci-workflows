'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const ci = fs.readFileSync('.github/workflows/spring-ci.yml', 'utf8');
const production = fs.readFileSync('.github/workflows/spring-prod.yml', 'utf8');
const deployment = fs.readFileSync('.github/workflows/compose-deploy.yml', 'utf8');

test('all approved profiles and mandatory integration tests are present', () => {
  for (const item of ['base|auth-mysql|community-redis|batch', 'mysql:8.0.42', 'redis:7.4.9', 'redisIntegrationTest', 'RefreshTokenMigrationMySqlTest', 'MainHistoryCompatibilityMySqlTest', 'NicknameMigrationMySqlTest', 'NicknameConcurrencyMySqlTest', 'UserVerificationConcurrencyMySqlTest', 'OAuthExchangeMySqlTest', 'SocialSignupProofMySqlTest', 'RefreshTokenRotationMySqlTest', 'RefreshTokenLengthMySqlTest', 'ConcurrentLoginMySqlTest', 'UserVerificationFailureHistoryMySqlTest', 'LoginLockoutMySqlTest']) assert.ok(ci.includes(item), item);
});

test('external actions are pinned and PR builds never push', () => {
  for (const workflow of [ci, production, deployment]) for (const match of workflow.matchAll(/uses:\s*([^\s]+)/g)) assert.match(match[1], /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  assert.match(ci, /docker build --file/);
  assert.doesNotMatch(ci, /docker push|buildx build --push/);
  assert.doesNotMatch(ci, /image:\s*\$\{\{/);
});

test('publish is serialized by caller, image, and resolved version', () => {
  assert.match(production, /release-version:\n[\s\S]*?gradle\('\.\/gradlew', \['properties', '-q'\]/);
  assert.match(production, /group: publish-\$\{\{ github\.repository \}\}-\$\{\{ inputs\.image-name \}\}-\$\{\{ needs\.release-version\.outputs\.version \}\}/);
  assert.match(production, /cancel-in-progress: false/);
  assert.match(production, /needs: \[preflight, release-version, validate, auth-mysql, verify, community-redis, secret-scan, container\]/);
});

test('preflight has no production environment or secret references', () => {
  const preflight = production.slice(production.indexOf('  preflight:'), production.indexOf('  release-version:'));
  assert.doesNotMatch(preflight, /environment: production|\$\{\{ secrets\./);
  assert.match(preflight, /validate-inputs/);
});

test('production uses Buildx metadata, immutable-tag checks, and same-run digest deployment', () => {
  assert.match(production, /'buildx', 'build', '--push'/);
  assert.match(production, /org\.opencontainers\.image\.revision/);
  assert.match(production, /containerimage\.digest/);
  assert.match(production, /immutable_tags_settings/);
  assert.match(production, /needs\.publish\.outputs\.digest/);
  assert.doesNotMatch(production, /uses: \.\//);
});

test('publish receives every required deployment secret before registry access', () => {
  const publish = production.slice(production.indexOf('  publish:'), production.indexOf('  deploy:'));
  for (const name of ['DOCKERHUB_NAMESPACE', 'DOCKERHUB_PUSH_TOKEN', 'PROD_HOST', 'PROD_USER', 'PROD_SSH_PORT', 'PROD_SSH_PRIVATE_KEY', 'PROD_KNOWN_HOSTS', 'PROD_ENV_FILE']) {
    assert.match(publish, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`));
  }
  assert.match(publish, /validateDeploymentSecrets\(env\)/);
});

test('deployment has strict known hosts and legacy recovery state', () => {
  assert.match(deployment, /environment: production/);
  assert.match(deployment, /StrictHostKeyChecking=yes/);
  assert.match(deployment, /legacy_compose/);
  assert.match(deployment, /previous_image_id/);
  assert.doesNotMatch(deployment, /ssh-keyscan/);
});

test('validation checks out the caller and main PRs reject an existing production version', () => {
  const validate = ci.match(/  validate:[\s\S]*?\n  version-policy:/)?.[0] || '';
  assert.match(validate, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(ci, /github\.event_name == 'pull_request' && github\.base_ref == 'main'/);
  assert.match(ci, /vars\.DOCKERHUB_NAMESPACE/);
  assert.match(ci, /prod-v\$\{version\} already exists/);
  assert.match(ci, /increment the Gradle version/);
});

function extractValidationSnippet() {
  const marker = '      - name: Validate inputs\n';
  const start = ci.indexOf(marker);
  const run = ci.indexOf('        run: |\n', start) + '        run: |\n'.length;
  const end = ci.indexOf('\n  version-policy:', run);
  return ci.slice(run, end).split('\n').map((line) => line.slice(10)).join('\n');
}

test('actual CI validation shell fails closed for bad values and missing files', () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), 'ci-validation-'));
  const bash = process.platform === 'win32' ? 'C:/Users/user/AppData/Local/Programs/Git/bin/bash.exe' : 'bash';
  try {
    fs.writeFileSync(path.join(directory, 'Dockerfile'), 'FROM scratch\n');
    fs.writeFileSync(path.join(directory, 'compose.yml'), 'services: {}\n');
    const run = (overrides = {}) => spawnSync(bash, ['-c', extractValidationSnippet()], {
      cwd: directory, encoding: 'utf8',
      env: {...process.env, PROFILE: 'base', COMPOSE_FILE: 'compose.yml', DOCKERFILE: 'Dockerfile', IMAGE_NAME: 'service', ...overrides},
    });
    assert.equal(run().status, 0);
    for (const invalid of [{PROFILE: 'other'}, {COMPOSE_FILE: '../compose.yml'}, {DOCKERFILE: 'missing'}, {IMAGE_NAME: 'Bad/Image'}]) assert.notEqual(run(invalid).status, 0);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
