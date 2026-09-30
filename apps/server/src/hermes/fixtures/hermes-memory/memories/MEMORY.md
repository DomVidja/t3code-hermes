Datacenter-IP blocked → route via atlas Tailscale exit node (192.0.2.10); revert after.
§
Hermes cron: monitoring no-ops must respond `[SILENT]`; web-search docs before claiming a feature doesn't exist.
§
Atlas LAN 198.51.100.2/24 gw 198.51.100.1; Tailscale 192.0.2.10 + exit node; DNS on OPNsense. Atlas "files" share = /tank/files (NFS 198.51.100.2:/tank exported to LAN+tailnet, no creds; SMB requires auth).
§
Orion VM: alex@192.0.2.20; Valheim ~/valheim-server; Jellyfin :8096; Immich :2283 (uploads NFS→atlas:/tank/Photos/Immich).
§
must use Atlas LAN IP 198.51.100.2, not Tailscale; Tailscale NFS caused hung NFS fsync.
§
For Proxmox LXCs, user prefers bare systemd installs and wants Docker-in-LXC avoided due past reliability problems.
§
Torrent cross-seed: inject into qBittorrent first, then /api/webhook with infoHash (URL-only rejected). Sniping → torrent-release-sniping skill.
§
Beacon WebUI: ~/hermes-webui (hermes-webui service), Tailscale-only 192.0.2.30:8787.
§
Hermes browser now uses Cloudflare Kitesurf CDP (wss://browser.example.test/devtools/browser).
§
MacBook Air M1: Tailscale demo-laptop (192.0.2.40), SSH alias macbook-air (alex). VS Code Remote + one 2560×1440 stream. Keep powered; FileVault/TCC need local unlock. GH runner for example-dev/agent-workspace: ~/actions-runner-t3code LaunchAgent, label t3code-mac-arm64.
§
Homebridge CT125 198.51.100.96 (DNS via 198.51.100.1). Bedroom lights = 2 outlets "Room Lights"; GraphQL writes falsely succeed — toggle :8765 v5 (Alexa.TextCommand via Echo Spot, persistent state).
§
CLIProxyAPI = LXC 122 (198.51.100.7:8317) on atlas (repo router-for-me/CLIProxyAPI). Hermes subagents (delegation) + upstream-sync profile run gpt-6-astra via custom provider cliproxyapi (API key in Hermes secrets store); keep delegation.base_url empty — provider-only resolution (base_url set → parent's key inherited → 401).
§
Hindsight: LLM=opencode-go/deepseek-v4-flash; config in ~/.hindsight.env.
§
Beacon VCN = 198.51.100.0/24 shadows atlas's Tailscale subnet route to home LAN; reach LAN hosts via /32 route dev tailscale0 (systemd route-cliproxyapi-tailscale.service pins 198.51.100.7).
