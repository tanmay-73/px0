# Getting Started with Pull Request Review

This guide takes you from a pull request URL to a merged PR in px0: open it, connect your forge, review, fix, bring it up to date, and merge. It takes about five minutes the first time; after that, opening a PR is one command.

It works the same on **GitHub**, **GitLab** (gitlab.com and self-hosted), **Gitea / Forgejo / Codeberg**, and **Bitbucket Cloud**. Where a forge differs, this guide says so. The full reference is [Pull Request Review](github-pr-review.md).

**What you need**
- `git` installed.

---

## 1. Open the pull request

Copy the PR's URL from your browser and pass it to px0:

```bash
px0 https://github.com/owner/repo/pull/123
px0 https://gitlab.com/group/project/-/merge_requests/45
px0 https://codeberg.org/owner/repo/pulls/7
px0 https://bitbucket.org/workspace/repo/pull-requests/9
```

px0 checks out the PR into a temporary directory and opens it in your browser. Run it from inside a clone of the repository if you have one: px0 then adds a worktree to that clone instead of cloning again, which is much faster for large repositories.

You can also paste the URL into the [workbench](workbench.md) (a bare `px0`), which opens each PR as a worktree of your local clone.

> [!NOTE]
> The checkout is temporary. It is removed when px0 exits, so push any commits you want to keep (step 4).

---

## 2. Connect your forge

You can read any public PR without a token. To comment, review, push, or merge, px0 needs one.

**The quick way:** in the **Pull Request** view, the Overview says **Read only** when there is no token; click **Connect...**. px0 opens the forge's token page in a new browser tab and asks for the token in a prompt that lists what to pick there. It checks the token against the PR before saving it, and the token takes effect immediately, so there is nothing to restart.

The same steps, per forge:

### GitHub
1. Open [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) (a fine-grained token).
2. Name it (e.g. `px0`) and pick an expiration.
3. Under **Repository access**, choose the repositories you review, or **All repositories**.
4. Under **Repository permissions**, set **Contents** and **Pull requests** to **Read and write**.
5. Generate the token and paste it into px0.

Already use the GitHub CLI? If `gh auth login` has been run, px0 picks up its token automatically. `GITHUB_TOKEN` or `GH_TOKEN` work too.

