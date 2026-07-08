# ADR-0011: Moderator auto-approval — dark by default, fail-open author veto

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** owner + engineering

## Context
Facebook holds poster-accounts' posts in a group's "Spam potentiel"/pending queue, where a comment cannot attach. To make our held posts live, a separate admin (moderator) account must approve them. This is fraught: wrongly approving a stranger's spam, double-approving, or getting the moderator account checkpointed are all serious, account-costing failures. The queue DOM offers no safe handle — posts are keyed only by `[aria-posinset]`, are lazy-rendered, and expose no stable post-id. Any automation here must assume the DOM is adversarial and that a wrong click is worse than no click.

## Decision
Add a moderator flow behind a `moderationEnabled` flag that defaults **OFF** — with the flag off, behavior is byte-for-byte identical to today. When on, the flow runs as three serialized phases:

- **Phase 1 (posting):** the poster persists a held record to `moderation-state.json`, capturing the caption snippet, owning poster, and target group.
- **Phase 2 (approval):** `moderator.js` visits each group that has held records and approves **fail-open**.
- **Phase 3 (comment):** the approved post's comment payload is enqueued into pending-comments, and the Phase-3 comment-**rescue** runner (`automation/rescue.js`) places the link-comment via a healthy in-group account — not the owning poster re-entering.

Approval requires a caption match to a this-cycle held snippet of at least 12 characters plus the presence of an **approve** (not decline) button. The author check is a best-effort **veto**, not a required condition: it uses bidirectional normalized substring containment between the queue item's readable name and one of our `fbDisplayName` values, and only **blocks** approval when it reads a name that is *confidently not* one of ours. If the author name is unreadable (obfuscated DOM) or no `fbDisplayName` is configured, approval proceeds on the caption alone. The click path uses a button-anchored scan, a real `isTrusted` mouse click, accepts a "Publier?" confirmation, and counts success **only** when the tagged button detaches from the DOM. The feature shipped dark and was enabled only after a read-only dry-run validated every queue-DOM decision.

## Alternatives considered
- **Approve on caption match with no author guard at all** — rejected: a caption match plus a *confidently readable stranger's name* should still veto, so the best-effort author check exists as a veto. (Note: substring name matching is exactly what ships — bidirectional normalized containment — precisely because the queue DOM rarely exposes a clean, exactly-normalized name; requiring strict equality would veto too many of our own posts.)
- **Auto-login the moderator on checkpoint** — rejected: re-authing a challenged account invites a ban. The moderator is probe-only; on checkpoint it stops and yields.
- **Enable the click path before the dry-run** — rejected: instrumentation must be validated against the live obfuscated DOM before any write action is armed.

## Consequences
This makes safe, unattended approval possible without touching the default path. It costs:
- a `moderation-state.json` store (multiple moderators are supported — each group is routed to its own `moderatedBy`, with a single-moderator fallback);
- `fbDisplayName` captured best-effort at login — if empty, the author veto simply can't fire, so approval **fails open** onto the caption match alone;
- the moderator account being **excluded** from the posting pool.

Invariants that must not break: never log "approved" without passing the detach/confirmation probe (the log vocabulary is honest per-decision); `"spam"` must **never** be treated as a decline token, because the whole page literally says "spam"; and the three phases must stay serialized so a comment is never attempted before its post is confirmed live.

## References
- `automation/moderator.js:250`
- `automation/moderator.js:357`
- `MODERATOR_APPROVAL_SPEC.md`
- MEMORY: `za-post-fb-dom-and-moderation`
