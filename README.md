# PR inbox

A small local widget that shows the GitHub pull requests waiting on you, and starts Claude Code sessions to review them.

It runs on your own machine: a Node server on `127.0.0.1:4477` talks to GitHub through your `gh` login, and the widget is a small Chrome or Edge app window. Nothing is sent anywhere else, and no token is stored by the tool.

## What it shows

**Reviews**
- Review requests to you and your teams, with CI status, merge-queue position and whether you already have a session for the PR.
- Replies to you in your unresolved review threads, and comments that @mention you.
- *Needs re-check*: PRs where new commits dismissed your approval.
- *Approved, not merged*: your approvals, with new commits since you approved and failing checks highlighted.
- *Older than 30 days*: anything untouched for 30 days, collapsed and left out of the counts.
- A repo filter when PRs come from more than one repo.

**My PRs**: your own open PRs with their review state, conflicts, failing checks and threads waiting on you, and below them the PRs you merged in the last 30 days.

**Stats**: PRs you created, merged and reviewed over 7, 30 and 90 days, and an optional comparison with your team.

## Buttons

- **Review** starts a Claude Code session for one PR, or opens the session you already have for it.
- **New N** reviews every PR without a session in parallel, one session each (drafts are left out).
- **Re-check / Re-check all** looks only at what changed since your last review and approves when nothing is blocking. Re-check all sends the prompt to the session that did the first review when there is one.
- **Address / Fix CI** (My PRs) runs `/address-pr-comments` or looks into a failing build.
- **Archive** archives sessions whose PR is merged or closed, plus finished batch helpers. **Delete** removes archived sessions that have not been used for 14 days. Both show a checkbox list first, and run in a Claude session you confirm with Enter.

The prompts use the `review-pr` and `address-pr-comments` skills. Without them in your Claude setup, Claude still gets the prompt, but works without the skill's instructions.

## Requirements

- Windows 10 or 11 (the widget scripts use PowerShell and Windows APIs)
- [Node.js](https://nodejs.org/) 18 or newer
- [GitHub CLI](https://cli.github.com/), logged in with `gh auth login`
- Google Chrome or Microsoft Edge
- The Claude desktop app with Claude Code, for the session buttons
- Local clones of the repos you review, in `C:\`, your home folder, `~\source\repos` or `~\repos` (one folder deep)

## Getting started

1. Clone this repo anywhere.
2. Optional: copy `config.example.json` to `config.json` and fill it in (see below).
3. Run `widget.cmd`, or `powershell -ExecutionPolicy Bypass -File widget.ps1`.
4. Optional: run `powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1` for a desktop shortcut and a Startup shortcut, so the widget starts when you log in. Pin it to the taskbar from the running widget's own taskbar icon.

`start.cmd` runs only the server and opens the full page at `http://localhost:4477` instead of the widget.

## Configuration

`config.json` is optional and git-ignored. Every key can be left out.

| Key | Default | What it does |
|---|---|---|
| `homeRepo` | the repo you have most PRs in | Its name is left off row labels, and sessions without a repo of their own start in its folder |
| `benchmarkTeam` | off | `org/team-slug` to compare your stats with, refreshed once a day |
| `cloneRoots` | `C:\`, home, `~\source\repos`, `~\repos` | Folders searched for local clones |
| `appId` | `PrInbox.Widget` | Windows taskbar identity of the widget |

## GitHub usage

Everything uses GitHub's GraphQL API, which allows 5,000 points an hour per user and is shared with your other `gh` use. The widget refreshes every minute and uses roughly 10 to 15 points a minute; replies, your own PRs and stats are cached longer, and the team comparison runs once a day. The footer shows how many points you have left.

## Files the tool writes

These live next to the code and are git-ignored: `seen.json` (replies you have checked), `benchmark.json` (the team comparison), `recheck-batch.json` (the last batch of re-check prompts) and `server.log`. The widget's own Chrome profile is in `%LOCALAPPDATA%\pr-inbox-widget`.