### GitLab
1. Open **User settings → Access tokens** on your GitLab: `https://<your-gitlab>/-/user_settings/personal_access_tokens` (on gitlab.com: [gitlab.com/-/user_settings/personal_access_tokens](https://gitlab.com/-/user_settings/personal_access_tokens)).
2. Select **Add new token**, name it, and pick an expiration date.
3. Under **Select scopes**, check **`api`**.
4. Create the token and paste it into px0.

Self-hosted: connecting from the review remembers which instance the token belongs to (the `gitlab.host` setting), and px0 sends it only there. The GitLab CLI works too: after `glab auth login --hostname <your-gitlab>`, px0 finds the token glab stored for that host. Or set `GITLAB_TOKEN`, plus `GITLAB_HOST` for a self-hosted instance.

### Gitea, Forgejo, Codeberg
1. Open **Settings → Applications** on your instance: `https://<your-instance>/user/settings/applications` (on Codeberg: [codeberg.org/user/settings/applications](https://codeberg.org/user/settings/applications)).
2. Under **Generate new token**, name it.
3. Under **Select permissions**, set **repository** and **issue** to **Read and write**.
4. Generate the token and paste it into px0.

Connecting from the review remembers the instance (the `gitea.host` setting), and px0 sends the token only there. Or set `GITEA_TOKEN`, plus `GITEA_HOST` for an instance other than codeberg.org.

### Bitbucket Cloud
Bitbucket offers two kinds of token. Use an **API token** if you want to approve and merge:

1. Open [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Select **Create API token with scopes**, name it, and pick an expiry.
3. Choose **Bitbucket** as the app.
4. Grant read and write access to repositories and pull requests, and read access to your account. px0 reads your account to check push access.
5. Paste the token into px0, along with your **Atlassian account email**.

A **repository, project or workspace access token** (created in the repository's or workspace's settings under **Access tokens**) also works: leave the email empty. Bitbucket doesn't let an access token check your permissions, though, so with one px0 can't confirm push access and keeps **Approve** and **Merge** hidden.

Environment variables: `BITBUCKET_TOKEN`, plus `BITBUCKET_EMAIL` for an API token.

### Where the token lives
Tokens are saved in your px0 settings file (`~/.px0/settings.json`, or `$XDG_CONFIG_HOME/px0/settings.json`) on the machine running px0, and can be changed under Settings (`Cmd/Ctrl+,`) → the forge's section. px0 sends a token only to the host it was set up for. Git gets the token through environment variables, never on the command line or in a URL.

---

## 3. Review

- **See the change in context.** The **Pull Request** view (in the activity bar) lists the files the PR changes under **Files Changed**; click one to open its diff against the PR's merge-base. Go to Definition (`F12`), Find References (`Shift+F12`), Quick Open and search all work across the whole repository, not just the diff.
- **Comment on a line.** In a PR file, right-click a line (or a selection) and choose **Add Review Comment**. Comments are drafts until you submit them, show as icons in the editor margin, and survive closing px0.
- **Read and reply to the discussion.** The **Comments** section shows the PR's conversation and inline threads; reply in place, or post a new comment.
- **Submit.** In **Your Review**, write an optional summary, then **Submit Review**, **Request Changes**, or **Approve**. Your drafts go with it. Approve and Request Changes appear when your token has push access.

---

## 4. Fix things yourself (optional)

The checkout is a real git worktree, and the Source Control view (`Ctrl/Cmd+Shift+G`) works in it:

- Edit a file and save it (`Ctrl/Cmd+S`).
- Stage, write a commit message, commit, then **Push**. The push goes to the PR's own branch, even when it comes from a fork.
- If someone pushes to the PR while you review, **Pull** brings their commits in.

---

## 5. Bring the PR up to date with its base

When the base branch has moved on, the **Merge** section says the PR can't merge (conflicts, or behind its base).

1. px0 fetches the base branch itself, with your forge token, into `refs/px0/base/<number>` in the checkout.
2. In a terminal in the checkout, merge it (or rebase onto it), resolving any conflicts there. Source Control shows a banner while the operation is in progress, with **Abort** to undo it.
3. Review the result, then **Push**. A merge is a normal push. A rebase rewrites the PR's commits and needs a force-push, which the editor's Push does not send; until the forge has the rewritten branch, **Merge** stays blocked.

While a rebase or merge is in progress, or local commits are unpushed, **Merge** waits. Otherwise it would act on the PR's old commits.

---

## 6. Merge

Open the **Merge** section of the Pull Request view:

1. Pick the method: **Create a merge commit**, **Squash and merge**, or **Rebase and merge**. Only the methods your repository allows are listed.
2. Edit the commit title and message (for a merge commit or a squash).
3. **Merge Pull Request**, and confirm. px0 merges exactly the commit you reviewed. If the PR changed since, the merge is refused and px0 asks you to pull first.

---

## Troubleshooting

| What you see | Why | What to do |
| :--- | :--- | :--- |
| *&lt;Forge&gt; didn't accept this token* when connecting | The token is wrong, expired, or lacks access to this repository. | Create a new one with the scopes listed in [step 2](#2-connect-your-forge). |
| *404 Not Found* while opening a private PR | No token, or the token can't see the repository. | Connect a token first (Settings, or an environment variable), then run px0 again. |
| No **Approve** / **Request Changes** / merge button | Your token lacks push access to the repository. On Bitbucket, an access token can't confirm push access. | Use a token from an account with write access. On Bitbucket, use an API token with your email. |
| A self-hosted GitLab or Gitea token isn't used | The token is saved for a different host. | Set **GitLab Host** / **Gitea Host** in Settings to your instance, or reconnect from the Pull Request view. |
| A newly connected token isn't in Settings | A token for another instance of the same forge is already saved, so px0 used the new one for this session only and kept the saved one. | Nothing, if that's what you want. To switch permanently, change the token and host in Settings. |
| The Merge section says the PR can't merge | Conflicts, branch protection (required approvals, checks, resolved threads), or a draft PR. | The section gives the forge's reason; meet the requirement on the forge. |
| The merge is refused although the Merge section said it could merge | On Gitea and Bitbucket, protection rules only show up when merging. | The error names the rule. |
| *The PR has new commits on the forge: pull them first.* | Someone pushed after you loaded the PR. | **Pull**, review the new commits, then merge. |
| A diff base warning in the Overview, empty diffs | px0 couldn't fetch the base branch. | Check that the token can read the repository, then **Pull** to retry. |

---

## Where next

- [Pull Request Review](github-pr-review.md): the full reference, including per-forge differences.
- [Git Integration](git-integration.md): the Source Control view in depth.
- [Settings & Configuration](settings-and-configuration.md): every setting, including the forge tokens.
