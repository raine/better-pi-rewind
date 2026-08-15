# better-pi-rewind

Claude Code-style file checkpoints for [pi](https://pi.dev) and
[OMP](https://omp.sh).

The extension records the state of files changed through the host's built-in
`edit` and `write` tools. Rewinding can restore those files, branch the
conversation to an earlier user prompt, or do both together.

## Install

Install the published package from npm.

### Pi

```sh
pi install npm:better-pi-rewind
```

### OMP

```sh
omp plugin install better-pi-rewind
```

Both hosts can also install a tagged GitHub release directly:

```sh
pi install git:github.com/raine/better-pi-rewind@v0.1.0
omp plugin install github:raine/better-pi-rewind#v0.1.0
```

### Local development

Load a checkout while developing the extension:

```sh
pi install /absolute/path/to/better-pi-rewind
omp plugin link /absolute/path/to/better-pi-rewind
```

Try the checkout for one run without installing it:

```sh
pi -e /absolute/path/to/better-pi-rewind
omp -e /absolute/path/to/better-pi-rewind/extensions/rewind.ts
```

## Use

Run `/rewind` and select the point before an earlier user prompt. The extension
then offers:

- Restore code and conversation
- Restore conversation only
- Restore code only

`/checkpoint` is an alias for `/rewind`.

### Double Escape

Press Escape twice within 500 ms with an empty editor. The extension opens its
rewind selector with every user prompt, the code changes that would be restored,
and a current-position marker. The same selector is available through `/rewind`.

Disable the host's built-in double-Escape action so the extension owns this
interaction.

For Pi, set this in `~/.pi/agent/settings.json`:

```json
{
  "doubleEscapeAction": "none"
}
```

For OMP, run:

```sh
omp config set doubleEscapeAction none
```

The first Escape retains the host's cancel behavior while an assistant response
is active. Selecting an earlier prompt opens the restore action menu.

## How checkpoints work

1. When an assistant response starts for a user prompt, the extension snapshots
   every file already under checkpoint tracking.
2. Before the first `edit` or `write` call touches another file, the extension
   copies its current contents into that prompt's checkpoint.
3. A missing file is represented explicitly, allowing rewind to remove files
   created by `write`.
4. Checkpoint metadata is stored as custom entries in the host's session JSONL.
   It follows the conversation when the host branches or resumes a session.
5. Backup files live under the active host's agent directory:
   `~/.pi/agent/file-history/<session-id>/` for Pi and
   `~/.omp/agent/file-history/<session-id>/` for OMP. Host profiles and agent
   directory overrides change the parent directory along with other host data.
6. Restore compares existence, mode, size, and content before writing. Matching
   files stay untouched, changed files are copied from the backup, and their
   permissions are restored.

This is a filesystem checkpoint system independent of Git. Git branches, the
index, commits, and repository metadata remain unchanged.

## Coverage

Checkpoint coverage consists of files changed through the host's built-in `edit`
and `write` tools. Arbitrary shell commands, custom tools, and external editor
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

The implementation follows the shared Pi extension surface and adapts host-specific
conversation branching. Useful upstream references include:

- [`git-checkpoint.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/git-checkpoint.ts)
- [Pi extension API source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- [OMP extension API source](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/extensions/types.ts)
- [OMP legacy Pi compatibility loader](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/plugins/legacy-pi-compat.ts)
- [Pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

Unlike [pi-rewind](https://github.com/arpagon/pi-rewind), better-pi-rewind uses
per-file backups and tracks file creation and permissions without requiring a
Git repository.

## License

MIT
