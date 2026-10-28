# Security notes

- **Key.** The bridge's P-256 key and the home's pin are in `grant.json`, mode 0600, in a 0700 folder under `~/.local/state`. Code running as your user can read it; that is the same trust as the first mate's own local door.
- **Pinned TLS.** TLS 1.3 only, no session resumption, no name or date check: the connection proceeds only if the home's key hashes to the pinned SHA-256 of its public key. Pairing dials loopback only, whatever addresses the link carries.
- **Read-only is a client choice.** The hello names contract 999.0.0. Infinitary gives a connection whose major differs `access: "read"` and refuses every change on it. The bridge checks the welcome says `read` and closes otherwise. But the grant is a full view key: a thief with the file could speak 12.0.0 and act as you. This is not durable least privilege; the acting section says so too (below).
- **What the bridge can send.** A fixed list of three read channels; anything else is refused in the bridge before it reaches the socket.
- **Webhook.** Settings are read at send time from the settings file and never stored, logged or echoed; errors carry only a status or a generic reason. The URL must be https (http only to loopback).
- **Pages.** The page drops script, frames, handlers and remote loads, shows controls disabled, and sets a Content-Security-Policy with `default-src 'none'`. Pictures are inlined from the home's own copies.
- **Switch.** A file; off by default; checked immediately before every send, so a flip to off stops output even mid-message.
- **Verified and not.** Tested against stand-ins at the wire. Verified live on Linux: pairing, the systemd service, card relay and receiving an inbound message. Not verified live: acting (answers, merges) and how pages look on a phone.

## Acting

- **Full access, on purpose.** `answer`, `reply` and `say` open a link that speaks the home's own major version (learned from a read-only hello) and are used only if the welcome says `access: full`. The same stolen key therefore acts as you in either case; the read-only relay is a client choice, as above. Pairing grants full captain powers.
- **What can be sent.** A fixed list: the reads plus `inf:cards:act`, `inf:cards:reply`, `inf:converse`. Nothing else, no other change, no task start or stop.
- **Intent per request.** One command, one request id, one change. The id is claimed in a file created exclusively before the send, so concurrent or repeated runs cannot send twice; a failed or interrupted send is not retried.
- **Stale and replayed.** The card's lifecycle and offer must equal the home's list immediately before the press. A small window remains between that read and the press; the home itself also refuses a stale offer for merges that declare required actions, and always records the offer the press named.
- **Explicit merges.** A merge, discard or kept write needs `--confirm`. Nothing in the bridge presses a button unprompted, and card text, thread text and Inbox data are never treated as instructions.
- **Switch.** Off means no acting connection either; the commands refuse before opening anything.
- **Not verified live.** The acting arguments come from the published contract and the app source; acting and merging have not been run against a real Infinitary. Whether a real home accepts a press with `reading: "none"` and no question definitions on a card with required actions is read from source, not observed.
