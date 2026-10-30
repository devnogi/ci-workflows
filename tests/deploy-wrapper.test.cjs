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

function deployWrapper(workflow) {
  const yaml = fs.readFileSync(workflow, 'utf8').replace(/\r\n/g, '\n');
  const step = yaml.indexOf('      - name: Deploy and verify or roll back\n');
  assert.notEqual(step, -1, `${workflow}: deploy step missing`);
  const start = yaml.indexOf('        run: |\n', step);
  assert.notEqual(start, -1, `${workflow}: deploy run block missing`);
  const tail = yaml.slice(start + '        run: |\n'.length);
  const lines = tail.split('\n');
  const end = lines.findIndex((line) => line && !line.startsWith('          '));
  return lines.slice(0, end < 0 ? undefined : end).map((line) => line.replace(/^ {10}/, '')).join('\n') + '\n';
}

test('generated deploy wrappers survive stdin-consuming SSH and propagate failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-wrapper-'));
  const bin = path.join(dir, 'bin');
  const runner = path.join(dir, 'runner');
  fs.mkdirSync(bin); fs.mkdirSync(runner);
  const executable = (name, source) => { const file = path.join(bin, name); fs.writeFileSync(file, source); fs.chmodSync(file, 0o755); };
  executable('ssh-keyscan', '#!/usr/bin/env bash\nprintf "host ssh-ed25519 key\\n"\n');
  executable('ssh-keygen', `#!/usr/bin/env bash\nprintf '256 ${fingerprint} test (ED25519)\\n'\n`);
  executable('scp', '#!/usr/bin/env bash\necho scp >> "$FAKE_LOG"\nexit "${SCP_STATUS:-0}"\n');
  executable('docker', '#!/usr/bin/env bash\nprintf "{}"\n');
  executable('node', '#!/usr/bin/env bash\nif [[ $1 == -e ]]; then cat >/dev/null; exit 0; fi\necho probe >> "$FAKE_LOG"\nexit "${PROBE_STATUS:-0}"\n');
  executable('ssh', `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    mkdir*) echo mkdir >> "$FAKE_LOG"; cat >/dev/null; exit 0;;
    'rm -rf'*) echo cleanup >> "$FAKE_LOG"; cat >/dev/null; exit 0;;
    activate) echo activate >> "$FAKE_LOG"; payload=$(cat); [[ $payload == *DEPLOY_RESULT* ]] || exit 9; echo DEPLOY_RESULT=ACTIVATED; exit 0;;
    finalize) echo finalize >> "$FAKE_LOG"; payload=$(cat); [[ $payload == *DEPLOY_RESULT* ]] || exit 9; echo DEPLOY_RESULT=SUCCESS; exit 0;;
    rollback) echo rollback >> "$FAKE_LOG"; payload=$(cat); [[ $payload == *DEPLOY_RESULT* ]] || exit 9; echo DEPLOY_RESULT=ROLLED_BACK; exit 0;;
  esac
done
echo deploy >> "$FAKE_LOG"; payload=$(cat); [[ $payload == *DEPLOY_RESULT* ]] || exit 9; echo DEPLOY_RESULT=SUCCESS; exit "\${DEPLOY_STATUS:-0}"
`);
  fs.writeFileSync(path.join(dir, 'compose.yml'), 'services: {}\n');
  const common = {...process.env, FAKE_BIN: posix(bin), FAKE_LOG: posix(path.join(dir, 'actions')), RUNNER_TEMP: posix(runner), GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'devnogi/devnogi-react', DEPLOYMENT_TARGET: 'prod2', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', IMAGE_REF: `example/app@sha256:${'b'.repeat(64)}`, COMPOSE_SERVICE: 'app', CONTAINER_NAME: 'app', REMOTE_DIR: '/srv/app', HEALTH_URL: 'http://127.0.0.1:8080/health', HEALTH_TIMEOUT: '60', COMPOSE_FILE: 'compose.yml', PROD_COMPOSE_FILE: 'prod.yml', PROD2_HOST: 'example.invalid', PROD2_USER: 'deployer', PROD2_SSH_PORT: '46232', PROD2_SSH_PRIVATE_KEY: 'test', PROD2_ENV_FILE: 'SETTING=value', PROD2_HOST_FINGERPRINT: fingerprint, REACT_PUBLIC_MODE: '1', PUBLIC_ORIGIN: 'https://www.memonogi.com', ARTIFACT_REVISION: 'a'.repeat(40)};
  const run = (workflow, patch = {}, transform = (wrapper) => wrapper) => {
    fs.writeFileSync(path.join(dir, 'actions'), '');
    const input = `export PATH="$FAKE_BIN:$PATH"\n${transform(deployWrapper(workflow))}`;
    const result = spawnSync(bash, [], {cwd: dir, env: {...common, ...patch}, input, encoding: 'utf8'});
    return {result, actions: fs.readFileSync(path.join(dir, 'actions'), 'utf8').trim().split('\n').filter(Boolean)};
  };
  try {
    const nodeWorkflow = '.github/workflows/node-prod.yml';
    const oldWrapper = (wrapper) => wrapper.replace('DEPLOY_SCRIPT="$RUNNER_TEMP/deploy-local.sh"\ncat > "$DEPLOY_SCRIPT" <<\'DEPLOY_SCRIPT_EOF\'', "bash <<'DEPLOY_SCRIPT_EOF'").replace('DEPLOY_SCRIPT_EOF\nbash "$DEPLOY_SCRIPT" </dev/null', 'DEPLOY_SCRIPT_EOF');
    let value = run(nodeWorkflow, {}, oldWrapper);
    assert.equal(value.result.status, 0, value.result.stdout + value.result.stderr);
    assert.deepEqual(value.actions, ['mkdir'], 'old stdin-fed wrapper falsely succeeds after mkdir');
    value = run(nodeWorkflow);
    assert.equal(value.result.status, 0, value.result.stdout + value.result.stderr);
    assert.deepEqual(value.actions, ['mkdir', 'scp', 'scp', 'scp', 'activate', 'probe', 'finalize']);
    assert.match(value.result.stdout, /Public deployment verified and finalized/);
    value = run(nodeWorkflow, {PROBE_STATUS: '1'});
    assert.equal(value.result.status, 1, value.result.stdout + value.result.stderr);
    assert.deepEqual(value.actions, ['mkdir', 'scp', 'scp', 'scp', 'activate', 'probe', 'rollback']);
    value = run(nodeWorkflow, {SCP_STATUS: '1'});
    assert.equal(value.result.status, 1, value.result.stdout + value.result.stderr);
    assert.deepEqual(value.actions, ['mkdir', 'scp', 'cleanup']);
    for (const workflow of ['.github/workflows/spring-prod.yml', '.github/workflows/compose-deploy.yml']) {
      value = run(workflow, {REACT_PUBLIC_MODE: '0'});
      assert.equal(value.result.status, 0, `${workflow}: ${value.result.stdout}${value.result.stderr}`);
      assert.deepEqual(value.actions, ['mkdir', 'scp', 'scp', 'deploy']);
      value = run(workflow, {REACT_PUBLIC_MODE: '0', DEPLOY_STATUS: '1'});
      assert.notEqual(value.result.status, 0, workflow);
    }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
