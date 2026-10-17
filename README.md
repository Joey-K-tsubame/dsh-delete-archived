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

## Behavior notes

- Only **archived** sessions can be deleted; archive a session first.
- If the session is still loaded in memory, deletion is refused — restart the app and retry.
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
