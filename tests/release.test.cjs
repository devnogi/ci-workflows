'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const release = require('../scripts/release.cjs');

const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const env = {
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sha,
  GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'devnogi/service',
  SERVICE_PROFILE: 'base', COMPOSE_FILE: 'compose.yml', DOCKERFILE: 'Dockerfile', IMAGE_NAME: 'service',
  COMPOSE_SERVICE: 'app', CONTAINER_NAME: 'app-prod', REMOTE_DIR: '/srv/app',
  HEALTH_URL: 'http://127.0.0.1:8080/actuator/health', HEALTH_TIMEOUT: '60', PLATFORM: 'linux/amd64',
  PROD_COMPOSE_FILE: 'docker-compose-prod.yml',
  RELEASE_VERSION: '1.2.3', DOCKERHUB_NAMESPACE: 'example', DOCKERHUB_PUSH_TOKEN: 'secret',
  PROD_HOST: 'server.example', PROD_USER: 'deployer', PROD_SSH_PORT: '22',
  PROD_SSH_PRIVATE_KEY: 'private-key', PROD_KNOWN_HOSTS: 'known-host', PROD_ENV_FILE: 'SETTING=value',
};

test('public production inputs validate without accessing production secrets', () => {
  assert.doesNotThrow(() => release.validateInputs(env));
  assert.doesNotThrow(() => release.validateInputs({...env, GITHUB_EVENT_NAME: 'workflow_dispatch'}));
  for (const patch of [
    {GITHUB_EVENT_NAME: 'pull_request'}, {GITHUB_REF: 'refs/heads/dev'}, {GITHUB_SHA: 'abc'},
    {SERVICE_PROFILE: 'other'}, {COMPOSE_FILE: '../x.yml'}, {DOCKERFILE: '../Dockerfile'},
    {HEALTH_TIMEOUT: '601'}, {PLATFORM: 'linux/arm64'},
  ]) assert.throws(() => release.validateInputs({...env, ...patch}));
  assert.doesNotThrow(() => release.validateInputs({...env, DOCKERHUB_PUSH_TOKEN: '', PROD_SSH_PRIVATE_KEY: ''}));
  assert.throws(() => release.validatePublishSecrets({...env, DOCKERHUB_PUSH_TOKEN: ''}));
  assert.doesNotThrow(() => release.validateDeploymentSettings(env));
  for (const patch of [{COMPOSE_SERVICE: 'a;id'}, {CONTAINER_NAME: 'bad name'}, {REMOTE_DIR: '/srv/../x'}, {HEALTH_URL: 'http://external:8080/x'}, {PROD_COMPOSE_FILE: '../bad.yml'}]) {
    assert.throws(() => release.validateDeploymentSettings({...env, ...patch}));
  }
  assert.doesNotThrow(() => release.validateDeploymentSecrets(env));
  for (const patch of [{PROD_HOST: 'bad;host'}, {PROD_USER: 'Bad User'}, {PROD_SSH_PORT: '65536'}, {PROD_SSH_PRIVATE_KEY: ''}, {PROD_KNOWN_HOSTS: ''}, {PROD_ENV_FILE: 'IMAGE_REF=bad'}]) {
    assert.throws(() => release.validateDeploymentSecrets({...env, ...patch}));
  }
});

test('Gradle properties is the only release version source', () => {
  let call;
  let output = '';
  const result = release.resolveVersion({GITHUB_OUTPUT: 'output'}, {
    execFileSync(file, args) { call = [file, ...args]; return 'name: service\nversion: 2.4.6-SNAPSHOT\n'; },
    fs: {appendFileSync(_path, value) { output += value; }},
  });
  assert.equal(result, '2.4.6');
  assert.deepEqual(call, ['./gradlew', 'properties', '-q']);
  assert.equal(output, 'version=2.4.6\n');
  assert.throws(() => release.resolveVersion({GITHUB_OUTPUT: 'output'}, {
    execFileSync() { return 'version: invalid\n'; }, fs: {appendFileSync() {}},
  }));
});

