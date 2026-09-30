#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 <server-port> <base-dir> <mobile-origin> <agent-device-command> <target-args...>" >&2
  exit 2
}

[[ $# -ge 5 ]] || usage

server_port="$1"
base_dir="$2"
mobile_origin="$3"
agent_device_command="$4"
shift 4

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

platform=ios
for arg in "$@"; do
  if [[ "$arg" == "android" || "$arg" == "--serial" ]]; then platform=android; fi
done

# Read the development variant's scheme and app ID from app.config.ts, as the native client build does.
if ! app_identity="$({
  cd apps/mobile
  APP_VARIANT=development T3CODE_IOS_PERSONAL_TEAM=0 vp exec expo config --type public --json
} | PLATFORM="$platform" node -e '
let input = "";
process.stdin.on("data", (chunk) => (input += chunk)).on("end", () => {
  const config = JSON.parse(input);
  const scheme = [config.scheme].flat()[0];
  const appId = process.env.PLATFORM === "android" ? config.android.package : config.ios.bundleIdentifier;
  process.stdout.write(`${scheme} ${appId}`);
});
')"; then
  echo "Could not read the mobile app scheme and ID from apps/mobile/app.config.ts." >&2
  exit 1
fi
read -r app_scheme app_id <<<"$app_identity"

if ! pairing_output="$({
  T3CODE_PORT="$server_port" node apps/server/src/bin.ts auth pairing create \
    --base-dir "$base_dir" \
    --base-url "$mobile_origin" \
    --ttl 15m \
    --label "agent-mobile"
} 2>&1)"; then
  echo "Could not mint a mobile pairing credential." >&2
  exit 1
fi

pairing_url="$(printf '%s\n' "$pairing_output" | sed -n 's/^Pair URL: //p' | tail -n 1)"
if [[ -z "$pairing_url" ]]; then
  echo "Could not parse the mobile pairing URL." >&2
  exit 1
fi

deep_link="$(PAIRING_URL="$pairing_url" APP_SCHEME="$app_scheme" node - <<'NODE'
const query = new URLSearchParams({
  pairingUrl: process.env.PAIRING_URL,
  autoConnect: "1",
});
process.stdout.write(`${process.env.APP_SCHEME}://connections/new?${query}`);
NODE
)"

if ! "$agent_device_command" open "$app_id" "$deep_link" "$@" \
  >/dev/null 2>&1; then
  echo "AgentDevice could not open the pairing route. Check the Device panel and retry with a fresh credential." >&2
  exit 1
fi

echo "Opened $app_id's existing Add Environment route with a fresh pairing credential."
