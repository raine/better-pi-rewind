# better-pi-rewind

Claude Code-style file checkpoints for [pi](https://pi.dev) and
[OMP](https://omp.sh).

The extension records the state of files changed through the host's built-in
`edit` and `write` tools. Rewinding can restore those files, reset descendant
Git commits or an amended checkpoint commit, navigate the current conversation
to an earlier user prompt, or combine those actions.

![Rewind selector showing file diff statistics](https://raw.githubusercontent.com/raine/better-pi-rewind/main/meta/rewind-selector.webp)

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
pi install git:github.com/raine/better-pi-rewind@v0.2.0
omp plugin install github:raine/better-pi-rewind#v0.2.0
```

## Use

Run `/rewind` and select the point before an earlier user prompt. The extension
then offers:

- Restore code and conversation
- Restore conversation only
- Restore code only
- Restore code with a hard reset of commits created after the checkpoint
- Restore code and roll back an immediately amended checkpoint commit

Git rollback choices appear when the selected checkpoint and the current state
use the same repository and branch. Descendant commits can be reset when the
checkpoint commit is an ancestor of `HEAD`. An amended commit can be rolled back
when the HEAD reflog shows that it immediately replaced the checkpoint commit.
The extension describes the detected change and asks for confirmation before
running `git reset --hard`.

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

While an assistant response is active, Escape retains the host's normal
single-press cancellation behavior. Selecting an earlier prompt opens the
restore action menu.

### Configuration

Create `better-pi-rewind.json` in the host's agent directory for user-wide
settings. For Pi this is normally `~/.pi/agent/better-pi-rewind.json`; for OMP
it is normally `~/.omp/agent/better-pi-rewind.json`.

```json
{
  "activeRunEscapePresses": 1,
  "escapeWindowMs": 500
}
```

`activeRunEscapePresses` accepts `1` or `2`. Set it to `2` to guard against
accidental interruption by requiring two presses. `escapeWindowMs` accepts an
integer from 50 to 5000 and controls both active cancellation and idle rewind
detection. The defaults are `1` press and 500 ms.

A trusted project can override either setting in
`.pi/better-pi-rewind.json` for Pi or `.omp/better-pi-rewind.json` for OMP.
Project settings take precedence over user settings. Run `/reload` after
editing a configuration file.

## How checkpoints work

1. When an assistant response starts for a user prompt, the extension snapshots
   every file already under checkpoint tracking.
2. Before the first `edit` or `write` call touches another file, the extension
   copies its current contents into that prompt's checkpoint.
3. A missing file is represented explicitly, allowing rewind to remove files
   created by `write`.
4. Each checkpoint records the Git repository root, branch, and `HEAD` commit
   when the working directory belongs to a repository with at least one commit.
5. Checkpoint metadata is stored as custom entries in the host's session JSONL.
   It follows the conversation tree when the host navigates or resumes a session.
6. Backup files live under the active host's agent directory:
   `~/.pi/agent/file-history/<session-id>/` for Pi and
   `~/.omp/agent/file-history/<session-id>/` for OMP. Host profiles and agent
   directory overrides change the parent directory along with other host data.
7. Restore compares existence, mode, size, and content before writing. Matching
   files stay untouched, changed files are copied from the backup, and their
   permissions are restored.

File-only restore actions leave Git references and the index unchanged. Commit
reset actions hard-reset the current branch to the checkpoint's `HEAD` before
restoring checkpointed files. This order lets checkpointed file contents recover
states that differed from the checkpoint commit.

## Coverage

Checkpoint coverage consists of files changed through the host's built-in `edit`
and `write` tools. Arbitrary shell commands, custom tools, and external editor
changes do not register new files. Once a path enters tracking, each later user
prompt captures its current state regardless of how it changed.

Restoration is best-effort per file. A failure is reported while restoration of
other tracked files continues. Git reset, code restoration, and conversation
navigation run sequentially rather than transactionally.

A commit reset overwrites the working tree and index through
`git reset --hard`, which may also overwrite untracked files. The extension
reapplies checkpointed files afterward, but changes outside checkpoint coverage
are not recoverable through the extension. Git's reflog and `ORIG_HEAD` provide
the standard Git recovery paths for the removed commits.

## Development

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

Install dependencies and run the checks:

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
