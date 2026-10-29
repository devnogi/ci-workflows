#!/usr/bin/env bash
set -Eeuo pipefail

case "$PROFILE" in
  base|auth-mysql|community-redis|batch) ;;
  *) echo 'Invalid service profile'; exit 1 ;;
esac
[[ $COMPOSE_FILE =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.ya?ml$ && $COMPOSE_FILE != *..* ]] || { echo 'Invalid Compose path'; exit 1; }
[[ $DOCKERFILE =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]*$ && $DOCKERFILE != *..* ]] || { echo 'Invalid Dockerfile path'; exit 1; }
[[ $IMAGE_NAME =~ ^[a-z0-9]+([._-][a-z0-9]+)*$ ]] || { echo 'Invalid image name'; exit 1; }
[[ -f $COMPOSE_FILE ]] || { echo 'Compose file does not exist'; exit 1; }
[[ -f $DOCKERFILE ]] || { echo 'Dockerfile does not exist'; exit 1; }
