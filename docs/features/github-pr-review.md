# Pull Request Review

px0 checks out a pull request's full source tree and lets you review it like any local workspace: the whole codebase with Quick Open, search, language servers and the outline, plus diffs scoped to the PR's merge-base, inline review comments, verdicts and merging. The Source Control view works in the checkout, so you can commit and push fixes to the PR's own branch, and pull in commits someone else pushed while you were reviewing.

It works with **GitHub**, **GitLab** (gitlab.com and self-hosted), **Gitea / Forgejo / Codeberg**, and **Bitbucket Cloud**.

> [!TIP]
> New to PR review in px0? [Getting Started with Pull Request Review](pr-review-getting-started.md) walks through the first review end to end, including connecting your forge.

---

## Opening a pull request

Pass the full URL:

```bash
px0 https://github.com/owner/repo/pull/123
px0 https://gitlab.com/group/subgroup/project/-/merge_requests/45
px0 https://codeberg.org/owner/repo/pulls/7
px0 https://bitbucket.org/workspace/repo/pull-requests/9
```

| Forge | URL shape | Notes |
| :--- | :--- | :--- |
| GitHub | `github.com/<owner>/<repo>/pull/<n>` | |
| GitLab | `<host>/<group>[/<subgroup>...]/<project>/-/merge_requests/<n>` | gitlab.com or any self-hosted instance; nested groups are supported |
| Gitea / Forgejo | `<host>/<owner>/<repo>/pulls/<n>` | Codeberg, gitea.com, or any self-hosted instance |
| Bitbucket Cloud | `bitbucket.org/<workspace>/<repo>/pull-requests/<n>` | Bitbucket Data Center / Server is not supported |

Trailing paths such as `/files`, `/diffs` or `/diff` are fine. Bare PR numbers (`px0 123`) and the `px0 pr` subcommand are no longer supported; `px0 pr` reminds you to pass the URL.

You can also paste a PR URL into the [workbench](workbench.md), which opens each PR as a worktree of your local clone of the repository.

While px0 fetches the PR, the terminal shows progress:

```text
⠋ Fetching PR #123 metadata from github...
⠙ Fetching PR #123 head and preparing worktree...
⠸ Computing merge base with main...
✔ PR #123 checked out (Refactor auth token resolution)
```

An already merged PR opens too, marked merged in the terminal and in the Pull Request view. Each review runs as its own process on its own port, so several reviews and workspaces can be open at once.

---

## The Pull Request view

A PR review adds a **Pull Request** view to the activity bar, and opens it when there are no tabs to restore. The command center in the title bar shows `— PR #<n>`. The view's title bar has **Refresh** and **Open on the Forge**. Its sections:

| Section | What it shows |
| :--- | :--- |
| **Overview** | Title, number, state (open, merged, ...), author, `head` into `base`, any warning about the diff base, a **Read only** notice with **Connect...** when there is no token, and a link to the PR on the forge. |
| **Files Changed** | Every file the PR changes, with its status letter and counts of existing and draft comments. Click a file to open its diff in a preview tab; double-click to keep it. |
| **Comments** | The conversation, then the inline review comments by file and line (each with a link to its location, and **Reply** on the first comment of a thread), and a box to post a new top-level comment (`Ctrl/Cmd+Enter` or **Comment**). |
| **Your Review** | Your draft comments (each with **Delete draft**), a summary box, and **Submit Review**, plus **Approve** and **Request Changes** when your token has push access. |
| **Merge** | Collapsed at first. Whether the PR can merge, the merge method, the commit title and message, and **Merge Pull Request**. |

### Diffs against the merge-base

A PR file's diff compares the PR's merge-base with its target branch (`BASE`) on the left with the working-tree file on the right, the same diff the forge shows. The right side is the file itself, editable. Everything else in the workspace (Source Control, the gutter bars) works against the checkout's own `HEAD` and index, as in any repository.

### Review comments

- **Add a comment**: in a PR file, put the cursor on a line (or select lines) and choose **Add Review Comment** from the editor's right-click menu. The comment is anchored to the last line of the selection, on the new side of the diff, and is a draft until you submit.
- Only files the PR changes can take review comments.
- Existing comments and your drafts show as comment icons in the editor's glyph margin; hover an icon to read them.
- **Drafts persist**: they are saved outside the repository, per pull request, so reopening the same PR (with `px0 <pr-url>` or from the workbench) brings them back.
- **Reply** to an inline comment from the Comments section; post a top-level comment from the box at its end.

### Submitting a review

