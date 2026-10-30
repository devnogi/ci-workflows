'use strict';

const fs = require('node:fs');
const read = (path) => fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd();
const indent = (source, count) => source.split('\n').map((line) => line ? `${' '.repeat(count)}${line}` : '').join('\n');
const springInputs = ['service-profile', 'service-name', 'deployment-target', 'dockerfile', 'compose-file', 'health-timeout', 'platform'];
const nodeInputs = ['service-name', 'deployment-target', 'dockerfile', 'compose-file', 'health-timeout', 'platform', 'public-origin'];
const deployInputs = ['deployment-target', 'compose-file', 'health-timeout', 'image-ref'];
const secrets = ['DOCKERHUB_PUSH_TOKEN', 'PROD2_HOST', 'PROD2_USER', 'PROD2_SSH_PORT', 'PROD2_SSH_PRIVATE_KEY', 'PROD2_HOST_FINGERPRINT', 'PROD2_ENV_FILE'];
const deploySecrets = secrets.slice(1);
const workflowCallSecrets = secrets.filter((name) => name !== 'PROD2_ENV_FILE');
const deployCallSecrets = deploySecrets.filter((name) => name !== 'PROD2_ENV_FILE');
const deploymentVariables = {
  COMPOSE_SERVICE: 'PROD2_COMPOSE_SERVICE',
  CONTAINER_NAME: 'PROD2_CONTAINER_NAME',
  REMOTE_DIR: 'PROD2_REMOTE_DIR',
  HEALTH_URL: 'PROD2_HEALTH_URL',
  PROD_COMPOSE_FILE: 'PROD2_COMPOSE_FILE',
};
const inputDefinitions = (names) => names.map((name) => `      ${name}:\n        required: true\n        type: string`).join('\n');
const secretDefinitions = (names) => names.map((name) => `      ${name}:\n        required: true`).join('\n');
const inputEnvironment = (names) => names.map((name) => `          ${name.toUpperCase().replaceAll('-', '_')}: \${{ inputs.${name} }}`).join('\n');
const secretEnvironment = (names) => names.map((name) => `          ${name}: \${{ secrets.${name} }}`).join('\n');
const variableEnvironment = () => Object.entries(deploymentVariables).map(([name, variable]) => `          ${name}: \${{ vars.${variable} }}`).join('\n');
const release = read('scripts/release.cjs');
const remote = read('scripts/deploy-remote.sh');
const local = read('scripts/deploy-local.sh');
const reactRemote = read('scripts/deploy-react-remote.sh');
const publicProbe = read('scripts/public-probe.cjs');
const nodeRun = (mode) => `node - ${mode} <<'RELEASE_SCRIPT'\n${release}\nRELEASE_SCRIPT`;
const fixedProfile = (kind) => kind === 'node' ? '          SERVICE_PROFILE: react\n' : '';

const deployJob = (integrated, kind) => `  deploy:
${integrated ? "    needs: publish\n    if: ${{ !cancelled() && needs.publish.result == 'success' }}\n" : ''}    runs-on: ubuntu-latest
    environment: production
    timeout-minutes: 30
    concurrency:
      group: production-\${{ github.repository }}-${integrated ? '${{ inputs.service-name }}' : 'compose-deploy'}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - name: Deploy and verify or roll back
        env:
${inputEnvironment(deployInputs.filter((name) => name !== 'image-ref'))}
${variableEnvironment()}
          IMAGE_REF: ${integrated ? "${{ format('{0}@{1}', vars.DOCKERHUB_REPOSITORY, needs.publish.outputs.digest) }}" : '${{ inputs.image-ref }}'}
${kind === 'node' ? "          REACT_PUBLIC_MODE: '1'\n          PUBLIC_ORIGIN: ${{ inputs.public-origin }}\n          ARTIFACT_REVISION: ${{ needs.publish.outputs.commit }}\n" : ''}
${secretEnvironment(deploySecrets)}
        run: |
          REMOTE_SCRIPT="$RUNNER_TEMP/deploy-remote.sh"
          export REMOTE_SCRIPT
          cat > "$REMOTE_SCRIPT" <<'REMOTE_SCRIPT_EOF'
${indent(kind === 'node' ? reactRemote : remote, 10)}
          REMOTE_SCRIPT_EOF
${kind === 'node' ? `          PUBLIC_SCRIPT="$RUNNER_TEMP/public-probe.cjs"
          export PUBLIC_SCRIPT
          cat > "$PUBLIC_SCRIPT" <<'PUBLIC_SCRIPT_EOF'
${indent(publicProbe, 10)}
          PUBLIC_SCRIPT_EOF
` : ''}
          bash <<'DEPLOY_SCRIPT_EOF'
${indent(local, 10)}
          DEPLOY_SCRIPT_EOF
`;

