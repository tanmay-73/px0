# Git Integration: Source Control, Diffs & Compare

px0 shows git status everywhere (explorer, tabs, editor gutter, status bar) and has a VS Code-style **Source Control** view for the everyday loop: review changes in Monaco's diff editor, stage, unstage, discard, commit, amend, pull, push and sync, and read the commit history.

Reading git state never writes anything. Every write (stage, commit, push, ...) is one explicit action you take; nothing runs on a timer or because a file changed. Pull is fast-forward only, so it can never leave the repository mid-conflict.

---

## Live status

- The server pushes status over one event stream (`/api/stream`). A `git checkout`, `git add` or `git commit` in a terminal shows up within about a second, because px0 watches git's own control files (`.git/index`, `.git/HEAD`, `.git/packed-refs`). Edits made by other tools are caught by an adaptive poll (every 2 s on small repositories, up to 15 s on huge ones).
- The stream pauses while the browser tab is hidden and resumes, with a fresh status read, when you come back.
- **Explorer:** changed files are coloured and carry VS Code's letter badges (`M` modified, `A` added, `D` deleted, `U` untracked, `R` renamed, `!` conflict); folders containing changes get a dot.
- **Tabs** are coloured the same way. **Status bar:** the branch (with `*` when there are changes, and `REBASE`, `MERGE`, ... while one is in progress) and the sync counts.
- **Gutter (quick diff):** every editor shows bars for lines added (green), changed (blue) and removed (red marker) compared with the file in the **index**, updated as you type. Click a bar to open the file's changes. It is off for untracked files and files over 20,000 lines.

## The Source Control view (`Ctrl/Cmd+Shift+G`)

From top to bottom:

1. **Commit message box.** The placeholder names the branch. `Ctrl/Cmd+Enter` commits. The draft message is kept per workspace until you commit.
2. **Commit button**, with a menu: **Commit**, **Commit (Amend)**, **Commit & Push**, **Commit & Sync**. When there is nothing to commit the button becomes **Sync Changes** (`n↓ m↑`) if the branch is behind or ahead, or **Publish Branch** if it has no upstream.
3. **Merge Changes** (unmerged files, only during a merge or rebase), **Staged Changes** (index vs `HEAD`) and **Changes** (working tree vs index, untracked files as `U`). A file staged and then edited again is in both. Each group collapses, shows a count, and has group actions (Stage All, Unstage All, Discard All).
4. **Commits:** the history from `HEAD`, newest first, with author and time; commits not yet pushed have a cloud icon. Click a commit to list the files it changed with `+`/`−` line counts, and click a file to open that commit's diff of it. Right-click for Copy Commit ID / Copy Commit Message. **Load More Commits...** pages back (up to 200).

Each file row has inline buttons: **Open File**, **Discard Changes** (Delete File for an untracked file) and **Stage Changes** in Changes, **Unstage Changes** in Staged Changes, **Stage Changes (mark resolved)** in Merge Changes. Right-click for the same actions plus Open Changes, Copy Relative Path and Reveal in Explorer View. Click a row to open its diff in a preview tab, double-click to keep it.

The view's title bar has **Commit**, **Refresh** and **More Actions...**: Pull, Push, Sync, Commit variants, Stage All / Unstage All / Discard All Changes, and **Abort Rebase/Merge/...** when one was left in progress. A banner says when a merge or rebase is in progress and offers **Abort**.

### Committing

