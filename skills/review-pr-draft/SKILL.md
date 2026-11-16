---
name: review-pr-draft
description: Review a GitHub PR as yourself, but leave the result as a PENDING (draft) review that only you can see — inline comments plus a summary with a suggested verdict — and never submit, approve or request changes. The user reads the draft on GitHub (or in the PR inbox widget) and submits it themselves. Use when the user says "draft a review of PR 36", "review-pr-draft 36", or a prompt from the PR inbox asks for a draft review. Usage - /review-pr-draft <PR number> [extra instructions]
---

Review someone else's pull request and leave a pending review for the user to check and submit. Nothing you do here is visible to the PR author.

## Input

- `<number>`: the PR number. If it is missing, use `gh pr view --json number` for the current branch. If that fails, ask the user.
- Anything after the number is extra instructions from the caller, for example "focus on what changed since commit abc123" for a re-check. Follow them.
- When the prompt names a repo other than the current folder's, add `--repo <owner>/<repo>` to every `gh` command and use that repo in API paths.

## 1. Gather context

```bash
gh pr view <n> --json number,title,author,body,headRefName,headRefOid,baseRefName,state,url,reviewDecision,files,commits
gh pr diff <n>
gh api user --jq .login                                    # who "I" am
gh api repos/{owner}/{repo}/pulls/<n>/comments --jq '.[]|"\(.user.login) \(.path):\(.line) :: \(.body[:300])"'
gh api repos/{owner}/{repo}/pulls/<n>/reviews --jq '.[]|{id,a:.user.login,s:.state,c:.commit_id,b:.body[:120]}'
```

- If the PR is closed or merged, or the author is you, stop and tell the user.
- Read the existing threads, from bots and humans, so you do not repeat a point that has been raised, fixed, or deliberately declined with a reason. Add to a thread only if you disagree with how it was settled, and say why.
- Read the linked ticket when the body links one. It holds the requirements the code is checked against.
- **Your own pending review.** GitHub allows one pending review per person per PR. Look for a review by you with state `PENDING`:
  - Its body contains `<!-- pr-inbox:` — it is an earlier draft from this skill. Delete it and create a fresh one in step 4: `gh api -X DELETE repos/{owner}/{repo}/pulls/<n>/reviews/<id>`.
  - Otherwise the user started it by hand. Do not touch it. Stop and tell the user that a pending review of theirs is already open on the PR.

## 2. Get the code without disturbing the working tree

```bash
git fetch -q origin pull/<n>/head:pr-<n>-review
git show pr-<n>-review:<path> > "$SCRATCH/<file>"        # scratchpad, never the user's checkout
```

Do not check out the branch in the user's working tree. It may have uncommitted changes. Use `git show`, or `git worktree add` if a build is needed.

## 3. Review

For each changed file, check correctness, edge cases (empty, one item, at the limits, null), error handling, security (secrets, injection, permissions), concurrency and time (time zones, DST), and how the change fits the surrounding code. Follow the repository's own review rules when it has them (for example a `CLAUDE.md` or a review-instructions file).

**Run the code before you claim a bug.** Run scripts with a dry-run flag or fixture input, build and run the tests, or write a small repro in the scratchpad. A finding you have run is far more credible than one you have only reasoned about. Mention what you ran in the review body.

Classify each finding:
- **Blocking**: incorrect behaviour, data loss, a security hole, a broken build or tests, or an unmet requirement from the ticket.
- **Non-blocking**: a nit, style, an optional improvement, or a hardening suggestion. Prefix the comment with `Nit, non-blocking:`.

Drop anything you cannot back up with a line of code or a repro. Leave out praise padding and comments restating what the code does.

## 4. Create ONE pending review with inline comments

Write the payload to a scratch JSON file and post it in one call. **Leave out `event`.** Without it, GitHub creates the review as `PENDING`: only the user can see it, nobody is notified, and it is not submitted.

```bash
gh api -X POST repos/{owner}/{repo}/pulls/<n>/reviews --input "$SCRATCH/review.json" --jq '{id,state,html_url}'
```

```json
{
  "commit_id": "<headRefOid>",
  "body": "> 🤖 Comment from Claude Code.\n\n<summary>\n\n<!-- pr-inbox: suggest=APPROVE -->",
  "comments": [
    { "path": "src/x.ps1", "line": 42, "side": "RIGHT", "body": "> 🤖 Comment from Claude Code.\n\n..." }
  ]
}
```

- Check that the response says `"state": "PENDING"`. If it says anything else, tell the user at once.
- **Never** call `submitPullRequestReview`, `gh pr review`, or the `/events` endpoint, and never send `event`. Submitting is the user's decision.
- Every body, the summary and each inline comment, starts with `> 🤖 Comment from Claude Code.` and a blank line, so readers can tell the text came from Claude once the user submits it.
- `line` is the line number in the **new** file (`side: RIGHT`). Get it with `git show pr-<n>-review:<path> | grep -n ...`. An inline comment must sit on a line inside a diff hunk, or the API returns 422. If a point concerns a line outside the hunks, put it in the summary.
- For a multi-line range, add `start_line` and `start_side`.
- A suggested fix goes in a ```` ```suggestion ```` block, and only when it is exact and complete.
- Each comment states the problem, gives a concrete scenario, and proposes a fix.
- With no findings at all, still create the pending review, with the summary only and no comments.

## 5. Suggested verdict

End the summary with exactly one hidden line the PR inbox widget reads:

| Findings | Line |
|---|---|
| None, or non-blocking only | `<!-- pr-inbox: suggest=APPROVE -->` |
| At least one blocking | `<!-- pr-inbox: suggest=REQUEST_CHANGES -->` |
| Unsure, or CI fails for a reason you cannot place | `<!-- pr-inbox: suggest=COMMENT -->` |

Do not suggest `APPROVE` when CI is failing (`gh pr checks <n>`) unless the failure clearly has nothing to do with the PR. Say so in the summary.

The summary opens with the suggested verdict in one plain line ("Suggest: approve" or "Suggest: request changes, 1 blocking issue"), then what you ran to verify, then any cross-file remarks.

## 6. Report and stop

Tell the user:
- the suggested verdict and why, in one or two sentences,
- one line per inline comment (`file:line`, what it says, blocking or not),
- the link to the PR's "Files changed" tab, where the pending comments show inline,
- that nothing has been submitted, and that they submit it themselves on GitHub or with Send in the PR inbox widget.

Then stop. Do not start a loop, do not resolve threads, and do not reply in existing threads.
