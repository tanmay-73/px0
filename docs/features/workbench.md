# Review Workbench

Running `px0` with no arguments opens the **workbench**: one page for opening any directory on the machine or any pull request, and for getting back to what you opened before.

---

## Opening things

- **Type a path or paste a PR URL** into the box at the top and press Enter. Paths may be absolute, relative to the directory px0 was started in, or start with `~`. A path to a file opens its repository.
- **Folder completion.** As you type a path, folders whose names start with what you typed (ignoring case) are listed below the box, with a `git` tag on repositories. Press **Tab** (or click) to complete into the highlighted folder and list what is inside it, **↑/↓** to choose, **Enter** to open, **Esc** to dismiss. Hidden folders are listed once you type the leading dot. The Browse panel follows along.
- **Browse** the filesystem on the right. Folders that are git repositories carry a `git` tag. Click a folder to go into it, use **Open** on its row, or **Open this folder** for the one you are in. Tick **hidden** to list dot-folders.
- **Open \<cwd\>** opens the directory px0 was started in, which is what a bare `px0` did before the workbench.
- **Recent** lists every directory and pull request opened before, most recent first, including ones opened directly with `px0 <dir>` or `px0 <pr-url>`. Click a row to reopen it; Cmd/Ctrl-click opens it in a new tab.

Each workspace opens at its own address, `/w/<id>/`, on the workbench's port. The address is stable, so a bookmarked or reloaded review simply reopens. In a workspace, the px0 logo at the left of the title bar, **File > Open Workbench**, and the home button of the Repositories view lead back to the workbench.

## Repositories

The **Repositories** panel lists every git repository px0 finds on the machine: under the `-roots` folders when given, otherwise under the folder px0 was started in, the folder above it, the usual code folders in your home directory and the folders around your recent ones. The search goes a few levels deep and stops at each repository it finds, so nested folders of a repository are never listed as repositories of their own. **Rescan** looks again; otherwise the list is kept for a minute.

Each row shows the repository's current branch and what is pending in it, read with `git status` as the row scrolls into view, without taking git's index lock:

| Mark | Meaning |
| :--- | :--- |
| `●3` | 3 tracked files changed |
| `✚2` | 2 files staged |
| `?1` | 1 untracked file |
| `⚠1` | 1 file with merge conflicts |
| `↑2` / `↓1` | commits to push to / pull from the upstream branch |
| `clean` | nothing pending |

Type in the filter box to narrow the list by name or path (every word must match), **↑/↓** to choose, **Enter** to open. Click a row or **Open** to open it in this tab; **Ctrl/Cmd-click**, a middle click, the **↗** button or **Ctrl/Cmd+Enter** opens it in a new tab. The **Open** buttons in Browse take Ctrl/Cmd-click the same way.

## Switching repositories from a workspace

A workspace opened from the workbench can move to any other repository without going back to the workbench page:

- **`Alt+O`**, a click on the workspace name at the left of the status bar, **File > Switch Repository...**, or **Workspace: Switch Repository...** in the Command Palette lists what was opened before (the current one marked `current`, running ones `running`) followed by every repository in the Repositories panel. Type to filter. **Enter** opens it in this tab, **Ctrl/Cmd+Enter** or Ctrl/Cmd-click in a new tab. A path (`/…`, `~/…`) or a PR URL typed there opens as typed.
- The **Repositories** view in the activity bar lists the same entries, recently opened first, with each repository's branch and pending changes. Type to filter; click to open here, `Ctrl/Cmd`-click or middle-click for a new tab; right-click for Open, Open in New Tab and Copy Path. Its title bar has **Rescan for Repositories** and **Open Workbench**.
- In the file tree, a folder that is a git repository of its own (a nested clone or a submodule) carries a `git` tag. Its right-click menu has **Open Repository** and **Open Repository in New Tab**, which open it as a workspace with its own Source Control view.