- With nothing staged, Commit offers to **stage all your changes and commit them directly** (**Always** remembers the answer, like VS Code's smart commit).
- **Commit (Amend)** rewrites the last commit with what is staged; an empty message keeps the old one. It never stages anything itself.
- **Commit & Push** and **Commit & Sync** run the push or sync right after a successful commit.

### Discarding

Discard throws away working-tree changes only: tracked files go back to their staged version, untracked files are deleted (ignored files and nested repositories are never touched). Staged changes are kept. px0 asks first, and says when files will be deleted.

### Pull, push and sync

- **Pull** fast-forwards onto the upstream. If the branches have diverged, px0 refuses and leaves the rebase or merge to you in a terminal; nothing is merged for you.
- **Push** pushes the branch to its upstream, setting one up on `origin` on the first push of a new branch.
- **Sync** pulls if the branch is behind, then pushes if it is ahead (or has no upstream).
- A running operation is shown in the status bar; failures appear as notifications with git's message.

In a pull request review, Pull and Push target the PR's own head branch. See [Pull Request Review](github-pr-review.md).

## Diffs

Changes open in Monaco's diff editor, side by side (or inline, with **Toggle Inline View** in the editor title bar or the palette). What each side shows depends on where you opened it, following VS Code:

| Opened from | Left (original) | Right (modified) |
| :--- | :--- | :--- |
| **Changes** | the file in the index | the working-tree file, **editable** |
| **Staged Changes** | the file at `HEAD` | the file in the index (read-only) |
| A commit in **Commits** | the file in the commit's first parent | the file in that commit (read-only) |
| A file in a PR review | the PR's merge-base (`BASE`) | the working-tree file, editable |

- Because the right side of a working-tree diff is the file itself, you can fix things while reviewing; saving writes the file. The arrows in the diff's margin revert a block in that editable side.
- **Next / Previous Change** (`Alt+F5` / `Shift+Alt+F5`, or the arrows in the title bar) step through changes. **Open File** (title bar) opens the file itself.
- Settings: `diffEditor.renderSideBySide`, `diffEditor.ignoreTrimWhitespace` (Toggle Ignore Trim Whitespace), `diffEditor.hideUnchangedRegions.enabled`.
- **Open Changes** (`git.openChange`: the editor title button on a changed file, the explorer's context menu, or a gutter bar) opens the working-tree change, or the staged one if that is all there is.
- The read-only sides of a diff are read when the tab opens. After a stage or commit, close and reopen the diff to compare against the new index or `HEAD` (the gutter bars do follow the index on their own).

## Comparing any two files

Like VS Code: **Select for Compare** on one file and **Compare with Selected** on another (explorer or tab context menu), or run **File: Compare Active File With...** and pick the other file. The comparison is a diff editor with both files editable; the left one is the first file. The files need not be tracked.

---

## Commands

All of these are in the Command Palette (`Ctrl/Cmd+Shift+P`) under **Git:**: Commit, Stage All Changes, Unstage All Changes, Stage Changes, Unstage Changes, Discard Changes, Open Changes, Open File, Push, Pull, Sync, Refresh. Diff commands are under **Diff Editor:**.

| Key | Action |
| :--- | :--- |
| `Ctrl/Cmd+Shift+G` | Show Source Control (focuses the commit box) |
| `Ctrl/Cmd+Enter` | Commit, in the commit box |
| `Alt+F5` / `Shift+Alt+F5` | Next / previous change in a diff |

## Configuration

- `diffEditor.renderSideBySide`, `diffEditor.ignoreTrimWhitespace`, `diffEditor.hideUnchangedRegions.enabled` (Settings, `Ctrl/Cmd+,`).
- `px0 -no-git` disables git features entirely.

## Endpoints

Every POST requires a same-origin request over `localhost` or a direct IP address.

| Endpoint | Purpose |
| :--- | :--- |
| `GET /api/git/status` | Branch, `head`, upstream, ahead / behind, any merge / rebase / cherry-pick / revert in progress, and the `staged`, `changes` and `conflicts` lists. In a PR review session the upstream is the PR's head branch. |
| `POST /api/git/stage` / `unstage` | `{path}`, `{paths: [...]}` or `{all: true}`. Paths are literal, never globs. |
| `POST /api/git/discard` | `{paths: [...]}`: throw away working-tree changes; untracked files are deleted. |
| `GET /api/git/show?path=P&ref=R` | A file at `HEAD` (default), `INDEX`, `BASE` (the PR merge-base in a review, else `HEAD`), a commit SHA, or `SHA^`; `exists: false` when the file is missing there. This is what the diff editor's read-only sides and the gutter use. |
| `POST /api/git/commit` | `{message}`, or `{message, amend: true}`. |
| `POST /api/git/push` / `pull` | Push; fast-forward-only pull (`409` on divergence). |
| `POST /api/git/abort` | Abort the operation in progress. |
| `GET /api/git/log` | Recent commits (`limit` up to 200). |
| `GET /api/unpushed` | Commits in `@{u}..HEAD`, used to mark unpushed commits. |
| `GET /api/commitfiles?sha=` | The files a commit changed, with line counts. |

See [Git Integration Internals](../internals/git-integration.md) for how status, the watcher and the endpoints work.