test('version, collision, and immutable-tag requirements fail closed', () => {
  assert.equal(release.version('1.2.3-SNAPSHOT'), '1.2.3');
  for (const value of ['01.2.3', '1.2', '1.2.3-rc1', 'v1.2.3']) assert.throws(() => release.version(value));
  assert.equal(release.collision(null, null), 'build');
  assert.equal(release.collision(digest, digest), 'reuse');
  for (const args of [[digest, null], [null, digest], [digest, `sha256:${'c'.repeat(64)}`], ['bad', 'bad']]) assert.throws(() => release.collision(...args));
  const tags = ['prod-v1.2.3', `sha-${sha}`];
  const exactRules = ['^prod-v[0-9]+\\.[0-9]+\\.[0-9]+$', '^sha-[0-9a-f]{40}$'];
  assert.doesNotThrow(() => release.immutableTagsRequired({is_private: false, immutable_tags_settings: {enabled: true, rules: exactRules}}, tags));
  assert.doesNotThrow(() => release.immutableTagsRequired({is_private: false, immutable_tags_settings: {enabled: true, rules: ['^.*$']}}, tags));
  assert.doesNotThrow(() => release.immutableTagsRequired({is_private: false, immutable_tags_settings: {enabled: true, rules: []}}, tags));
  assert.throws(() => release.immutableTagsRequired({is_private: false, immutable_tags_settings: {enabled: true, rules: ['^prod-v[09]', '^sha-[0f]']}}, tags));
  assert.throws(() => release.immutableTagsRequired({is_private: false, immutable_tags_settings: {enabled: true, rules: ['^prod-v.*$', '^sh\\a-.*$']}}, tags));
  for (const info of [
    {is_private: true, immutable_tags_settings: {enabled: true, rules: []}},
    {is_private: false, immutable_tags_settings: {enabled: false, rules: ['prod-v.*', 'sha-.*']}},
    {is_private: false, immutable_tags_settings: {enabled: true, rules: ['prod-v.*']}},
  ]) assert.throws(() => release.immutableTagsRequired(info, tags));
});

test('publication uses one Buildx push, OCI labels, metadata digest, and registry verification', async () => {
  let calls = [];
  let outputs = '';
  let published = false;
  const dependencies = {
    fs: {appendFileSync(_path, value) { outputs += value; }, readFileSync() { return JSON.stringify({'containerimage.digest': digest}); }},
    spawnSync() { return {status: 0}; },
    cmd(_name, args) { calls.push(args); published = true; },
    fetch: async (url) => {
      if (url.endsWith('/auth/token')) return {ok: true, json: async () => ({access_token: 'token'})};
      if (!url.includes('/tags/')) return {ok: true, json: async () => ({is_private: false, immutable_tags_settings: {enabled: true, rules: ['^prod-v[0-9]+\\.[0-9]+\\.[0-9]+$', '^sha-[0-9a-f]{40}$']}})};
      return published ? {ok: true, json: async () => ({digest})} : {ok: false, status: 404};
    },
  };
  await release.publish({...env, RUNNER_TEMP: 'temp', GITHUB_OUTPUT: 'output', GITHUB_STEP_SUMMARY: 'summary'}, dependencies);
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.deepEqual(args.slice(0, 3), ['buildx', 'build', '--push']);
  assert.ok(args.includes('--metadata-file'));
  assert.ok(args.includes(`org.opencontainers.image.revision=${sha}`));
  assert.ok(args.includes('org.opencontainers.image.source=https://github.com/devnogi/service'));
  assert.ok(args.includes('org.opencontainers.image.version=1.2.3'));
  assert.ok(args.includes('example/service:prod-v1.2.3'));
  assert.ok(args.includes(`example/service:sha-${sha}`));
  assert.match(outputs, new RegExp(`digest=${digest}`));
  calls = [];
  published = true;
  await release.publish({...env, RUNNER_TEMP: 'temp', GITHUB_OUTPUT: 'output', GITHUB_STEP_SUMMARY: 'summary'}, dependencies);
  assert.deepEqual(calls, []);
});

