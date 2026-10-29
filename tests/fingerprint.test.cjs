'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const bash = process.platform === 'win32' ? 'C:/Users/user/AppData/Local/Programs/Git/bin/bash.exe' : 'bash';
const posix = (value) => value.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/');
const fingerprint = `SHA256:${'A'.repeat(43)}`;

test('fingerprint validation precedes authentication and cleans up without exposing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fingerprint-test-'));
  const bin = path.join(dir, 'bin');
  const runner = path.join(dir, 'runner');
  fs.mkdirSync(bin); fs.mkdirSync(runner);
  const executable = (name, source) => { const file = path.join(bin, name); fs.writeFileSync(file, source); fs.chmodSync(file, 0o755); };
  executable('ssh-keyscan', '#!/usr/bin/env bash\nprintf "%b" "$SCAN"\necho sensitive-scan-error >&2\n');
  executable('ssh-keygen', '#!/usr/bin/env bash\nprintf "256 %s test (ED25519)\\n" "$SCANNED_FINGERPRINT"\n');
  executable('ssh', '#!/usr/bin/env bash\necho invoked > "$AUTH_MARKER"\nexit 1\n');
  fs.writeFileSync(path.join(dir, 'compose.yml'), 'services: {}\n');
  const common = {
    ...process.env, FAKE_BIN: posix(bin), RUNNER_TEMP: posix(runner),
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'devnogi/devnogi-gateway-server', DEPLOYMENT_TARGET: 'prod2',
    GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', IMAGE_REF: `example/app@sha256:${'b'.repeat(64)}`,
    COMPOSE_SERVICE: 'app', CONTAINER_NAME: 'app', REMOTE_DIR: '/srv/app', HEALTH_URL: 'http://127.0.0.1:8080/health', HEALTH_TIMEOUT: '60',
    COMPOSE_FILE: 'compose.yml', PROD_COMPOSE_FILE: 'prod.yml', PROD2_HOST: 'example.invalid', PROD2_USER: 'deployer',
    PROD2_SSH_PORT: '46232', PROD2_SSH_PRIVATE_KEY: 'sensitive-private-key', PROD2_ENV_FILE: 'SECRET=sensitive-env',
    PROD2_HOST_FINGERPRINT: fingerprint, SCANNED_FINGERPRINT: fingerprint, AUTH_MARKER: posix(path.join(dir, 'auth')),
    SCAN: '[example.invalid]:46232 ssh-ed25519 synthetic-key\\n',
  };
  const script = path.resolve('scripts/deploy-local.sh');
  const run = (patch = {}) => {
    fs.rmSync(path.join(dir, 'auth'), {force: true});
    const result = spawnSync(bash, ['-c', 'export PATH="$FAKE_BIN:$PATH"; source "$1"', '--', posix(script)], {cwd: dir, env: {...common, ...patch}, encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /sensitive-|synthetic-key|SHA256:/);
    assert.deepEqual(fs.readdirSync(runner), []);
    return {authenticated: fs.existsSync(path.join(dir, 'auth')), output: result.stdout + result.stderr};
  };
  try {
    const valid = run();
    assert.equal(valid.authenticated, true, valid.output);
    for (const patch of [
      {SCAN: ''}, {SCAN: common.SCAN + common.SCAN}, {SCAN: 'host ssh-rsa synthetic-key\\n'},
      {SCAN: 'host ssh-ed25519 synthetic-key extra\\n'}, {SCANNED_FINGERPRINT: `SHA256:${'B'.repeat(42)}A`},
      {PROD2_HOST_FINGERPRINT: 'malformed'}, {PROD2_SSH_PORT: '22'}, {DEPLOYMENT_TARGET: 'prod1'}, {GITHUB_REPOSITORY: 'devnogi/unapproved'}, {HEALTH_URL: 'http://127.0.0.1:65536/health'},
    ]) assert.equal(run(patch).authenticated, false, JSON.stringify(patch));
    for (const repository of ['devnogi/open-api-batch-server', 'devnogi/devnogi-community-server', 'devnogi/devnogi-auth-server', 'devnogi/devnogi-react']) {
      assert.equal(run({GITHUB_REPOSITORY: repository}).authenticated, true, repository);
    }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
