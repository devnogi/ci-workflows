'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const workflow = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const ci = workflow('.github/workflows/spring-ci.yml');
const production = workflow('.github/workflows/spring-prod.yml');
const nodeCi = workflow('.github/workflows/node-ci.yml');
const nodeProduction = workflow('.github/workflows/node-prod.yml');
const deployment = workflow('.github/workflows/compose-deploy.yml');

test('all approved profiles and mandatory integration tests are present', () => {
  for (const item of ['gateway:base|auth:auth-mysql|community:community-redis|batch:batch', 'mysql:8.0.42', 'redis:7.4.9', 'redisIntegrationTest', 'RefreshTokenMigrationMySqlTest', 'MainHistoryCompatibilityMySqlTest', 'NicknameMigrationMySqlTest', 'NicknameConcurrencyMySqlTest', 'UserVerificationConcurrencyMySqlTest', 'OAuthExchangeMySqlTest', 'SocialSignupProofMySqlTest', 'RefreshTokenRotationMySqlTest', 'RefreshTokenLengthMySqlTest', 'ConcurrentLoginMySqlTest', 'UserVerificationFailureHistoryMySqlTest', 'LoginLockoutMySqlTest']) assert.ok(ci.includes(item), item);
});

test('external actions are pinned and PR builds never push', () => {
  for (const workflow of [ci, production, nodeCi, nodeProduction, deployment]) for (const match of workflow.matchAll(/uses:\s*([^\s]+)/g)) assert.match(match[1], /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  for (const workflow of [ci, nodeCi]) {
    assert.match(workflow, /docker build --file/);
    assert.doesNotMatch(workflow, /docker push|buildx build --push/);
    assert.doesNotMatch(workflow, /image:\s*\$\{\{/);
  }
});

test('publish is serialized by caller, service, and resolved version', () => {
  assert.match(production, /release-version:\n[\s\S]*?gradle\('\.\/gradlew', \['properties', '-q'\]/);
  assert.match(nodeProduction, /release-version:\n[\s\S]*?resolveNpmVersion/);
  for (const workflow of [production, nodeProduction]) assert.match(workflow, /group: publish-\$\{\{ github\.repository \}\}-\$\{\{ inputs\.service-name \}\}-\$\{\{ needs\.release-version\.outputs\.version \}\}/);
  assert.match(production, /cancel-in-progress: false/);
  assert.match(production, /needs: \[preflight, release-version, validate, auth-mysql, verify, community-redis, secret-scan, container\]/);
});

test('production workflows declare and enforce the fixed prod2 target', () => {
  for (const workflow of [production, nodeProduction, deployment]) {
    assert.match(workflow, /deployment-target:\n\s+required: true\n\s+type: string/);
    assert.match(workflow, /DEPLOYMENT_TARGET: \$\{\{ inputs\.deployment-target \}\}/);
  }
  for (const workflow of [production, nodeProduction]) assert.match(workflow, /Invalid deployment target/);
  assert.match(deployment, /\[\[ \$DEPLOYMENT_TARGET == prod2 \]\]/);
});

test('preflight has no production environment or secret references', () => {
  const preflight = production.slice(production.indexOf('  preflight:'), production.indexOf('  release-version:'));
  assert.doesNotMatch(preflight, /environment: production|\$\{\{ secrets\./);
  assert.match(preflight, /validate-inputs/);
});

test('production uses Buildx metadata, immutable-tag checks, and same-run digest deployment', () => {
  for (const workflow of [production, nodeProduction]) {
    assert.match(workflow, /'buildx', 'build', '--push'/);
    assert.match(workflow, /org\.opencontainers\.image\.revision/);
    assert.match(workflow, /containerimage\.digest/);
    assert.match(workflow, /immutable_tags_settings/);
    assert.match(workflow, /format\('\{0\}@\{1\}', vars\.DOCKERHUB_REPOSITORY, needs\.publish\.outputs\.digest\)/);
    assert.doesNotMatch(workflow, /uses: \.\//);
  }
});

test('publish receives every required deployment secret before registry access', () => {
  const publish = production.slice(production.indexOf('  publish:'), production.indexOf('  deploy:'));
  assert.match(publish, /DOCKERHUB_USERNAME: \$\{\{ vars\.DOCKERHUB_USERNAME \}\}/);
  assert.match(publish, /DOCKERHUB_REPOSITORY: \$\{\{ vars\.DOCKERHUB_REPOSITORY \}\}/);
  for (const name of ['DOCKERHUB_PUSH_TOKEN', 'PROD2_HOST', 'PROD2_USER', 'PROD2_SSH_PORT', 'PROD2_SSH_PRIVATE_KEY', 'PROD2_HOST_FINGERPRINT', 'PROD2_ENV_FILE']) {
    assert.match(publish, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`));
  }
  for (const name of ['PROD2_COMPOSE_SERVICE', 'PROD2_CONTAINER_NAME', 'PROD2_REMOTE_DIR', 'PROD2_HEALTH_URL', 'PROD2_COMPOSE_FILE']) assert.match(publish, new RegExp(`vars\\.${name}`));
  assert.doesNotMatch(production.slice(0, production.indexOf('    secrets:')), /compose-service:|container-name:|remote-dir:|health-url:/);
  assert.match(publish, /validateDeploymentSettings\(env\)/);
  assert.match(publish, /validateDeploymentSecrets\(env\)/);
});

test('production environment file is resolved inside environment jobs, not required at the reusable-call boundary', () => {
  for (const workflow of [production, nodeProduction]) {
    const callInterface = workflow.slice(workflow.indexOf('    secrets:'), workflow.indexOf('    outputs:'));
    assert.doesNotMatch(callInterface, /PROD2_ENV_FILE/);
    const publish = workflow.slice(workflow.indexOf('  publish:'), workflow.indexOf('  deploy:'));
    assert.match(publish, /PROD2_ENV_FILE: \$\{\{ secrets\.PROD2_ENV_FILE \}\}/);
  }
  const deployInterface = deployment.slice(deployment.indexOf('    secrets:'), deployment.indexOf('permissions:'));
  assert.doesNotMatch(deployInterface, /PROD2_ENV_FILE/);
  assert.match(deployment, /environment: production[\s\S]*PROD2_ENV_FILE: \$\{\{ secrets\.PROD2_ENV_FILE \}\}/);
});

test('deployment has strict known hosts and legacy recovery state', () => {
  assert.match(deployment, /environment: production/);
  assert.match(deployment, /StrictHostKeyChecking=yes/);
  assert.match(deployment, /legacy_compose/);
  assert.match(deployment, /previous_image_id/);
  assert.match(deployment, /ssh-keyscan/);
});

test('validation checks out the caller and main PRs reject an existing GitHub release version without registry secrets', () => {
  const validate = ci.match(/  validate:[\s\S]*?\n  version-policy:/)?.[0] || '';
  assert.match(validate, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(ci, /github\.event_name == 'pull_request' && github\.base_ref == 'main'/);
  assert.match(ci, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(ci, /git\/ref\/tags\/\$\{tag\}/);
  assert.match(ci, /releases\/tags\/\$\{tag\}/);
  assert.doesNotMatch(ci, /secrets\.DOCKERHUB_PUSH_TOKEN/);
  assert.match(ci, /throw Error\(`\$\{tag\} already exists/);
  assert.match(ci, /increment the Gradle version/);
});

test('Node workflow is typed for React and runs the repository quality gates', () => {
  assert.match(nodeCi, /SERVICE_NAME: \$\{\{ inputs\.service-name \}\}/);
  assert.match(nodeCi, /\[\[ \$SERVICE_NAME == react \]\]/);
  assert.match(nodeCi, /npm ci/);
  assert.match(nodeCi, /npm run verify/);
  assert.match(nodeCi, /scripts\/secret-scan\.mjs/);
  assert.match(nodeCi, /filter\(x=>!x\[2\]\.startsWith\(":-"\)\)/);
});

test('GitHub Release is created only after successful digest deployment', () => {
  for (const workflow of [production, nodeProduction]) {
    const deployJob = workflow.slice(workflow.indexOf('  deploy:'), workflow.indexOf('  release:'));
    const releaseJob = workflow.slice(workflow.indexOf('  release:'));
    assert.match(deployJob, /needs: publish\n\s+if: \$\{\{ !cancelled\(\) && needs\.publish\.result == 'success' \}\}/);
    assert.match(releaseJob, /needs: \[publish, deploy\]/);
    assert.match(releaseJob, /if: \$\{\{ !cancelled\(\) && needs\.publish\.result == 'success' && needs\.deploy\.result == 'success' \}\}/);
    assert.match(releaseJob, /permissions:\n\s+contents: write/);
    assert.match(releaseJob, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(releaseJob, /node - github-release/);
    assert.match(releaseJob, /IMAGE_DIGEST: \$\{\{ needs\.publish\.outputs\.digest \}\}/);
    assert.match(releaseJob, /RELEASE_COMMIT: \$\{\{ needs\.publish\.outputs\.commit \}\}/);
    const publishJob = workflow.slice(workflow.indexOf('  publish:'), workflow.indexOf('  deploy:'));
    assert.match(publishJob, /fetch-depth: 0/);
  }
  assert.match(production, /Object\.keys\(serviceProfiles\)\.map/);
  for (const service of ['gateway', 'batch', 'community', 'auth', 'react']) assert.match(production, new RegExp(`\\n\\s+${service}:`));
  assert.doesNotMatch(production, /prod-v|sha-\$\{sha\}/);
});

function extractValidationSnippet() {
  const marker = '      - name: Validate inputs\n';
  const start = ci.indexOf(marker);
  const run = ci.indexOf('        run: |\n', start) + '        run: |\n'.length;
  const end = ci.indexOf('\n  version-policy:', run);
  return ci.slice(run, end).split('\n').map((line) => line.slice(10)).join('\n');
}

function extractStepRun(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing step: ${name}`);
  const run = workflow.indexOf('        run: |\n', start) + '        run: |\n'.length;
  const next = workflow.indexOf('\n      - ', run);
  return workflow.slice(run, next < 0 ? undefined : next).split('\n').map((line) => line.slice(10)).join('\n');
}

function bashPath(value) {
  return value.replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/');
}

test('actual CI validation shell fails closed for bad values and missing files', () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), 'ci-validation-'));
  const bash = process.platform === 'win32' ? 'C:/Users/user/AppData/Local/Programs/Git/bin/bash.exe' : 'bash';
  try {
    fs.writeFileSync(path.join(directory, 'Dockerfile'), 'FROM scratch\n');
    fs.writeFileSync(path.join(directory, 'compose.yml'), 'services: {}\n');
    const run = (overrides = {}) => spawnSync(bash, ['-c', extractValidationSnippet()], {
      cwd: directory, encoding: 'utf8',
      env: {...process.env, PROFILE: 'base', COMPOSE_FILE: 'compose.yml', DOCKERFILE: 'Dockerfile', SERVICE_NAME: 'gateway', ...overrides},
    });
    assert.equal(run().status, 0);
    for (const invalid of [{PROFILE: 'other'}, {COMPOSE_FILE: '../compose.yml'}, {DOCKERFILE: 'missing'}, {SERVICE_NAME: 'react'}]) assert.notEqual(run(invalid).status, 0);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('synthetic Compose rendering points DEPLOY_ENV_FILE at the staged fixture', () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), 'compose-render-'));
  const runner = path.join(directory, 'runner');
  const bin = path.join(directory, 'bin');
  const bash = process.platform === 'win32' ? 'C:/Users/user/AppData/Local/Programs/Git/bin/bash.exe' : 'bash';
  fs.mkdirSync(runner);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(directory, 'auth-compose.yml'), 'services:\n  auth:\n    image: ${IMAGE_REF:?IMAGE_REF is required}\n    env_file:\n      - ${DEPLOY_ENV_FILE}\n');
  const docker = path.join(bin, process.platform === 'win32' ? 'docker' : 'docker');
  fs.writeFileSync(docker, `#!/usr/bin/env bash\nset -eu\nenv_file=''\ncompose_file=''\nwhile (( $# )); do\n  case "$1" in\n    --env-file) env_file=$2; shift 2;;\n    -f) compose_file=$2; shift 2;;\n    *) shift;;\n  esac\ndone\nfixture=$(sed -n 's/^DEPLOY_ENV_FILE=//p' "$env_file")\n[[ $fixture == '.env.prod' ]]\n[[ -f "$(dirname "$compose_file")/$fixture" ]]\n`);
  fs.chmodSync(docker, 0o755);
  try {
    const result = spawnSync(bash, ['-c', extractStepRun(ci, 'Render production Compose with synthetic values')], {
      cwd: directory,
      encoding: 'utf8',
      env: {...process.env, COMPOSE_FILE: 'auth-compose.yml', RUNNER_TEMP: bashPath(runner), PATH: `${bashPath(bin)}:${process.env.PATH}`},
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(fs.readFileSync(path.join(runner, 'synthetic.env'), 'utf8'), /^DEPLOY_ENV_FILE=\.env\.prod$/m);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
