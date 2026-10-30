#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ $GITHUB_REF == refs/heads/main && ( $GITHUB_EVENT_NAME == push || $GITHUB_EVENT_NAME == workflow_dispatch ) ]] || exit 1
[[ $DEPLOYMENT_TARGET == prod2 ]] || exit 1
case "$GITHUB_REPOSITORY" in
  devnogi/devnogi-gateway-server|devnogi/open-api-batch-server|devnogi/devnogi-community-server|devnogi/devnogi-auth-server|devnogi/devnogi-react) ;;
  *) echo 'Invalid deployment caller'; exit 1 ;;
esac
[[ $GITHUB_RUN_ID =~ ^[0-9]+$ && $GITHUB_RUN_ATTEMPT =~ ^[0-9]+$ && $IMAGE_REF =~ ^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || exit 1
[[ $COMPOSE_SERVICE =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && $CONTAINER_NAME =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 1
[[ $REMOTE_DIR =~ ^/([a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+$ && $PROD2_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && $PROD2_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 1
[[ $HEALTH_URL =~ ^http://127\.0\.0\.1:[1-9][0-9]{0,4}/[a-zA-Z0-9/_-]*$ && $HEALTH_TIMEOUT =~ ^[1-9][0-9]{0,2}$ && $HEALTH_TIMEOUT -le 600 ]] || exit 1
health_port=${HEALTH_URL#http://127.0.0.1:}
health_port=${health_port%%/*}
[[ $health_port -le 65535 ]] || exit 1
[[ $PROD2_SSH_PORT == 46232 ]] || exit 1
[[ $COMPOSE_FILE =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.ya?ml$ && $COMPOSE_FILE != *..* && -f $COMPOSE_FILE ]] || exit 1
[[ $PROD_COMPOSE_FILE =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ya?ml$ ]] || exit 1
[[ -n $PROD2_SSH_PRIVATE_KEY && -n $PROD2_ENV_FILE && $PROD2_HOST_FINGERPRINT =~ ^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$ ]] || exit 1
if grep -Eq '^\s*(export\s+)?IMAGE_REF\s*=' <<< "$PROD2_ENV_FILE"; then echo 'Invalid environment'; exit 1; fi

work=$(mktemp -d "$RUNNER_TEMP/deploy.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
if ! ssh-keyscan -T 15 -p "$PROD2_SSH_PORT" -t ed25519 "$PROD2_HOST" >"$work/known_hosts" 2>"$work/scan.log" ||
   ! awk 'NF != 3 || $2 != "ssh-ed25519" { bad=1 } END { exit (bad || NR != 1) }' "$work/known_hosts"; then
  echo 'Host key scan failed'; exit 1
fi
fingerprint=$(ssh-keygen -E sha256 -lf "$work/known_hosts" 2>"$work/scan.log") || { echo 'Host key validation failed'; exit 1; }
[[ $fingerprint == "256 $PROD2_HOST_FINGERPRINT "*' (ED25519)' ]] || { echo 'Host key validation failed'; exit 1; }
printf '%s\n' "$PROD2_SSH_PRIVATE_KEY" > "$work/key"
printf '%s\n' "$PROD2_ENV_FILE" > "$work/env"
chmod 600 "$work/key" "$work/known_hosts" "$work/env"
opts=(-i "$work/key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$work/known_hosts" -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519 -o ConnectTimeout=15)
run="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
stage="$REMOTE_DIR/.candidate-$run"
legacy_compose=$PROD_COMPOSE_FILE

report_remote_result() {
  local status=$1 log=$2
  if [[ $status -eq 0 ]] && grep -qx 'DEPLOY_RESULT=SUCCESS' "$log"; then
    echo 'Deployment health verified'
    return 0
  fi
  if grep -qx 'DEPLOY_RESULT=ROLLBACK_FAILED' "$log"; then
    echo 'Deployment failed and rollback verification failed'
    return 2
  fi
  if grep -qx 'DEPLOY_RESULT=ROLLED_BACK' "$log"; then
    echo 'Deployment failed; previous service image and health were restored'
    return 1
  fi
  echo 'Deployment failed before a verified recovery result was received'
  return 1
}

if ! ssh -p "$PROD2_SSH_PORT" "${opts[@]}" "$PROD2_USER@$PROD2_HOST" "mkdir '$stage'" >"$work/ssh.log" 2>&1; then
  echo 'Could not create deployment candidate'
  exit 1
fi
if ! scp -P "$PROD2_SSH_PORT" "${opts[@]}" "$COMPOSE_FILE" "$PROD2_USER@$PROD2_HOST:$stage/compose.yml" >"$work/ssh.log" 2>&1 ||
   ! scp -P "$PROD2_SSH_PORT" "${opts[@]}" "$work/env" "$PROD2_USER@$PROD2_HOST:$stage/.env.prod" >"$work/ssh.log" 2>&1; then
  ssh -p "$PROD2_SSH_PORT" "${opts[@]}" "$PROD2_USER@$PROD2_HOST" "rm -rf '$stage'" >"$work/ssh.log" 2>&1 || true
  echo 'Could not stage deployment candidate'
  exit 1
fi
set +e
ssh -p "$PROD2_SSH_PORT" "${opts[@]}" "$PROD2_USER@$PROD2_HOST" bash -s -- \
  "$REMOTE_DIR" "$COMPOSE_SERVICE" "$CONTAINER_NAME" "$IMAGE_REF" "$HEALTH_URL" "$HEALTH_TIMEOUT" "$run" "$stage" "$legacy_compose" \
  < "$REMOTE_SCRIPT" >"$work/ssh.log" 2>&1
remote_status=$?
set -e
report_remote_result "$remote_status" "$work/ssh.log" || exit $?
