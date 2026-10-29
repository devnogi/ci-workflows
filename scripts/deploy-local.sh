#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ $GITHUB_REF == refs/heads/main && ( $GITHUB_EVENT_NAME == push || $GITHUB_EVENT_NAME == workflow_dispatch ) ]] || exit 1
[[ $GITHUB_RUN_ID =~ ^[0-9]+$ && $GITHUB_RUN_ATTEMPT =~ ^[0-9]+$ && $IMAGE_REF =~ ^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || exit 1
[[ $COMPOSE_SERVICE =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && $CONTAINER_NAME =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 1
[[ $REMOTE_DIR =~ ^/([a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+$ && $PROD_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && $PROD_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 1
[[ $HEALTH_URL =~ ^http://127\.0\.0\.1:[1-9][0-9]{0,4}/[a-zA-Z0-9/_-]*$ && $HEALTH_TIMEOUT =~ ^[1-9][0-9]{0,2}$ && $HEALTH_TIMEOUT -le 600 ]] || exit 1
[[ $PROD_SSH_PORT =~ ^[1-9][0-9]{0,4}$ && $PROD_SSH_PORT -le 65535 ]] || exit 1
[[ $COMPOSE_FILE =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.ya?ml$ && $COMPOSE_FILE != *..* && -f $COMPOSE_FILE ]] || exit 1
[[ -n $PROD_SSH_PRIVATE_KEY && -n $PROD_KNOWN_HOSTS && -n $PROD_ENV_FILE ]] || exit 1
if grep -Eq '^\s*(export\s+)?IMAGE_REF\s*=' <<< "$PROD_ENV_FILE"; then echo 'Invalid environment'; exit 1; fi

work=$(mktemp -d "$RUNNER_TEMP/deploy.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$PROD_SSH_PRIVATE_KEY" > "$work/key"
printf '%s\n' "$PROD_KNOWN_HOSTS" > "$work/known_hosts"
printf '%s\n' "$PROD_ENV_FILE" > "$work/env"
chmod 600 "$work/key" "$work/known_hosts" "$work/env"
opts=(-i "$work/key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$work/known_hosts" -o ConnectTimeout=15)
run="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
stage="$REMOTE_DIR/.candidate-$run"
legacy_compose=${COMPOSE_FILE##*/}

if ! ssh -p "$PROD_SSH_PORT" "${opts[@]}" "$PROD_USER@$PROD_HOST" "mkdir '$stage'" >"$work/ssh.log" 2>&1; then
  echo 'Could not create deployment candidate'
  exit 1
fi
if ! scp -P "$PROD_SSH_PORT" "${opts[@]}" "$COMPOSE_FILE" "$PROD_USER@$PROD_HOST:$stage/compose.yml" >"$work/ssh.log" 2>&1 ||
   ! scp -P "$PROD_SSH_PORT" "${opts[@]}" "$work/env" "$PROD_USER@$PROD_HOST:$stage/.env.prod" >"$work/ssh.log" 2>&1; then
  ssh -p "$PROD_SSH_PORT" "${opts[@]}" "$PROD_USER@$PROD_HOST" "rm -rf '$stage'" >"$work/ssh.log" 2>&1 || true
  echo 'Could not stage deployment candidate'
  exit 1
fi
if ! ssh -p "$PROD_SSH_PORT" "${opts[@]}" "$PROD_USER@$PROD_HOST" bash -s -- \
  "$REMOTE_DIR" "$COMPOSE_SERVICE" "$CONTAINER_NAME" "$IMAGE_REF" "$HEALTH_URL" "$HEALTH_TIMEOUT" "$run" "$stage" "$legacy_compose" \
  < "$REMOTE_SCRIPT" >"$work/ssh.log" 2>&1; then
  echo 'Deployment or rollback verification failed'
  exit 1
fi
echo 'Deployment health verified'