Each workspace keeps its own tabs, index and git state, so going back to one (with the browser's Back button, or by switching again) finds it as you left it as long as it is still running.

## Managing the list

Hover a row for its actions:

| Action | Effect |
| :--- | :--- |
| **Pin to top** / **Unpin** | Pin to the top of the list, or unpin. Pinned entries are never dropped. |
| **Stop this workspace** | Stop the running workspace and free its memory. Opening it again restarts it. |
| **Remove from the list** | Stop it and remove it from the list. |

A label shows workspaces that are **running**, **starting**, **failed** (hover for the error) or **exited**. Up to 50 unpinned entries are kept.

---

## Keyboard Shortcuts & Controls

| Shortcut / Control | Context | Action |
| :--- | :--- | :--- |
| `/` | Workbench Page | Focus the path / PR URL input box |
| `Tab` | Path Input | Complete into the highlighted folder suggestion |
| `↑` / `↓` | Path Suggestions | Navigate up / down through folder suggestions |
| `Enter` | Path Input / Suggestion | Open the entered folder, PR URL, or highlighted suggestion |
| `Esc` | Path Suggestions / Theme | Dismiss folder suggestions or restore previous theme |
| `Cmd/Ctrl + Click` | Recent Workspaces | Open workspace in a new browser tab |
| `Cmd/Ctrl + Click`, `↗`, middle click | Repositories | Open the repository in a new browser tab |
| `Cmd/Ctrl + Enter` | Repositories Filter | Open the highlighted repository in a new browser tab |
| `Alt + O` | Any Workspace | Switch repository (Enter: this tab, Cmd/Ctrl+Enter: new tab) |
| Pin / Stop / Remove buttons | Recent row | Pin or unpin; stop the workspace; remove it from the list |
| px0 logo | Workspace title bar | Return to the workbench from any open workspace |
| Color Theme button / arrow keys | Workbench title bar | Preview and select the color theme |

## Pull requests

A pull request always opens as a `git worktree` of a local clone of its repository: a separate checkout that shares the clone's history, so opening a PR costs a checkout and never a fresh clone. The PR is checked out again each time it is opened, so it is always current, and the worktree is removed when the workspace stops. Your clone's own branch and working tree are not touched. Unsubmitted review drafts are kept across reopenings.

The first time you open a PR of a repository, px0 finds the clone:

1. a clone you used for that repository before;
2. one of your recent folders, or the folder px0 was started in;
3. a quick scan (a few levels deep, at most 1.5 seconds) of the usual code folders in your home directory (`~/workspace`, `~/code`, `~/src`, `~/projects`, `~/dev`, `~/repos`, `~/go/src/github.com`, ...) and the folders around your recent ones.

A clone matches when any of its remotes (`origin`, `upstream` for a fork, or another) points at the PR's repository. The clone is remembered, so every later PR of that repository opens straight away.

If no clone is found, the page asks. You can **use your clone**: type its path (with folder completion) or browse to it and press **Use as clone**. Or you can **let px0 clone it**: px0 makes one partial clone under `~/.px0/repos/<owner>/<repo>`, without a checkout of its own, and reuses it for every later PR of that repository.

A plain `px0 <pr-url>` run outside the repository uses the remembered clone too.

If a pull request cannot be opened (a typo in the URL, no access), the page explains why and the entry is left out of the list.

## Status bar and themes

The bottom bar shows px0's version, the number of running workspaces, and CPU and memory: here the workbench and every running workspace added together, with language servers; hover it for a breakdown by process. The **Color Theme** button in the title bar opens the theme list. Arrow keys preview a theme, Enter or a click keeps it, and Esc restores the one you had. The choice is saved to settings, so the workspaces use it too.

## Resources

Every workspace runs as its own px0 process with its own index and language servers. A workspace that has had no open tab for 30 minutes is stopped to free its memory; it restarts the next time it is opened. Stopping the workbench (Ctrl-C) stops every workspace and removes their PR checkouts.

Running `px0` again while a workbench is already running opens the existing one instead of starting a second.

## Limiting what can be opened (`-roots`)

`px0 -roots <dir>[:<dir>…]` (folders separated as in `PATH`) confines the workbench to those folders: the Repositories panel lists only repositories inside them, and browsing, folder completion and opening refuse everything else. Browse can still walk through the folders above a root, showing only the way down to it. Entries recorded before the roots were narrowed fail to open with a message saying why. PR checkouts that px0 makes itself (under `~/.px0/repos`) are not affected.

## Security

The workbench can list and open **any directory the px0 process can read**. On the default `-host 127.0.0.1` that is only you. With `-host 0.0.0.0`, anyone who can reach the address can browse the machine's folders and open any of them for reading and editing, and px0 prints a warning saying so. Expose it only over networks you trust. The same DNS rebinding and same-origin checks as the rest of px0 apply.

## Where state lives

What you opened, and which clone each repository's PRs use, is saved in `$XDG_STATE_HOME/px0/workbench.json`, falling back to `~/.px0/workbench.json`. Clones px0 makes live in `repos/` beside it. Nothing is written inside your repositories, apart from the temporary worktree registrations and `refs/px0/*` refs that px0 already uses for PR review and removes on exit.

## Flags

`-roots` is described above. The workbench passes `-no-lsp` and `-no-git` on to every workspace it opens. `-host`, `-port`, `-base-path` and `-no-open` apply to the workbench itself. To open the current directory directly, as before, run `px0 .`.