test('registry digest mismatch rejects the published result', async () => {
  let published = false;
  const dependencies = {
    fs: {appendFileSync() {}, readFileSync() { return JSON.stringify({'containerimage.digest': digest}); }},
    spawnSync() { return {status: 0}; }, cmd() { published = true; },
    fetch: async (url) => {
      if (url.endsWith('/auth/token')) return {ok: true, json: async () => ({access_token: 'token'})};
      if (!url.includes('/tags/')) return {ok: true, json: async () => ({is_private: false, immutable_tags_settings: {enabled: true, rules: []}})};
      return published ? {ok: true, json: async () => ({digest: `sha256:${'c'.repeat(64)}`})} : {ok: false, status: 404};
    },
  };
  await assert.rejects(release.publish({...env, RUNNER_TEMP: 'temp', GITHUB_OUTPUT: 'output', GITHUB_STEP_SUMMARY: 'summary'}, dependencies), /does not match/);
});

test('invalid deployment secrets stop publication before registry access', async () => {
  let requested = false;
  await assert.rejects(
    release.publish({...env, PROD_SSH_PRIVATE_KEY: '', RUNNER_TEMP: 'temp', GITHUB_OUTPUT: 'output', GITHUB_STEP_SUMMARY: 'summary'}, {
      fetch: async () => { requested = true; throw Error('must not be called'); },
    }),
    /Missing PROD_SSH_PRIVATE_KEY/,
  );
  assert.equal(requested, false);
});

function bashPath(value) {
  return value.replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/');
}

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents);
  fs.chmodSync(file, 0o755);
}

