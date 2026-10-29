'use strict';

const fs = require('node:fs');
const read = (path) => fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd();
const indent = (source, count) => source.split('\n').map((line) => `${' '.repeat(count)}${line}`).join('\n');
const inputs = ['service-profile', 'image-name', 'dockerfile', 'compose-file', 'compose-service', 'container-name', 'remote-dir', 'health-url', 'health-timeout', 'platform'];
const deployInputs = ['compose-file', 'compose-service', 'container-name', 'remote-dir', 'health-url', 'health-timeout', 'image-ref'];
const secrets = ['DOCKERHUB_NAMESPACE', 'DOCKERHUB_PUSH_TOKEN', 'PROD_HOST', 'PROD_USER', 'PROD_SSH_PORT', 'PROD_SSH_PRIVATE_KEY', 'PROD_KNOWN_HOSTS', 'PROD_ENV_FILE'];
const deploySecrets = ['PROD_HOST', 'PROD_USER', 'PROD_SSH_PORT', 'PROD_SSH_PRIVATE_KEY', 'PROD_KNOWN_HOSTS', 'PROD_ENV_FILE'];
const inputDefinitions = (names) => names.map((name) => `      ${name}:\n        required: true\n        type: string`).join('\n');
const secretDefinitions = (names) => names.map((name) => `      ${name}:\n        required: true`).join('\n');
const inputEnvironment = (names) => names.map((name) => `          ${name.toUpperCase().replaceAll('-', '_')}: \${{ inputs.${name} }}`).join('\n');
const secretEnvironment = (names) => names.map((name) => `          ${name}: \${{ secrets.${name} }}`).join('\n');
const release = read('scripts/release.cjs');
const remote = read('scripts/deploy-remote.sh');
const local = read('scripts/deploy-local.sh');
const nodeRun = (mode) => `node - ${mode} <<'RELEASE_SCRIPT'\n${release}\nRELEASE_SCRIPT`;

const deployJob = (integrated) => `  deploy:
${integrated ? '    needs: publish\n' : ''}    runs-on: ubuntu-latest
    environment: production
    timeout-minutes: 30
    concurrency:
      group: production-\${{ github.repository }}-\${{ inputs.compose-service }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - name: Deploy and verify or roll back
        env:
${inputEnvironment(deployInputs.filter((name) => name !== 'image-ref'))}
          IMAGE_REF: ${integrated ? "${{ format('{0}/{1}@{2}', secrets.DOCKERHUB_NAMESPACE, inputs.image-name, needs.publish.outputs.digest) }}" : '${{ inputs.image-ref }}'}
${secretEnvironment(deploySecrets)}
        run: |
          REMOTE_SCRIPT="$RUNNER_TEMP/deploy-remote.sh"
          export REMOTE_SCRIPT
          cat > "$REMOTE_SCRIPT" <<'REMOTE_SCRIPT_EOF'
${indent(remote, 10)}
          REMOTE_SCRIPT_EOF
          bash <<'DEPLOY_SCRIPT_EOF'
${indent(local, 10)}
          DEPLOY_SCRIPT_EOF
`;

const ci = read('.github/workflows/spring-ci.yml');
const ciJobs = ci.slice(ci.indexOf('\njobs:\n') + 7);
const production = `name: Spring production
on:
  workflow_call:
    inputs:
${inputDefinitions(inputs)}
    secrets:
${secretDefinitions(secrets)}
    outputs:
      version:
        value: \${{ jobs.publish.outputs.version }}
      digest:
        value: \${{ jobs.publish.outputs.digest }}
permissions:
  contents: read
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - name: Validate production request
        env:
${inputEnvironment(inputs)}
        run: |
${indent(nodeRun('validate-inputs'), 10)}
  release-version:
    needs: preflight
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.version.outputs.version }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: actions/setup-java@cf277c60eb25467037889841efdb72551f06f6c3
        with:
          distribution: temurin
          java-version: '21'
          cache: gradle
      - run: chmod +x gradlew
      - name: Resolve release version
        id: version
        run: |
${indent(nodeRun('resolve-version'), 10)}
${ciJobs}
  publish:
    needs: [preflight, release-version, validate, auth-mysql, verify, community-redis, secret-scan, container]
    if: \${{ always() && needs.preflight.result == 'success' && needs.release-version.result == 'success' && needs.validate.result == 'success' && needs.secret-scan.result == 'success' && needs.container.result == 'success' && ((inputs.service-profile == 'auth-mysql' && needs.auth-mysql.result == 'success') || (inputs.service-profile == 'community-redis' && needs.community-redis.result == 'success') || ((inputs.service-profile == 'base' || inputs.service-profile == 'batch') && needs.verify.result == 'success')) }}
    runs-on: ubuntu-latest
    environment: production
    timeout-minutes: 45
    concurrency:
      group: publish-\${{ github.repository }}-\${{ inputs.image-name }}-\${{ needs.release-version.outputs.version }}
      cancel-in-progress: false
    outputs:
      version: \${{ steps.publish.outputs.version }}
      digest: \${{ steps.publish.outputs.digest }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - name: Publish immutable image
        id: publish
        env:
${inputEnvironment(inputs)}
          RELEASE_VERSION: \${{ needs.release-version.outputs.version }}
${secretEnvironment(secrets)}
        run: |
${indent(nodeRun('publish'), 10)}
${deployJob(true)}`;

const deployment = `name: Deploy immutable Compose service
on:
  workflow_call:
    inputs:
${inputDefinitions(deployInputs)}
    secrets:
${secretDefinitions(deploySecrets)}
permissions:
  contents: read
jobs:
${deployJob(false)}`;

const files = {
  '.github/workflows/spring-prod.yml': production,
  '.github/workflows/compose-deploy.yml': deployment,
};
let invalid = false;
for (const [path, data] of Object.entries(files)) {
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(path) || read(path) !== data.trimEnd()) {
      console.error(`${path} is not generated from scripts`);
      invalid = true;
    }
  } else {
    fs.writeFileSync(path, data);
  }
}
if (invalid) process.exitCode = 1;