const releaseJob = (inputs, kind) => `  release:
    needs: [publish, deploy]
    if: \${{ !cancelled() && needs.publish.result == 'success' && needs.deploy.result == 'success' }}
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: write
    steps:
      - name: Create or verify GitHub Release
        env:
${inputEnvironment(inputs)}
${fixedProfile(kind)}          RELEASE_VERSION: \${{ needs.publish.outputs.version }}
          RELEASE_COMMIT: \${{ needs.publish.outputs.commit }}
          IMAGE_DIGEST: \${{ needs.publish.outputs.digest }}
          DOCKERHUB_REPOSITORY: \${{ vars.DOCKERHUB_REPOSITORY }}
          GITHUB_TOKEN: \${{ github.token }}
        run: |
${indent(nodeRun('github-release'), 10)}
`;

const workflow = ({name, kind, inputs, ciPath, resolveSteps, ciNeeds, publishIf}) => {
  const ci = read(ciPath);
  const ciJobs = ci.slice(ci.indexOf('\njobs:\n') + 7);
  return `name: ${name}
on:
  workflow_call:
    inputs:
${inputDefinitions(inputs)}
    secrets:
${secretDefinitions(workflowCallSecrets)}
    outputs:
      version:
        value: \${{ jobs.publish.outputs.version }}
      digest:
        value: \${{ jobs.publish.outputs.digest }}
      tag:
        value: \${{ jobs.publish.outputs.tag }}
      commit:
        value: \${{ jobs.publish.outputs.commit }}
permissions:
  contents: read
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - name: Validate production request
        env:
${inputEnvironment(inputs)}
${fixedProfile(kind)}        run: |
${indent(nodeRun('validate-inputs'), 10)}
  release-version:
    needs: preflight
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.version.outputs.version }}
    steps:
${resolveSteps}
${ciJobs}
  publish:
    needs: [preflight, release-version, ${ciNeeds.join(', ')}]
    if: \${{ ${publishIf} }}
    runs-on: ubuntu-latest
    environment: production
    timeout-minutes: 45
    concurrency:
      group: publish-\${{ github.repository }}-\${{ inputs.service-name }}-\${{ needs.release-version.outputs.version }}
      cancel-in-progress: false
    outputs:
      version: \${{ steps.publish.outputs.version }}
      digest: \${{ steps.publish.outputs.digest }}
      tag: \${{ steps.publish.outputs.tag }}
      commit: \${{ steps.publish.outputs.commit }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          fetch-depth: 0
      - name: Publish immutable image
        id: publish
        env:
${inputEnvironment(inputs)}
${fixedProfile(kind)}          RELEASE_VERSION: \${{ needs.release-version.outputs.version }}
          DOCKERHUB_USERNAME: \${{ vars.DOCKERHUB_USERNAME }}
          DOCKERHUB_REPOSITORY: \${{ vars.DOCKERHUB_REPOSITORY }}
${variableEnvironment()}
${secretEnvironment(secrets)}
        run: |
${indent(nodeRun('publish'), 10)}
${deployJob(true, kind)}${releaseJob(inputs, kind)}`;
};

const spring = workflow({
  name: 'Spring production',
  kind: 'spring',
  inputs: springInputs,
  ciPath: '.github/workflows/spring-ci.yml',
  resolveSteps: `      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: actions/setup-java@cf277c60eb25467037889841efdb72551f06f6c3
        with:
          distribution: temurin
          java-version: '21'
          cache: gradle
      - run: chmod +x gradlew
      - name: Resolve release version
        id: version
        run: |
${indent(nodeRun('resolve-gradle-version'), 10)}`,
  ciNeeds: ['validate', 'auth-mysql', 'verify', 'community-redis', 'secret-scan', 'container'],
  publishIf: "always() && needs.preflight.result == 'success' && needs.release-version.result == 'success' && needs.validate.result == 'success' && needs.secret-scan.result == 'success' && needs.container.result == 'success' && ((inputs.service-profile == 'auth-mysql' && needs.auth-mysql.result == 'success') || (inputs.service-profile == 'community-redis' && needs.community-redis.result == 'success') || ((inputs.service-profile == 'base' || inputs.service-profile == 'batch') && needs.verify.result == 'success'))",
});

const node = workflow({
  name: 'Node production',
  kind: 'node',
  inputs: nodeInputs,
  ciPath: '.github/workflows/node-ci.yml',
  resolveSteps: `      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: '20'
          cache: npm
      - name: Resolve release version
        id: version
        run: |
${indent(nodeRun('resolve-npm-version'), 10)}`,
  ciNeeds: ['validate', 'verify', 'container'],
  publishIf: "always() && needs.preflight.result == 'success' && needs.release-version.result == 'success' && needs.validate.result == 'success' && needs.verify.result == 'success' && needs.container.result == 'success'",
});

const deployment = `name: Deploy immutable Compose service
on:
  workflow_call:
    inputs:
${inputDefinitions(deployInputs)}
    secrets:
${secretDefinitions(deployCallSecrets)}
permissions:
  contents: read
jobs:
${deployJob(false)}`;

const files = {
  '.github/workflows/spring-prod.yml': spring,
  '.github/workflows/node-prod.yml': node,
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