function runLegacyTransition(failRollback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-transition-'));
  const bin = path.join(directory, 'bin');
  const stage = path.join(directory, '.candidate-42-1');
  fs.mkdirSync(bin);
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(directory, 'docker-compose-prod.yml'), 'services:\n  app:\n    image: legacy/service:prod\n');
  fs.writeFileSync(path.join(directory, '.env.prod'), 'LEGACY=value\n');
  fs.writeFileSync(path.join(stage, 'compose.yml'), 'services:\n  app:\n    image: ${IMAGE_REF:?IMAGE_REF is required}\n');
  fs.writeFileSync(path.join(stage, '.env.prod'), 'NEW=value\n');
  fs.writeFileSync(path.join(directory, 'state'), `sha256:${'1'.repeat(64)}\n`);
  writeExecutable(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(path.join(bin, 'curl'), `#!/usr/bin/env bash\necho "curl $(cat "$FAKE_STATE")" >> "$FAKE_LOG"\nif [[ $(cat "$FAKE_STATE") == "sha256:${'1'.repeat(64)}" ]]; then printf '200'; else printf '302'; fi\n`);
  writeExecutable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -eu
echo "$*" >> "$FAKE_LOG"
old="sha256:${'1'.repeat(64)}"
new="sha256:${'2'.repeat(64)}"
if [[ $1 == inspect ]]; then
  if [[ $3 == *'.Image'* ]]; then echo "image=$(cat "$FAKE_STATE")" >> "$FAKE_LOG"; cat "$FAKE_STATE"; else echo 'status=true healthy' >> "$FAKE_LOG"; echo 'true healthy'; fi
elif [[ $1 == image && $2 == inspect ]]; then
  echo "$new"
elif [[ $1 == compose ]]; then
  joined="$*"
  if [[ $joined == *'config --images'* ]]; then echo "$IMAGE_REF"
  elif [[ $joined == *' up '* ]]; then
    if [[ $joined == *'rollback.override.yml'* ]]; then
      if [[ \${FAIL_ROLLBACK:-0} == 1 ]]; then exit 1; fi
      echo 'set old' >> "$FAKE_LOG"
      echo "$old" > "$FAKE_STATE"
    else echo 'set new' >> "$FAKE_LOG"; echo "$new" > "$FAKE_STATE"
    fi
  fi
fi
`);
  const bash = process.platform === 'win32' ? 'C:/Users/user/AppData/Local/Programs/Git/bin/bash.exe' : 'bash';
  const result = spawnSync(bash, ['scripts/deploy-remote.sh', bashPath(directory), 'app', 'app-prod', `example/service@${digest}`, 'http://127.0.0.1:8080/health', '1', '42-1', bashPath(stage), 'docker-compose-prod.yml'], {
    cwd: process.cwd(), encoding: 'utf8',
    env: {...process.env, PATH: `${bashPath(bin)}:${process.env.PATH}`, FAKE_STATE: bashPath(path.join(directory, 'state')), FAKE_LOG: bashPath(path.join(directory, 'commands.log')), FAIL_ROLLBACK: failRollback ? '1' : '0', DEPLOY_CURL_BIN: bashPath(path.join(bin, 'curl')), DEPLOY_SLEEP_BIN: bashPath(path.join(bin, 'sleep'))},
  });
  return {directory, result};
}

test('legacy first deployment restores original Compose, env, image ID, and health', () => {
  const {directory, result} = runLegacyTransition(false);
  try {
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}\n${fs.readFileSync(path.join(directory, 'commands.log'), 'utf8')}`);
    assert.match(`${result.stdout}${result.stderr}`, /Previous service image and health recovered/);
    assert.equal(fs.existsSync(path.join(directory, 'compose.yml')), false);
    assert.match(fs.readFileSync(path.join(directory, 'docker-compose-prod.yml'), 'utf8'), /legacy\/service:prod/);
    assert.equal(fs.readFileSync(path.join(directory, '.env.prod'), 'utf8'), 'LEGACY=value\n');
    assert.equal(fs.readFileSync(path.join(directory, 'state'), 'utf8').trim(), `sha256:${'1'.repeat(64)}`);
    assert.equal(fs.existsSync(path.join(directory, '.deploy-marker')), false);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('rollback failure is surfaced with a distinct failure status', () => {
  const {directory, result} = runLegacyTransition(true);
  try {
    assert.equal(result.status, 2, result.stderr);
    assert.match(`${result.stdout}${result.stderr}`, /Rollback failed/);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('local SSH boundary reports success, recovered rollback, and rollback failure distinctly', () => {
  const source = fs.readFileSync('scripts/deploy-local.sh', 'utf8');
  const match = source.match(/report_remote_result\(\) \{[\s\S]*?\n\}/);
  assert.ok(match);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-result-'));
  const bash = process.platform === 'win32' ? 'C:/Users/user/AppData/Local/Programs/Git/bin/bash.exe' : 'bash';
  try {
    const run = (status, marker) => {
      const log = path.join(directory, 'ssh.log');
      fs.writeFileSync(log, `${marker}\n`);
      return spawnSync(bash, ['-c', `${match[0]}; report_remote_result "$1" "$2"`, '--', String(status), bashPath(log)], {encoding: 'utf8'});
    };
    const success = run(0, 'DEPLOY_RESULT=SUCCESS');
    assert.equal(success.status, 0);
    assert.match(success.stdout, /Deployment health verified/);
    const recovered = run(1, 'DEPLOY_RESULT=ROLLED_BACK');
    assert.equal(recovered.status, 1);
    assert.match(recovered.stdout, /were restored/);
    const failed = run(2, 'DEPLOY_RESULT=ROLLBACK_FAILED');
    assert.equal(failed.status, 2);
    assert.match(failed.stdout, /rollback verification failed/);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('embedded public validation executes without production secrets', () => {
  const input = fs.readFileSync('scripts/release.cjs', 'utf8');
  const run = (event) => spawnSync(process.execPath, ['-', 'validate-inputs'], {input, env: {...process.env, ...env, GITHUB_EVENT_NAME: event, DOCKERHUB_PUSH_TOKEN: ''}, encoding: 'utf8'});
  assert.equal(run('push').status, 0);
  assert.notEqual(run('pull_request').status, 0);
});
