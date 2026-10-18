# dsh-delete-archived

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin to permanently delete **archived** conversations.

[中文](README.zh.md)

## What it does

- **Host side** (`lib/entry.js`) registers two HTTP routes and one agent tool:
  - `POST /plugin/dsh-delete-archived/delete` with `{ "sessionId": "..." }`
  - `GET  /plugin/dsh-delete-archived/list`
  - Tool `delete_archived_conversation(sessionId)` — callable by the assistant in a conversation.
  - Deletion removes the session's JSONL storage directory (all format generations) and clears
    the workspace registry: the archive marker, the pin marker, and each workspace's session
    accounting. Sessions that are not archived, or still resident in memory, are refused (a live
    session would rewrite its log on the next flush and resurrect the data).
- **Client side** (`lib/client.js`) adds a "Delete conversation" entry to the per-session "..." menu
  in the sidebar, shown **only for archived sessions** (two-step confirm, inline error on refusal).

## Difference from dsh-archived-chats

The community index already lists `dsh-archived-chats`, which also lists and permanently
removes archived conversations. This plugin does not re-implement that capability: the
increment here is (a) a "Delete conversation" row in the sidebar's per-session "..." menu for
archived sessions only, and (b) the model-callable `delete_archived_conversation` tool. If you
only need bulk cleanup, `dsh-archived-chats` is the smaller dependency.

## Destructive tool

`delete_archived_conversation` is **model-invocable**: the assistant can call it without any
second confirmation. It removes the session's JSONL directory and its workspace registry
entries, and the deletion cannot be undone. The sidebar entry is the human-confirmed path
(two-step confirm); treat the tool as an automation-level capability and keep it out of
workflows you do not want deleting archived sessions on their own.

## Behavior notes

- Only **archived** sessions can be deleted; archive a session first.
- Deletion is serialized per session. Being still held by the host is not a reason to refuse:
  archiving already stopped the agent and the host's `ArchivedSessionGate` refuses further steps,
  so the log is no longer written; the response reports `heldAtDelete` as evidence.
- The session-search index in this deployment is `:memory:`/`openAt: never`, so no index cleanup is
  needed; deployments that enable content search clean up the SQLite rows automatically on the next search.
- Content-addressed image attachments may be shared across sessions and are intentionally not reference-counted.

## Install

```sh
# Local directory — quit the Desktop app first; --profile is required.
dsh plugin --profile <profile> add <absolute/path/to/this/dir>

# From GitHub
dsh plugin --profile <profile> add github:<owner>/dsh-delete-archived
```

Then restart Harness so the new bundle composes. This package has **zero runtime dependencies** and
ships plain JavaScript, so a GitHub install needs no `allowBuilds` code-execution approval.

## License

MIT
