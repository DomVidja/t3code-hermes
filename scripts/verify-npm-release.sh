#!/usr/bin/env bash
set -euo pipefail

release_version="${1:?release version is required}"
release_dist_tag="${2:?npm dist-tag is required}"
export npm_config_registry=https://registry.npmjs.org

# npm makes a publish visible asynchronously. The small launcher shows up
# within a minute or two, but the ~60 MB platform packages routinely take
# several minutes, even though they are published first.
wait_attempts=90
wait_seconds=10

published_version=""
for attempt in $(seq 1 "$wait_attempts"); do
  published_version="$(npm view "t3-hermes@${release_dist_tag}" version 2>/dev/null || true)"
  if [[ "$published_version" == "$release_version" ]]; then
    break
  fi
  sleep "$wait_seconds"
done
if [[ "$published_version" != "$release_version" ]]; then
  echo "::error::t3-hermes@${release_dist_tag} resolves to '${published_version}', expected '${release_version}'." >&2
  exit 1
fi

# The platform package is an optional dependency, so npm silently skips it
# while it is not visible yet and the launcher then reports the platform as
# unsupported. Wait for this runner's package before installing.
platform_package="t3-hermes-$(node -p 'process.platform + "-" + process.arch')"
platform_version=""
for attempt in $(seq 1 "$wait_attempts"); do
  platform_version="$(npm view "${platform_package}@${release_version}" version 2>/dev/null || true)"
  if [[ "$platform_version" == "$release_version" ]]; then
    break
  fi
  echo "Waiting for ${platform_package}@${release_version} (attempt ${attempt}/${wait_attempts})." >&2
  sleep "$wait_seconds"
done
if [[ "$platform_version" != "$release_version" ]]; then
  echo "::error::${platform_package}@${release_version} is not visible on npm." >&2
  exit 1
fi

# Avoid the checkout's binaries, npm cache, and user state masking a broken package.
smoke_dir="$(mktemp -d)"
trap 'rm -rf "$smoke_dir"' EXIT
cd "$smoke_dir"
# npm view and npm exec use different registry metadata representations. The
# tag can be visible before the abbreviated install metadata has caught up.
for attempt in {1..12}; do
  if actual_version="$(npm_config_cache="$smoke_dir/cache" npm_config_prefer_online=true T3HERMES_HOME="$smoke_dir/state" \
    npm exec --yes --package="t3-hermes@${release_version}" -- t3-hermes --version 2>"$smoke_dir/npm-error.log")"; then
    break
  else
    install_status=$?
  fi
  cat "$smoke_dir/npm-error.log" >&2
  if ! grep -Eq '^npm (error|ERR!) code (ETARGET|E404)$' "$smoke_dir/npm-error.log" || [[ "$attempt" == 12 ]]; then
    exit "$install_status"
  fi
  echo "Waiting for t3-hermes@${release_version} install metadata (attempt ${attempt}/12)." >&2
  sleep 5
done
if [[ "$actual_version" != "t3-hermes v${release_version}" ]]; then
  echo "::error::Published CLI reported '${actual_version}', expected '${release_version}'." >&2
  exit 1
fi
echo "Verified t3-hermes@${release_version} on npm tag ${release_dist_tag}."
