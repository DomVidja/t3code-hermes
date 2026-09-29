---
name: news-monitor
description: Set up a periodic cron job that monitors topics via RSS/Google News and notifies the user of new articles with deduplication.
category: research
trigger: When user asks to monitor a topic for news, alerts, or updates on a recurring basis
---

## Steps

1. **Create the monitoring script** at `{get_hermes_home()}/cron/news_monitor_<topic>.py`:
   - Fetch from Google News RSS (`https://news.google.com/rss/search?q=<query>`) and Yahoo Finance RSS
   - Parse entries using `feedparser` (stdlib fallback: `xml.etree.ElementTree`)
   - Load/save seen article IDs from `{get_hermes_home()}/cron/news_<topic>_seen.json`
   - For new articles, format: title, source, date, URL, snippet
   - Print output (cron captures stdout for delivery)

2. **Register the cron job** after checking `hermes cron create --help`:
   ```
   hermes cron create 'every 2h' '<self-contained research and dedupe prompt>' --name '<topic> monitor' --deliver '<platform>:<verified-chat-id>' --continuity
   ```
   - Use an agent research job for substantive-event alerts: seed a baseline of already-known facts with sources, distinguish genuinely new developments from recycled articles, and return exactly `[SILENT]` for no updates.
   - For deterministic RSS scripts, put scripts under the active Hermes home's `scripts/` and use `--script <name.py> --no-agent`; empty stdout suppresses delivery. Verify the live fetch before registration.
   - Verify the registered target, schedule, and running scheduler with `hermes cron list` and `hermes cron status`. For iMessage, resolve the existing Photon home chat, not a guessed phone number. The running sidecar health endpoint is authenticated `POST /healthz`, not GET /health.
   - Default frequency: every 2 hours
   - Deliver via configured channel (Telegram by default)
   - First run: within ~30 minutes

3. **Tell the user**:
   - Job name, schedule frequency, delivery channel
   - When first check runs
   - Offer to adjust frequency or pause

## Pitfalls

- **feedparser may not be installed** — use try/except with xml.etree.ElementTree fallback, or check with `import feedparser` first
- **Rate limiting** — don't run more frequently than every 30 minutes
- **Seen file** — always use `get_hermes_home()` for path, not hardcoded `~/.hermes`
- **Empty results** — don't notify if no new articles found
- **RSS format varies** — be lenient with XML parsing, handle missing fields gracefully