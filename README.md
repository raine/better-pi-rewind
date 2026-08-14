# better-pi-rewind

Claude Code-style file checkpoints for [pi](https://pi.dev).

The extension records the state of files changed through pi's built-in `edit`
and `write` tools. Rewinding can restore those files, fork the conversation to an
earlier user prompt, or do both together.

## Install

Install directly from a local checkout:

```sh
pi install /absolute/path/to/better-pi-rewind
```

Or try it for one run:

```sh
pi -e /absolute/path/to/better-pi-rewind
```

A published Git repository can be installed with:

```sh
pi install git:github.com/OWNER/better-pi-rewind
```

## Use

Run `/rewind` and select the point before an earlier user prompt. The extension
then offers:

- Restore code and conversation
- Restore conversation only
- Restore code only

`/checkpoint` is an alias for `/rewind`.

### Double Escape

Pi already has a double-Escape fork selector. Configure it to select user
messages by adding this setting to `~/.pi/agent/settings.json`:

```json
{
  "doubleEscapeAction": "fork"
}
```

Press Escape twice with an empty editor. After choosing a user message,
better-pi-rewind offers to restore the matching code checkpoint before pi creates the
conversation fork.

Pi uses a 500 ms double-press window. The first Escape keeps its regular cancel
behavior while a response or Bash command is active.

## How checkpoints work

1. When an assistant response starts for a user prompt, the extension snapshots
   every file already under checkpoint tracking.
2. Before the first `edit` or `write` call touches another file, the extension
   copies its current contents into that prompt's checkpoint.
3. A missing file is represented explicitly, allowing rewind to remove files
   created by `write`.
4. Checkpoint metadata is stored as custom entries in pi's session JSONL. It
   follows the conversation when pi forks or resumes a session.
5. Backup files live under
   `~/.pi/agent/file-history/<session-id>/`. `PI_CODING_AGENT_DIR` changes the
   parent directory along with pi's other data.
6. Restore compares existence, mode, size, and content before writing. Matching
   files stay untouched, changed files are copied from the backup, and their
   permissions are restored.

This is a filesystem checkpoint system independent of Git. Git branches, the
index, commits, and repository metadata remain unchanged.

## Coverage

Checkpoint coverage consists of files changed through pi's built-in `edit` and
`write` tools. Arbitrary shell commands, custom tools, and external editor
changes do not register new files. Once a path enters tracking, each later user
prompt captures its current state regardless of how it changed.

Restoration is best-effort per file. A failure is reported while restoration of
other tracked files continues. Code restoration runs before conversation
forking, so the combined operation is sequential rather than transactional.

## Development

```sh
npm install
npm run check
```

The implementation follows pi's extension APIs and session lifecycle. Useful
upstream references include:

- [`git-checkpoint.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/git-checkpoint.ts)
- [Extension API source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- [Pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

Unlike the upstream Git checkpoint example, better-pi-rewind uses per-file backups and
tracks file creation and permissions without requiring a Git repository.

## License

MIT
