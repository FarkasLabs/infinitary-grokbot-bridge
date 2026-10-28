# Security

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository (private vulnerability reporting). Do not open a public issue or pull request for a security problem, and do not include real keys, pairing links or webhook URLs in a report. Expect an acknowledgement within a few days.

## Supported versions

Only the latest release on the default branch is supported. This is a 0.x project.

## Threat model, short

- **The pairing key is a full-access key.** The background relay only sends read requests, but that is the bridge's own choice, not a limit Infinitary enforces. Anyone who can read the key can connect to Infinitary as you and act as you. Keep the state folder (`~/.local/state/infinitary-grokbot-bridge`, mode 0700) private.
- **Acting commands act as you.** `answer`, `reply` and `say` can press buttons, merges included, and message Infinitary's first mate. Give them to a bot only if you accept that. Merge, discard and kept writes also need `--confirm`.
- **The webhook key** lives in a separate file you control (`webhook.env`, mode 0600), is read at send time, and is never logged. Whoever holds it can post to your Grok Bot.
- **Pairing is loopback only** and pinned to the home's key. The bridge never listens on a network port.
- **Card, thread and Inbox text is untrusted** and is never treated as an instruction by the bridge. A bot that reads it may still be misled, which is why acting is opt-in per use.
- **Verified so far:** on Linux, live pairing, the systemd service, card relay and receiving an inbound message. **Not verified live:** acting on a real Infinitary (answering, merging) and how pages look on a phone.

The full notes are in [docs/security.md](docs/security.md).
