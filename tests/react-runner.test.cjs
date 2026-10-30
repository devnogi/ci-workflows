'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const bash = process.platform === 'win32' ? 'C:/Users/user/AppData/Local/Programs/Git/bin/bash.exe' : 'bash';
const posix = (value) => value.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replaceAll('\\', '/');
const fingerprint = `SHA256:${'A'.repeat(43)}`;
test('runner finalizes only after probe success and reports failed recovery distinctly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-runner-'));
  const bin = path.join(dir, 'bin'); const runner = path.join(dir, 'runner');
  fs.mkdirSync(bin); fs.mkdirSync(runner);
  const executable = (name, source) => { const file = path.join(bin, name); fs.writeFileSync(file, source); fs.chmodSync(file, 0o755); };
  executable('ssh-keyscan', '#!/usr/bin/env bash\nprintf "host ssh-ed25519 key\\n"\n');
  executable('ssh-keygen', `#!/usr/bin/env bash\nprintf '256 ${fingerprint} test (ED25519)\\n'\n`);
  executable('scp', '#!/usr/bin/env bash\nexit 0\n');
  executable('docker', '#!/usr/bin/env bash\nprintf "{}"\n');
  executable('node', '#!/usr/bin/env bash\nif [[ $1 == -e ]]; then cat >/dev/null; exit 0; fi\necho probe >> "$FAKE_LOG"\nexit "$PROBE_STATUS"\n');
  executable('ssh', `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    activate) echo activate >> "$FAKE_LOG"; echo DEPLOY_RESULT=ACTIVATED; exit 0;;
    finalize) echo finalize >> "$FAKE_LOG"; if [[ $FINALIZE_STATUS == 0 ]]; then echo DEPLOY_RESULT=SUCCESS; exit 0; else exit 1; fi;;
    rollback) echo rollback >> "$FAKE_LOG"; if [[ $ROLLBACK_STATUS == 0 ]]; then echo DEPLOY_RESULT=ROLLED_BACK; exit 0; else echo DEPLOY_RESULT=ROLLBACK_FAILED; exit 2; fi;;
  esac
done
exit 0
`);
  fs.writeFileSync(path.join(dir, 'compose.yml'), 'services: {}\n');
  const script = posix(path.resolve('scripts/deploy-local.sh'));
  const common = {...process.env, FAKE_BIN: posix(bin), FAKE_LOG: posix(path.join(dir, 'actions')), RUNNER_TEMP: posix(runner), GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'devnogi/devnogi-react', DEPLOYMENT_TARGET: 'prod2', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', IMAGE_REF: `example/app@sha256:${'b'.repeat(64)}`, COMPOSE_SERVICE: 'app', CONTAINER_NAME: 'app', REMOTE_DIR: '/srv/app', HEALTH_URL: 'http://127.0.0.1:8080/health', HEALTH_TIMEOUT: '60', COMPOSE_FILE: 'compose.yml', PROD_COMPOSE_FILE: 'prod.yml', PROD2_HOST: 'example.invalid', PROD2_USER: 'deployer', PROD2_SSH_PORT: '46232', PROD2_SSH_PRIVATE_KEY: 'test', PROD2_ENV_FILE: 'SETTING=value', PROD2_HOST_FINGERPRINT: fingerprint, REACT_PUBLIC_MODE: '1', PUBLIC_ORIGIN: 'https://www.memonogi.com', ARTIFACT_REVISION: 'a'.repeat(40), REMOTE_SCRIPT: script, PUBLIC_SCRIPT: 'mock', PROBE_STATUS: '0', FINALIZE_STATUS: '0', ROLLBACK_STATUS: '0'};
  const run = (patch) => {
    fs.writeFileSync(path.join(dir, 'actions'), '');
    const result = spawnSync(bash, ['-c', 'export PATH="$FAKE_BIN:$PATH"; source "$1"', '--', script], {cwd: dir, env: {...common, ...patch}, encoding: 'utf8'});
    return {result, actions: fs.readFileSync(path.join(dir, 'actions'), 'utf8').trim().split('\n')};
  };
  try {
    let value = run({}); assert.equal(value.result.status, 0, value.result.stdout + value.result.stderr); assert.deepEqual(value.actions, ['activate', 'probe', 'finalize']);
    value = run({PROBE_STATUS: '1'}); assert.equal(value.result.status, 1); assert.deepEqual(value.actions, ['activate', 'probe', 'rollback']);
    value = run({FINALIZE_STATUS: '1'}); assert.equal(value.result.status, 1); assert.deepEqual(value.actions, ['activate', 'probe', 'finalize', 'rollback']);
    value = run({PROBE_STATUS: '1', ROLLBACK_STATUS: '2'}); assert.equal(value.result.status, 2); assert.match(value.result.stdout, /rollback verification failed/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