In **Your Review**, write an optional summary and choose:
- **Submit Review**: comments without a verdict (needs a draft or a summary).
- **Approve** / **Request Changes**: shown when your token has push access to the repository.

Submitting sends every draft and the summary together, then clears the drafts. How each forge records them is in [Forge Differences](#forge-differences).

### Merging

Open the **Merge** section. It says whether the PR can be merged now, and lets you pick a method from those the repository allows (**Create a merge commit**, **Squash and merge**, **Rebase and merge**). For a merge commit or a squash, the commit title and message are prefilled with the usual defaults and can be edited. **Merge Pull Request** asks for confirmation, then merges.

Merging is blocked, with the reason, when:
- the PR has new commits on the forge that this checkout hasn't pulled;
- a rebase or merge is in progress in the checkout;
- local commits are not pushed to the PR yet;
- the branch was rewritten locally (a rebase) and not force-pushed;
- the forge says the PR can't merge (conflicts, protection rules, draft, ...).

The merge is tied to the head commit you reviewed: if the PR moved since, the forge refuses it.

---

## Connecting your forge

Public repositories open, diff and navigate without any token. Posting comments, submitting reviews, pushing and merging need one.

Without a token the Overview says **Read only** and offers **Connect...**. It opens the token page on the PR's own host in a new browser tab, then asks for the token in a prompt that lists what to choose there (the scopes or permissions px0 needs), and for a Bitbucket API token also the account email. px0 checks the token by reading the PR with it before keeping it: a token the forge rejects is never saved. An accepted token is saved to your px0 settings and applies to the running review at once, with no restart.

Step-by-step token instructions for each forge are in [Getting Started](pr-review-getting-started.md#2-connect-your-forge).

### Where px0 looks for a token

The first match wins.

| Forge | 1. px0 Settings | 2. Environment | 3. CLI |
| :--- | :--- | :--- | :--- |
| GitHub | `github.token` | `GITHUB_TOKEN`, then `GH_TOKEN` | `gh auth token` |
| GitLab | `gitlab.token` | `GITLAB_TOKEN` | the token `glab auth login` stored for the MR's host |
| Gitea / Forgejo | `gitea.token` | `GITEA_TOKEN` | — |
| Bitbucket Cloud | `bitbucket.token` (+ `bitbucket.email` for an API token) | `BITBUCKET_TOKEN` (+ `BITBUCKET_EMAIL`) | — |

### Self-hosted instances and token safety

A PR URL can name any host, so px0 never sends a token to a host it wasn't configured for:
- **GitLab**: `gitlab.token` and `GITLAB_TOKEN` go only to `gitlab.host` (Settings), else `GITLAB_HOST`, else gitlab.com. Other instances use the token glab stored for them.
- **Gitea / Forgejo**: `gitea.token` and `GITEA_TOKEN` go only to `gitea.host` (Settings), else `GITEA_HOST`, else codeberg.org.
- GitHub and Bitbucket Cloud each have a single host.

Connecting from the review saves the host along with the token. If a token for a *different* host of the same forge is already saved, the new one is used for the current session only and the saved one is left alone.

Tokens are stored in your px0 settings file (`~/.px0/settings.json`, or `$XDG_CONFIG_HOME/px0/settings.json`) on the machine running px0. Git receives them through environment variables scoped to the forge's URL, never on the command line, in remote config, or in URLs, and px0 strips them from any error text it shows.

### Without a token

- Public repositories still check out, diff and navigate.
- You can draft review comments locally.
- The terminal says which forge needs a token and where px0 would find one, for example:
  ```text
  access: read-only (no GitHub token: set GITHUB_TOKEN, set GH_TOKEN, or run `gh auth login` to submit reviews)
  ```

---

## Editing, committing and pushing back

A PR checkout is a real git worktree, and the [Source Control view](git-integration.md) works in it:

- **Edit and commit**: change files (in px0 or another editor), stage and commit as usual.
- **Push** sends the checkout's `HEAD` to the pull request's *actual* head branch on its actual repository, a fork included, not wherever the checkout happens to live.
- **Pull** re-fetches the PR's current head. If your checkout can fast-forward onto new commits, px0 updates it. If it has diverged (local commits the PR head doesn't have, or a force-pushed head), px0 refuses rather than merging; commit and push first, or resolve it in a terminal.

### Bringing the PR up to date with its base

px0 fetches the PR's base branch into `refs/px0/base/<number>` in the checkout. Rebase onto it or merge it in a terminal, resolving conflicts there; an operation left in progress shows a banner in Source Control with **Abort**. After a merge, Push is an ordinary push. After a rebase the PR's commits are rewritten: the server can force-push them with a lease (`--force-with-lease`, refused if someone else pushed in the meantime), but the current editor's Push sends an ordinary push, and the Merge section stays blocked until the branch on the forge matches.

> [!IMPORTANT]
> A PR checkout lives only as long as its px0 process. Edits made there, committed or not, are gone when the session ends unless you've pushed them to the PR's branch.

---

## Forge differences

| | GitHub | GitLab | Gitea / Forgejo | Bitbucket Cloud |
| :--- | :--- | :--- | :--- | :--- |
| Self-hosted | — | yes | yes | no (Data Center unsupported) |
| Review submitted as | one review | separate threads + approval | one review | separate comments + approval |
| Request Changes | native | comment + withdrawn approval | native | native |
| Threaded replies | yes | yes | same-line comments | yes |
| Conflicts known in advance | yes | yes | yes | yes (from diffstat) |
| Protection rules known in advance | yes | yes | no (shown when merge is refused) | no (shown when merge is refused) |
| Merge pinned to reviewed commit | by the forge | by the forge | by the forge | checked by px0 just before |

**GitLab**
- **Review submission**: GitLab has no single call for submitting a review. Each draft becomes a diff thread, and the summary becomes a comment. **Approve** uses GitLab's approval, pinned to the commit you reviewed. **Request Changes** posts a "Changes requested" comment and withdraws your approval, if you had given one. A draft on an unchanged context line, which GitLab can't anchor from the data px0 has, is posted as a comment that names the `path:line`.
- **Merge methods** follow the project's settings. A project that uses merge commits (including semi-linear history) offers **Create a merge commit**. A project that uses fast-forward merges offers **Rebase and merge**, which lands the commits as they are. **Squash and merge** is offered unless squashing is disabled, and it is the only option when the project requires squashing.
- **UI wording**: px0 labels merge requests "PR #N" rather than GitLab's "!N".

**Gitea / Forgejo**
- **Review submission** works like GitHub's: one review that carries every draft and the verdict.
- **Replies**: Gitea's API has no reply-to-comment call. A reply is a new comment on the same line, which Gitea's own UI shows in the same conversation. Gitea doesn't report which side of the diff a comment is on, so existing comments are shown on the new side.
- **Merge status** is only "mergeable or not". Draft PRs are recognized by their title prefix (`WIP:`, `Draft:`, ...). Branch protection isn't reported in advance; it shows up as the merge being refused, with Gitea's reason.
- **Merge methods** follow the repository settings. When rebase is disabled but fast-forward-only is enabled, **Rebase and merge** uses fast-forward-only.

**Bitbucket Cloud**
- **Checkout**: Bitbucket publishes no ref for a PR head, so px0 clones the source branch, from the fork when there is one, even inside a local clone.
- **Review submission**: each draft is posted as an inline comment and the summary as a comment. **Approve** and **Request Changes** use Bitbucket's own approval and request-changes states. Replies are threaded natively.
- **Merge status**: conflicts are detected from the PR's diffstat. Merge checks such as required approvals or builds aren't reported in advance; they show up as the merge being refused, with Bitbucket's reason.
- **Merge methods** come from the destination branch's allowed strategies: merge commit, squash, and rebase (`rebase_fast_forward`, or `fast_forward` if that's all that's allowed).
- **Head check**: Bitbucket's merge call can't be pinned to a commit, so px0 re-reads the PR head just before merging and refuses if it moved.
- **Tokens**: an access token (repository, project or workspace) or an Atlassian API token plus the account email. Only an API token can check push access, so **Approve**, **Request Changes** and merging stay unavailable with an access token.

---

## Controls

| Control | Where | Action |
| :--- | :--- | :--- |
| **Add Review Comment** | Editor right-click menu, in a PR file | Draft a comment on the line or selection |
| Comment icon | Editor glyph margin | Hover to read existing and draft comments |
| Click a file | Files Changed | Open its diff against the merge-base |
| **Connect...** | Overview (read-only review) | Paste and check a forge token |
| **Submit Review** / **Approve** / **Request Changes** | Your Review | Submit the drafts and summary |
| `Ctrl/Cmd+Enter` | Comment box | Post a top-level comment |
| **Merge Pull Request** | Merge | Merge with the chosen method (asks first) |
| **Refresh** / **Open on the Forge** | Pull Request view title bar | Reload the PR / open it in the browser |
| **Pull** / **Push** | Source Control | Fast-forward onto the PR's head / push to the PR's head branch |

The provider architecture (`GitProvider` in `forge.go`) and how checkout, push, pull and merging work are described in [the internals guide](../internals/github-pr-review.md).
