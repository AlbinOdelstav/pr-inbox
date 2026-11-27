import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { readFile, readdir, open, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PR_INBOX_PORT ?? 4477);
const HOST = '127.0.0.1';
const CONFIG = (() => {
    try {
        return JSON.parse(readFileSync(path.join(here, 'config.json'), 'utf8'));
    } catch {
        return {};
    }
})();
const CLONE_ROOTS = CONFIG.cloneRoots ?? [path.parse(os.homedir()).root, os.homedir(), path.join(os.homedir(), 'source', 'repos'), path.join(os.homedir(), 'repos')];

function homeRepo() {
    if (CONFIG.homeRepo) return CONFIG.homeRepo.toLowerCase();
    const counts = new Map();
    for (const pr of [...lastRequested, ...approvedCache.approved, ...approvedCache.dismissed, ...(mineCache?.items ?? [])]) {
        const key = pr.repo.toLowerCase();
        if (clones?.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? [...(clones?.keys() ?? [])][0] ?? null;
}

async function defaultDir() {
    const all = await findClones();
    return all.get(homeRepo()) ?? [...all.values()][0];
}

const QUERY = `
query($q: String!, $me: String!) {
  viewer { login avatarUrl }
  search(query: $q, type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt updatedAt additions deletions changedFiles reviewDecision headRefOid
        author { login avatarUrl }
        repository { nameWithOwner }
        reviewRequests(first: 20) {
          nodes { requestedReviewer { __typename ... on User { login } ... on Team { name slug organization { login } } } }
        }
        commits(last: 50) { nodes { commit { oid parents { totalCount } statusCheckRollup { state } } } }
        myReviews: reviews(last: 20, author: $me) { nodes { state submittedAt commit { oid } } }
        myPending: reviews(states: [PENDING], first: 1) { nodes { id body createdAt url comments { totalCount } } }
        mergeQueueEntry { state position }
      }
    }
  }
}`;

const REPLIES_QUERY = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 20) {
    nodes {
      ... on PullRequest {
        number title url state isDraft reviewDecision mergedAt closedAt mergeQueueEntry { state position }
        repository { nameWithOwner } author { login avatarUrl }
        reviewThreads(first: 40) { nodes { isResolved path comments(first: 15) { nodes { author { __typename login avatarUrl } createdAt url } } } }
        reviews(last: 15) { nodes { author { login } submittedAt } }
        comments(last: 20) { nodes { author { __typename login avatarUrl } createdAt url body } }
      }
    }
  }
}`;
const APPROVED_QUERY = `
query($q: String!, $me: String!) {
  search(query: $q, type: ISSUE, first: 40) {
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt updatedAt additions deletions reviewDecision
        author { login avatarUrl }
        repository { nameWithOwner }
        mergeQueueEntry { state position }
        headRefOid
        commits(last: 50) { nodes { commit { oid parents { totalCount } statusCheckRollup { state } } } }
        latestOpinionatedReviews(first: 30) { nodes { author { login } state submittedAt commit { oid } } }
        myReviews: reviews(last: 20, author: $me) { nodes { state submittedAt commit { oid } } }
        myPending: reviews(states: [PENDING], first: 1) { nodes { id body createdAt url comments { totalCount } } }
      }
    }
  }
}`;
const MINE_QUERY = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 15) {
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt updatedAt reviewDecision mergeable additions deletions headRefName
        repository { nameWithOwner }
        mergeQueueEntry { state position }
        autoMergeRequest { enabledAt }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
        latestOpinionatedReviews(first: 20) { nodes { author { login avatarUrl } state } }
        reviewThreads(first: 30) { nodes { isResolved comments(last: 1) { nodes { author { login } } } } }
      }
    }
  }
}`;
const REPLIES_TTL = 110_000;
const SEEN_FILE = path.join(here, 'seen.json');

async function gh(args) {
    const { stdout } = await run('gh', args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    return stdout;
}

let myTeams = null;
async function getMyTeams() {
    if (myTeams) return myTeams;
    try {
        const out = await gh(['api', 'user/teams', '--paginate', '--jq', '.[] | .organization.login + "/" + .slug']);
        myTeams = new Set(out.split(/\r?\n/).filter(Boolean).map((s) => s.toLowerCase()));
    } catch {
        myTeams = new Set();
    }
    return myTeams;
}

let clones = null;
let cloneDirs = [];
async function findClones() {
    if (clones) return clones;
    const found = new Map();
    const dirs = [];
    for (const root of CLONE_ROOTS) {
        let entries = [];
        try {
            entries = await readdir(root, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(root, entry.name);
            const configPath = path.join(dir, '.git', 'config');
            if (!existsSync(configPath)) continue;
            try {
                const config = await readFile(configPath, 'utf8');
                const origin = config.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
                const slug = origin?.[1].match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]?.toLowerCase();
                if (!slug) continue;
                dirs.push({ dir, slug });
                const repoName = slug.split('/')[1];
                const current = found.get(slug);
                if (!current || (entry.name.toLowerCase() === repoName && path.basename(current).toLowerCase() !== repoName)) {
                    found.set(slug, dir);
                }
            } catch {
                // unreadable config, skip
            }
        }
    }
    clones = found;
    cloneDirs = dirs.sort((a, b) => b.dir.length - a.dir.length);
    return clones;
}

function repoForCwd(cwd) {
    const lower = cwd.toLowerCase();
    return cloneDirs.find(({ dir }) => lower === dir.toLowerCase() || lower.startsWith(dir.toLowerCase() + '\\'))?.slug ?? null;
}

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const HEAD_BYTES = 512 * 1024;
const INVOCATION = [
    /<command-name>\/review-pr(?:-draft)?<\/command-name>\\n<command-args>\s*(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/|#)?(\d+)/g,
    /"skill":"review-pr(?:-draft)?","args":"\s*(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/|#)?(\d+)/g,
    /"(?:content|text)":"\/review-pr(?:-draft)?\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/|#)?(\d+)/g,
];
const DESKTOP_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Claude-Data');
const desktopCache = new Map();

let allDesktopSessions = [];
const DELETE_AFTER_DAYS = 14;

async function findOldArchived() {
    await loadDesktopSessions();
    const cutoff = Date.now() - DELETE_AFTER_DAYS * 86_400_000;
    return allDesktopSessions
        .filter((s) => s.isArchived && s.id && s.lastActive < cutoff)
        .sort((a, b) => a.lastActive - b.lastActive)
        .map((s) => ({ id: s.id, title: s.title, lastActive: new Date(s.lastActive).toISOString() }));
}

function pickChosen(candidates, ids) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every((id) => typeof id === 'string')) {
        throw Object.assign(new Error('Choose at least one session'), { status: 400 });
    }
    const wanted = new Set(ids);
    return candidates.filter((s) => wanted.has(s.id));
}

async function launchDeleteOldArchived(ids) {
    const old = pickChosen(await findOldArchived(), ids);
    if (!old.length) throw Object.assign(new Error(`No archived sessions older than ${DELETE_AFTER_DAYS} days`), { status: 404 });
    const dir = await defaultDir();
    const list = old.map((s) => `${s.id} ("${s.title || 'untitled'}", last used ${s.lastActive.slice(0, 10)})`).join('; ');
    const prompt = `Permanently delete these ${old.length} archived Claude Code sessions, which have not been used for at least ${DELETE_AFTER_DAYS} days: ${list}. `
        + 'Use delete_session for each one. Before deleting, check with get_session that each is still archived and skip any that is not. '
        + 'Delete only the sessions listed here and nothing else. Then list what you deleted and what you skipped, and stop.';
    openInClaudeApp(`claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(dir)}`);
    return { count: old.length };
}

async function loadDesktopSessions() {
    const byCliId = new Map();
    const files = [];
    try {
        for (const profile of await readdir(DESKTOP_DATA)) {
            const root = path.join(DESKTOP_DATA, profile, 'claude-code-sessions');
            for (const account of await readdir(root).catch(() => [])) {
                for (const org of await readdir(path.join(root, account)).catch(() => [])) {
                    const dir = path.join(root, account, org);
                    for (const name of await readdir(dir).catch(() => [])) {
                        if (/^local_[\w-]+\.json$/.test(name)) files.push(path.join(dir, name));
                    }
                }
            }
        }
    } catch {
        return byCliId;
    }
    const all = [];
    await Promise.all(files.map(async (file) => {
        try {
            const { mtimeMs } = await stat(file);
            let cached = desktopCache.get(file);
            if (!cached || cached.mtimeMs !== mtimeMs) {
                const s = JSON.parse(await readFile(file, 'utf8'));
                cached = {
                    mtimeMs,
                    session: {
                        id: s.sessionId,
                        cliId: s.cliSessionId,
                        title: s.title ?? '',
                        cwd: s.cwd,
                        isArchived: !!s.isArchived,
                        lastActive: s.lastActivityAt ?? mtimeMs,
                        parent: s.spawnedFrom?.sessionId ?? null,
                    },
                };
                desktopCache.set(file, cached);
            }
            if (cached.session.cliId) byCliId.set(cached.session.cliId, cached.session);
            all.push(cached.session);
        } catch {
            // record being rewritten, skip this round
        }
    }));
    allDesktopSessions = all;
    return byCliId;
}
const transcriptCache = new Map();

function normalizeCwd(raw) {
    const cwd = JSON.parse(`"${raw}"`);
    const msys = cwd.match(/^\/([a-z])\/(.*)$/i);
    return msys ? `${msys[1].toUpperCase()}:\\${msys[2].replace(/\//g, '\\')}` : cwd;
}

async function readHead(file) {
    const handle = await open(file, 'r');
    try {
        const buffer = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
        return buffer.toString('utf8', 0, bytesRead);
    } finally {
        await handle.close();
    }
}

const HELPERS = [
    { kind: 'coordinator', pattern: /^I want (?:these )?\d+ PRs (?:reviewed|re-checked) in parallel/ },
    { kind: 'archiver', pattern: /^Archive these \d+ Claude Code sessions/ },
    { kind: 'deleter', pattern: /^Permanently delete these \d+ archived Claude Code sessions/ },
    { kind: 'relay', pattern: /^Relay only, do not do any of the work here/ },
    { kind: 'dispatcher', pattern: /^(?:\/loop \S+ )?You are the PR inbox dispatcher/ },
];

function firstUserText(head) {
    for (const line of head.split('\n')) {
        if (!line.includes('"type":"user"')) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type !== 'user' || entry.isMeta) continue;
        const content = entry.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.find((c) => c.type === 'text')?.text : null;
        if (text) return text.trim();
    }
    return '';
}

async function parseTranscript(file) {
    const head = await readHead(file);
    const helper = HELPERS.find((h) => h.pattern.test(firstUserText(head)))?.kind ?? null;
    if (helper) return { prs: [], helper };
    const cwdMatch = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    if (!cwdMatch) return { prs: [], helper: null };
    const cwd = normalizeCwd(cwdMatch[1]);
    const prs = [];
    for (const pattern of INVOCATION) {
        for (const m of head.matchAll(pattern)) {
            const seen = head.match(new RegExp(`github\\.com/([\\w.-]+/[\\w.-]+)/pull/${m[2]}(?!\\d)`));
            const repo = (m[1] ?? seen?.[1] ?? repoForCwd(cwd))?.toLowerCase();
            if (repo) prs.push({ repo, number: Number(m[2]) });
        }
    }
    return { prs: prs.map((pr) => ({ ...pr, cwd })), helper: null };
}

function prFromTitle(title, cwd) {
    const plain = title.match(/\bPR\b\D{0,10}#?(\d{2,6})\b/i);
    const named = title.match(/\b([\w.-]+)\s*(?:PR\s*)?#(\d{1,6})\b/i) ?? title.match(/\b([\w.-]+)\s+PR\s+#?(\d{1,6})\b/i);
    if (named && !/^(review|re-review|pr)$/i.test(named[1])) {
        const slug = cloneDirs.find(({ slug }) => slug.split('/')[1] === named[1].toLowerCase())?.slug;
        if (slug) return { repo: slug, number: Number(named[2]) };
    }
    const repo = plain && repoForCwd(cwd);
    return repo ? { repo, number: Number(plain[1]) } : null;
}

let lastAllSessions = new Map();
let helperByCli = new Map();

async function findReviewSessions() {
    await findClones();
    const desktop = await loadDesktopSessions();
    const sessions = new Map();
    const every = new Map();
    lastAllSessions = every;
    const offer = (key, candidate) => {
        if (candidate.kind === 'desktop') {
            if (!every.has(key)) every.set(key, new Map());
            every.get(key).set(candidate.id, candidate);
        }
        const current = sessions.get(key);
        if (!current || current.lastActive < candidate.lastActive) sessions.set(key, candidate);
    };
    const helpers = new Map();
    for (const s of desktop.values()) {
        const pr = !s.isArchived && s.cwd && s.title ? prFromTitle(s.title, s.cwd) : null;
        if (pr) offer(`${pr.repo}#${pr.number}`, { kind: 'desktop', id: s.id, cwd: s.cwd, title: s.title, lastActive: s.lastActive });
    }
    let projects = [];
    try {
        projects = await readdir(PROJECTS_DIR, { withFileTypes: true });
    } catch {
        return sessions;
    }
    await Promise.all(projects.filter((p) => p.isDirectory()).map(async (project) => {
        const dir = path.join(PROJECTS_DIR, project.name);
        let files = [];
        try {
            files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
        } catch {
            return;
        }
        for (const name of files) {
            const file = path.join(dir, name);
            try {
                const { mtimeMs, size } = await stat(file);
                let cached = transcriptCache.get(file);
                if (!cached || cached.mtimeMs !== mtimeMs || cached.size !== size) {
                    cached = { mtimeMs, size, ...(await parseTranscript(file)) };
                    transcriptCache.set(file, cached);
                }
                const cliId = path.basename(name, '.jsonl');
                const owner = desktop.get(cliId);
                if (owner?.isArchived) continue;
                if (cached.helper) {
                    if (owner) helpers.set(cliId, cached.helper);
                    continue;
                }
                for (const pr of cached.prs) {
                    const key = `${pr.repo}#${pr.number}`;
                    offer(key, owner
                        ? { kind: 'desktop', id: owner.id, cwd: owner.cwd, title: owner.title, lastActive: Math.max(owner.lastActive, mtimeMs) }
                        : { kind: 'cli', id: cliId, cwd: pr.cwd, lastActive: mtimeMs });
                }
            } catch {
                // transcript vanished or unreadable, skip
            }
        }
    }));
    for (const [key, session] of sessions) {
        if (session.kind === 'cli' && !existsSync(session.cwd)) sessions.delete(key);
    }
    helperByCli = helpers;
    return sessions;
}

function pendingInfo(pr) {
    const node = pr.myPending?.nodes?.[0];
    if (!node) return null;
    const suggest = node.body?.match(/pr-inbox: suggest=(APPROVE|REQUEST_CHANGES|COMMENT)/)?.[1] ?? null;
    return { id: node.id, reviewUrl: node.url, createdAt: node.createdAt, comments: node.comments.totalCount, suggest, fromInbox: /pr-inbox:/.test(node.body ?? '') };
}

function allPending() {
    const seen = new Set();
    const out = [];
    for (const pr of [...lastRequested, ...approvedCache.approved, ...approvedCache.dismissed]) {
        const key = `${pr.repo.toLowerCase()}#${pr.number}`;
        if (!pr.pending || seen.has(key)) continue;
        seen.add(key);
        out.push({ repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, author: pr.author, localClone: pr.localClone ?? null, ...pr.pending });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const SUBMIT_EVENTS = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];
async function submitPending(repo, number, event) {
    if (!SUBMIT_EVENTS.includes(event)) throw Object.assign(new Error('Unknown verdict'), { status: 400 });
    const key = `${String(repo).toLowerCase()}#${number}`;
    const item = allPending().find((p) => `${p.repo.toLowerCase()}#${p.number}` === key);
    if (!item) throw Object.assign(new Error(`No pending review on #${number}; refresh and try again`), { status: 404 });
    const out = await gh(['api', 'graphql',
        '-f', 'query=mutation($id: ID!, $event: PullRequestReviewEvent!) { submitPullRequestReview(input: { pullRequestReviewId: $id, event: $event }) { pullRequestReview { state url } } }',
        '-f', `id=${item.id}`, '-f', `event=${event}`]);
    const review = JSON.parse(out).data.submitPullRequestReview.pullRequestReview;
    for (const pr of [...lastRequested, ...approvedCache.approved, ...approvedCache.dismissed]) {
        if (`${pr.repo.toLowerCase()}#${pr.number}` === key) pr.pending = null;
    }
    return { state: review.state, url: review.url };
}

function rereviewInfo(pr) {
    const reviews = pr.myReviews.nodes.filter((r) => r.state !== 'PENDING' && r.submittedAt);
    if (!reviews.length) return null;
    const last = reviews.at(-1);
    const opinion = [...reviews].reverse().find((r) => r.state !== 'COMMENTED') ?? last;
    const previous = opinion.state === 'DISMISSED' || opinion.state === 'APPROVED' ? 'approved'
        : opinion.state === 'CHANGES_REQUESTED' ? 'changes' : 'commented';
    const commits = pr.commits.nodes.map((n) => n.commit);
    const baseOid = last.commit?.oid ?? null;
    const at = baseOid ? commits.findIndex((c) => c.oid === baseOid) : -1;
    const after = at >= 0 ? commits.slice(at + 1) : null;
    return {
        previous,
        reviewedAt: last.submittedAt,
        baseOid,
        headOid: pr.headRefOid,
        rewritten: baseOid !== pr.headRefOid && at < 0,
        commits: after ? after.filter((c) => c.parents.totalCount < 2).length : null,
        merges: after ? after.filter((c) => c.parents.totalCount >= 2).length : null,
    };
}

async function fetchPrs() {
    const login = await viewerLogin();
    const [raw, teams, localClones, sessions] = await Promise.all([
        gh(['api', 'graphql', '-f', `query=${QUERY}`, '-f', 'q=is:pr is:open archived:false review-requested:@me sort:updated-desc', '-f', `me=${login}`]),
        getMyTeams(),
        findClones(),
        findReviewSessions(),
    ]);
    const { data } = JSON.parse(raw);
    const me = data.viewer.login.toLowerCase();

    const prs = data.search.nodes
        .filter((n) => n && n.number)
        .map((pr) => {
            const requested = pr.reviewRequests.nodes.map((n) => n.requestedReviewer).filter(Boolean);
            const direct = requested.some((r) => r.__typename === 'User' && r.login.toLowerCase() === me);
            const allTeams = requested.filter((r) => r.__typename === 'Team');
            const mine = allTeams.filter((t) => teams.has(`${t.organization.login}/${t.slug}`.toLowerCase()));
            const viaTeams = (mine.length ? mine : allTeams).map((t) => t.name);
            const repo = pr.repository.nameWithOwner;
            return {
                number: pr.number,
                title: pr.title,
                url: pr.url,
                repo,
                isDraft: pr.isDraft,
                createdAt: pr.createdAt,
                updatedAt: pr.updatedAt,
                additions: pr.additions,
                deletions: pr.deletions,
                changedFiles: pr.changedFiles,
                reviewDecision: pr.reviewDecision,
                checks: pr.commits.nodes.at(-1)?.commit.statusCheckRollup?.state ?? null,
                queue: pr.mergeQueueEntry ? { state: pr.mergeQueueEntry.state, position: pr.mergeQueueEntry.position } : null,
                rereview: rereviewInfo(pr),
                pending: pendingInfo(pr),
                author: pr.author ? { login: pr.author.login, avatarUrl: pr.author.avatarUrl } : null,
                direct,
                viaTeams: direct ? [] : viaTeams,
                localClone: localClones.get(repo.toLowerCase()) ?? null,
                session: sessionSummary(sessions.get(`${repo.toLowerCase()}#${pr.number}`)),
            };
        });

    lastRequested = prs;
    lastFetchAt = Date.now();
    return { viewer: data.viewer.login, viewerAvatar: data.viewer.avatarUrl, fetchedAt: new Date().toISOString(), prs };
}

const AUTO_FILE = path.join(here, 'auto.json');
const AUTO_STALE_MS = 15 * 60_000;
const AUTO_MAX_AGE_MS = 30 * 86_400_000;
let autoState = (() => {
    try {
        return JSON.parse(readFileSync(AUTO_FILE, 'utf8'));
    } catch {
        return { enabled: false };
    }
})();
autoState.known ??= [];
autoState.queued ??= {};
autoState.started ??= {};

async function saveAuto() {
    await writeFile(AUTO_FILE, JSON.stringify(autoState, null, 2));
}

const prKey = (pr) => `${pr.repo.toLowerCase()}#${pr.number}`;

function autoEligible(pr) {
    return !pr.isDraft && !pr.queue && !pr.session && !pr.pending && !!pr.localClone
        && !(pr.updatedAt && Date.now() - new Date(pr.updatedAt) > AUTO_MAX_AGE_MS);
}

async function autoTick(requested) {
    if (!autoState.enabled) return;
    const known = new Set(autoState.known);
    let changed = false;
    for (const pr of requested) {
        const key = prKey(pr);
        if (known.has(key)) continue;
        known.add(key);
        changed = true;
        if (autoEligible(pr)) autoState.queued[key] = new Date().toISOString();
    }
    for (const key of Object.keys(autoState.queued)) {
        const pr = requested.find((p) => prKey(p) === key);
        if (!pr || !autoEligible(pr)) {
            delete autoState.queued[key];
            changed = true;
        }
    }
    if (changed) {
        autoState.known = [...known];
        await saveAuto();
    }
}

const HEARTBEAT_STALE_MS = 5 * 60_000;
let lastFetchAt = 0;
const CLAIM_MS = 10 * 60_000;
let lastHeartbeat = null;
autoState.claimed ??= {};

function autoStatus() {
    return {
        enabled: !!autoState.enabled,
        since: autoState.since ?? null,
        lastPoll: lastHeartbeat ?? autoState.lastPoll ?? null,
        queued: Object.keys(autoState.queued).length,
        dispatcherStale: !!autoState.enabled && (!lastHeartbeat || Date.now() - new Date(lastHeartbeat) > HEARTBEAT_STALE_MS),
    };
}

function unclaimed() {
    return Object.keys(autoState.queued).filter((key) => {
        const claimed = autoState.claimed[key];
        return !claimed || Date.now() - new Date(claimed) > CLAIM_MS;
    });
}

function autoHeartbeat() {
    lastHeartbeat = new Date().toISOString();
    const count = autoState.enabled ? unclaimed().length : 0;
    return { enabled: !!autoState.enabled, count, wake: !autoState.enabled || count > 0 };
}

async function setAuto(enabled) {
    if (enabled && !autoState.enabled) {
        if (!lastRequested.length) await fetchPrs();
        autoState = { enabled: true, since: new Date().toISOString(), known: lastRequested.map(prKey), queued: {}, claimed: {}, started: autoState.started ?? {} };
        await saveAuto();
        if (autoStatus().dispatcherStale) await openDispatcher();
    } else if (!enabled && autoState.enabled) {
        autoState.enabled = false;
        autoState.queued = {};
        autoState.claimed = {};
        await saveAuto();
    }
    return autoStatus();
}

async function autoQueue(dry, current) {
    if (!current || !autoState.enabled) return { enabled: false, items: [] };
    const items = [];
    for (const key of unclaimed()) {
        const pr = lastRequested.find((p) => prKey(p) === key);
        if (!pr) continue;
        if (!dry) autoState.claimed[key] = new Date().toISOString();
        let prompt = `/review-pr-draft ${pr.number}`;
        if (pr.rereview) {
            try { prompt = (await buildRecheck(pr.repo, pr.number)).prompt; } catch { /* plain draft review then */ }
        }
        items.push({ key, title: `Review ${repoShort(pr.repo)}#${pr.number}`, folder: pr.localClone, prompt });
    }
    if (!dry && items.length) await saveAuto();
    return { enabled: true, items };
}

async function autoMarkStarted(keys) {
    for (const key of keys) {
        if (typeof key !== 'string' || !autoState.queued[key]) continue;
        delete autoState.queued[key];
        delete autoState.claimed[key];
        autoState.started[key] = new Date().toISOString();
    }
    await saveAuto();
    return autoStatus();
}

const repoShort = (repo) => repo.split('/')[1];

async function openDispatcher() {
    const dir = await defaultDir();
    if (!dir) throw Object.assign(new Error('No local clone found to run the dispatcher in'), { status: 404 });
    const base = `http://127.0.0.1:${PORT}`;
    const wait = `while :; do r=$(curl -s ${base}/api/auto/heartbeat); case "$r" in *'"wake":true'*) echo "$r"; break;; esac; sleep 60; done`;
    const prompt = 'You are the PR inbox dispatcher. Do not review anything in this session, and keep every turn short. '
        + `Step 1, waiting: run this exact command with the Bash tool and run_in_background set to true, then end your turn without polling it: ${wait} `
        + 'It costs no tokens while it waits, and it finishes only when there is work or Auto was switched off. '
        + `Step 2, when it finishes: if its output says "enabled":false, say that Auto was switched off and stop, without starting the wait again. `
        + `Otherwise fetch ${base}/api/auto/queue?v=2 with curl. It returns JSON with "items", each with "key", "title", "folder" and "prompt". `
        + 'For each item, start a new session with start_session: initiation "user_asked", context "fresh", use_worktree false, the item\'s "title" as title, cwd set to the item\'s "folder" only when it is not this session\'s folder, and exactly the item\'s "prompt" as prompt. '
        + `Then tell the server which ones started, in one call: curl -s -X POST -H "Content-Type: application/json" -d '{"keys":["<key>", ...]}' ${base}/api/auto/started. `
        + 'Then go back to step 1. '
        + 'Never start anything that is not in the queue, and never archive, message or change any other session.';
    openInClaudeApp(`claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(dir)}`);
    return { opened: true };
}

let lastRequested = [];
async function launchRecheck(repo, number, dry = false) {
    const { prompt, dir, key, replies, session } = await buildRecheck(repo, number);
    if (dry) return { relay: !!session, url: session ? relayUrl(session, `${prompt} You reviewed this PR earlier in this session, so build on what you found then.`, dir) : null };
    if (session) {
        openInClaudeApp(relayUrl(session, `${prompt} You reviewed this PR earlier in this session, so build on what you found then.`, dir));
    } else {
        openInClaudeApp(`claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(dir)}`);
    }
    if (replies) await forgetReplies(key);
    return { dir, resumed: !!session, sessionTitle: session?.title ?? null };
}

async function forgetReplies(key) {
    await markSeen(key);
    if (repliesCache) repliesCache.items = repliesCache.items.filter((r) => `${r.repo.toLowerCase()}#${r.number}` !== key);
}

const BATCH_FILE = path.join(here, 'recheck-batch.json');
async function launchRecheckAll(prs, dry = false) {
    const built = [];
    for (const pr of prs) {
        try {
            built.push(await buildRecheck(pr.repo, pr.number));
        } catch {
            // no longer needs a re-check, or no clone: skip it
        }
    }
    if (!built.length) throw Object.assign(new Error('Nothing to re-check; refresh and try again'), { status: 400 });
    const counts = new Map();
    for (const b of built) counts.set(b.dir, (counts.get(b.dir) ?? 0) + 1);
    const folder = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const entries = built.map((b) => ({
        pr: b.key,
        folder: b.dir,
        ...(b.session ? { session: b.session.id, sessionTitle: b.session.title } : {}),
        prompt: b.session
            ? `${b.prompt} You reviewed this PR earlier in this session, so build on what you found then.`
            : b.prompt,
    }));
    const reused = entries.filter((e) => e.session).length;
    if (dry) return { count: built.length, reused, skipped: prs.length - built.length, folder, entries };
    await writeFile(BATCH_FILE, JSON.stringify(entries, null, 2));
    const prompt = `I want ${built.length} PRs re-checked in parallel. Do not re-check any of them here. `
        + `Read ${BATCH_FILE}: it is a JSON list of entries with "pr", "folder", "prompt" and, for a PR that already has a review session, "session". `
        + 'For an entry with "session", send its "prompt" to that session with SendMessage (to set to the session id), so the re-check runs there with the context of the first review; do not start a new session for it. '
        + 'If that session is archived or the message cannot be delivered, start a new session for the entry instead. '
        + 'For an entry without "session", start a new session right away with start_session (initiation "user_asked", context "fresh", use_worktree false, '
        + `and cwd set to the entry's folder only when it is not ${folder}), whose prompt is exactly the entry's "prompt". `
        + 'When all are sent or started, list each PR with a link to the session that is re-checking it, say which were new, and stop.';
    openInClaudeApp(`claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(folder)}`);
    for (const b of built) if (b.replies) await forgetReplies(b.key);
    return { count: built.length, reused, skipped: prs.length - built.length };
}

async function buildRecheck(repo, number) {
    const key = `${String(repo).toLowerCase()}#${number}`;
    const same = (p) => `${p.repo.toLowerCase()}#${p.number}` === key;
    const requested = lastRequested.find(same);
    const approved = approvedCache.approved.find(same) ?? approvedCache.dismissed.find(same);
    const replies = repliesCache?.items.find(same) ?? null;
    const info = requested?.rereview ?? approved?.review ?? null;
    if (!info && !replies) throw Object.assign(new Error(`Nothing to re-check on #${number}; refresh and try again`), { status: 400 });
    const clones = await findClones();
    const dir = clones.get(String(repo).toLowerCase());
    if (!dir) throw Object.assign(new Error(`No local clone of ${repo} found`), { status: 404 });

    const draft = autoState.enabled;
    const parts = [draft ? `/review-pr-draft ${number} Re-check this PR.` : `Re-check PR ${number} with the review-pr skill.`];
    if (info) {
        const before = info.previous === 'approved' ? 'approved it' : info.previous === 'changes' ? 'requested changes' : 'left a review';
        const base = info.baseOid?.slice(0, 12);
        const head = info.headOid?.slice(0, 12);
        const why = requested?.rereview ? 'and my review was requested again after new changes.'
            : approvedCache.dismissed.find(same) ? 'and my approval was dismissed by new commits.'
            : 'and new commits were pushed after my approval.';
        parts.push(`I ${before} at commit ${base ?? 'unknown'} on ${info.reviewedAt.slice(0, 10)}, ${why}`);
        parts.push(info.rewritten || !base
            ? `The branch was rewritten since then, so my old commit${base ? ` ${base}` : ''} may be gone: compare the current diff against what I reviewed as best you can.`
            : info.commits === 0 && info.merges > 0
                ? `The only commits since then are merges of the base branch (${base}..${head}), so check that the merge brought in nothing that changes this PR's own diff.`
                : `Look at what changed since then: ${base}..${head}.`);
        parts.push('Do not redo the whole review: focus on the new changes and on whether my earlier comments still hold.');
    }
    parts.push(replies
        ? `There ${replies.count === 1 ? 'is 1 reply' : `are ${replies.count} replies`} to me since then, in my unresolved review threads or comments mentioning me: go through them first and show me the answers you would post before posting any.`
        : 'Also check whether anyone answered my review threads or mentioned me, and address that first if so.');
    parts.push(draft
        ? 'Leave the result as a pending review with a suggested verdict, and do not submit it. Do not post replies in threads either; put what you would answer in the pending review or in your report to me.'
        : 'If you find nothing blocking and nothing that needs my answer, approve the PR. Otherwise tell me what you found before posting anything.');
    const found = (await findReviewSessions()).get(key);
    const session = found?.kind === 'desktop' ? { id: found.id, title: found.title } : null;
    return { prompt: parts.join(' '), dir, key, replies: !!replies, session };
}

function relayUrl(session, message, dir) {
    const prompt = `Relay only, do not do any of the work here. Send the message below, exactly as written, to the session "${session.title}" `
        + `with SendMessage (to set to ${session.id}). If it cannot be delivered, tell me why and stop. `
        + 'When it is delivered, archive this session with archive_session (use get_session "self" for its id) and stop.\n\n'
        + `Message:\n${message}`;
    return `claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(dir)}`;
}

function copyToClipboard(text) {
    return new Promise((resolve, reject) => {
        const b64 = Buffer.from(text, 'utf8').toString('base64');
        const p = spawn('powershell', ['-NoProfile', '-Command', `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`], { windowsHide: true });
        p.on('error', reject);
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Could not copy the prompt'))));
    });
}

let seen = null;
async function getSeen() {
    if (!seen) {
        try { seen = JSON.parse(await readFile(SEEN_FILE, 'utf8')); } catch { seen = {}; }
    }
    return seen;
}
async function markSeen(key) {
    (await getSeen())[key] = new Date().toISOString();
    await writeFile(SEEN_FILE, JSON.stringify(seen, null, 2));
}

let repliesCache = null;
async function fetchReplies(force) {
    if (!force && repliesCache && Date.now() - repliesCache.at < REPLIES_TTL) return repliesCache.items;
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const [raw, seenAt] = await Promise.all([
        gh(['api', 'graphql', '-f', `query=${REPLIES_QUERY}`, '-f', `q=is:pr archived:false involves:@me -author:@me updated:>=${recent} sort:updated-desc`]),
        getSeen(),
    ]);
    const me = (await viewerLogin()).toLowerCase();
    const isMe = (a) => a?.login?.toLowerCase() === me;
    const human = (a) => a && a.__typename !== 'Bot' && !isMe(a);
    const items = [];
    for (const pr of JSON.parse(raw).data.search.nodes) {
        if (!pr?.number) continue;
        const key = `${pr.repository.nameWithOwner.toLowerCase()}#${pr.number}`;
        const since = seenAt[key] ?? '';
        const replies = [];
        let threads = 0;
        for (const t of pr.reviewThreads.nodes) {
            if (t.isResolved) continue;
            const c = t.comments.nodes;
            const mine = c.map((x) => isMe(x.author)).lastIndexOf(true);
            if (mine < 0) continue;
            const later = c.slice(mine + 1).filter((x) => human(x.author) && x.createdAt > since);
            if (later.length) threads++;
            replies.push(...later);
        }
        const myLast = [
            ...pr.reviews.nodes.filter((r) => isMe(r.author)).map((r) => r.submittedAt),
            ...pr.comments.nodes.filter((c) => isMe(c.author)).map((c) => c.createdAt),
        ].filter(Boolean).sort().at(-1);
        const mention = new RegExp(`(^|[^\\w-])@${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i');
        replies.push(...pr.comments.nodes.filter((c) => human(c.author) && mention.test(c.body ?? '')
            && (!myLast || c.createdAt > myLast) && c.createdAt > since));
        if (!replies.length) continue;
        replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const last = replies.at(-1);
        const from = [...new Set(replies.map((r) => r.author.login))];
        const status = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.mergeQueueEntry ? 'queued' : pr.isDraft ? 'draft' : 'open';
        items.push({
            repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url,
            count: replies.length, threads, from, status, actionable: status === 'open' || status === 'draft',
            reviewDecision: pr.reviewDecision, queue: pr.mergeQueueEntry ? { state: pr.mergeQueueEntry.state, position: pr.mergeQueueEntry.position } : null,
            last: { login: last.author.login, avatarUrl: last.author.avatarUrl, at: last.createdAt, url: last.url },
        });
    }
    items.sort((a, b) => b.last.at.localeCompare(a.last.at));
    repliesCache = { at: Date.now(), items };
    return items;
}

const MERGED_DAYS = 30;
const MERGED_TTL = 10 * 60_000;
let mergedCache = null;
async function fetchMerged(force) {
    if (!force && mergedCache && Date.now() - mergedCache.at < MERGED_TTL) return mergedCache.items;
    const since = new Date(Date.now() - MERGED_DAYS * 86_400_000).toISOString().slice(0, 10);
    const query = 'query($q: String!) { search(query: $q, type: ISSUE, first: 100) { nodes { ... on PullRequest { '
        + 'number title url mergedAt additions deletions repository { nameWithOwner } } } } }';
    const raw = await gh(['api', 'graphql', '-f', `query=${query}`, '-f', `q=is:pr author:@me is:merged merged:>=${since} sort:updated-desc`]);
    const items = JSON.parse(raw).data.search.nodes.filter((pr) => pr?.number).map((pr) => ({
        number: pr.number, title: pr.title, url: pr.url, repo: pr.repository.nameWithOwner,
        mergedAt: pr.mergedAt, additions: pr.additions, deletions: pr.deletions,
    })).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
    mergedCache = { at: Date.now(), items };
    return items;
}

let mineCache = null;
async function fetchMine(force) {
    if (force || !mineCache || Date.now() - mineCache.at >= REPLIES_TTL) {
        const [raw, me] = await Promise.all([
            gh(['api', 'graphql', '-f', `query=${MINE_QUERY}`, '-f', 'q=is:pr is:open archived:false author:@me sort:updated-desc']),
            viewerLogin(),
        ]);
        const isMe = (login) => login?.toLowerCase() === me.toLowerCase();
        const items = JSON.parse(raw).data.search.nodes.filter((pr) => pr?.number).map((pr) => {
            const reviews = pr.latestOpinionatedReviews.nodes.filter((r) => r.author && !isMe(r.author.login));
            const open = pr.reviewThreads.nodes.filter((t) => !t.isResolved);
            return {
                number: pr.number, title: pr.title, url: pr.url, repo: pr.repository.nameWithOwner, branch: pr.headRefName,
                isDraft: pr.isDraft, createdAt: pr.createdAt, updatedAt: pr.updatedAt,
                additions: pr.additions, deletions: pr.deletions,
                reviewDecision: pr.reviewDecision, mergeable: pr.mergeable,
                checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
                queue: pr.mergeQueueEntry ? { state: pr.mergeQueueEntry.state, position: pr.mergeQueueEntry.position } : null,
                autoMerge: !!pr.autoMergeRequest,
                waitingOn: pr.reviewRequests.nodes.map((n) => n.requestedReviewer).filter(Boolean).map((r) => r.login ?? r.name),
                approvedBy: reviews.filter((r) => r.state === 'APPROVED').map((r) => ({ login: r.author.login, avatarUrl: r.author.avatarUrl })),
                changesBy: reviews.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => ({ login: r.author.login, avatarUrl: r.author.avatarUrl })),
                unresolved: open.length,
                awaitingMe: open.filter((t) => !isMe(t.comments.nodes[0]?.author?.login)).length,
            };
        });
        mineCache = { at: Date.now(), items };
    }
    const [sessions, clones] = await Promise.all([findReviewSessions(), findClones()]);
    return mineCache.items.map((pr) => ({
        ...pr,
        localClone: clones.get(pr.repo.toLowerCase()) ?? null,
        session: sessionSummary(ownSession(pr) ?? sessions.get(`${pr.repo.toLowerCase()}#${pr.number}`)),
    }));
}

function ownSession(pr) {
    const branch = pr.branch?.toLowerCase();
    const ticket = (pr.branch?.match(/^[A-Z]+-\d+/i) ?? pr.title.match(/\b[A-Z]+-\d+/))?.[0].toLowerCase();
    const live = allDesktopSessions.filter((s) => !s.isArchived && s.id && s.title);
    const pick = (list) => list.sort((a, b) => b.lastActive - a.lastActive)[0];
    const exact = pick(live.filter((s) => s.title.toLowerCase() === branch));
    const byTicket = ticket && pick(live.filter((s) => s.title.toLowerCase().startsWith(`${ticket}-`) || s.title.toLowerCase().startsWith(`${ticket}:`) || s.title.toLowerCase() === ticket));
    const found = exact ?? byTicket;
    return found ? { kind: 'desktop', id: found.id, cwd: found.cwd, title: found.title, lastActive: found.lastActive } : null;
}

async function launchMineAction(repo, number, action) {
    const key = `${String(repo).toLowerCase()}#${number}`;
    const pr = mineCache?.items.find((p) => `${p.repo.toLowerCase()}#${p.number}` === key);
    if (!pr) throw Object.assign(new Error(`#${number} is not one of your open PRs; refresh and try again`), { status: 400 });
    await loadDesktopSessions();
    const found = ownSession(pr) ?? (await findReviewSessions()).get(key);
    if (action === 'open') {
        if (!found) throw Object.assign(new Error(`No session found for #${number}`), { status: 404 });
        openInClaudeApp(found.kind === 'desktop'
            ? `claude://claude.ai/epitaxy/${encodeURIComponent(found.id)}`
            : `claude://resume?session=${encodeURIComponent(found.id)}`);
        return { resumed: true, opened: true };
    }
    const dir = (await findClones()).get(String(repo).toLowerCase());
    if (!dir) throw Object.assign(new Error(`No local clone of ${repo} found`), { status: 404 });
    const prompt = action === 'address'
        ? `/address-pr-comments ${number}`
        : `CI is failing on my PR ${number}. Find out which checks fail and why, and fix what is caused by this PR. Tell me before pushing anything, and say so if a failure looks flaky or unrelated to the change.`;
    if (found?.kind === 'desktop') {
        openInClaudeApp(relayUrl(found, prompt, dir));
        return { resumed: true };
    }
    openInClaudeApp(`claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(dir)}`);
    return { resumed: false };
}

const BENCHMARK_TEAM = CONFIG.benchmarkTeam ?? null;
const BENCHMARK_DAYS = 30;
const BENCHMARK_TTL = 24 * 3600_000;
const BENCHMARK_FILE = path.join(here, 'benchmark.json');
let benchmark;
let benchmarkRunning = false;

const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function reviewActivity(login, since) {
    const query = 'query($q: String!, $endCursor: String) { search(query: $q, type: ISSUE, first: 50, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { '
        + 'timelineItems(first: 40, itemTypes: [REVIEW_REQUESTED_EVENT, PULL_REQUEST_REVIEW]) { nodes { __typename '
        + '... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } } } '
        + '... on PullRequestReview { createdAt author { login } } } } } } } }';
    const out = await gh(['api', 'graphql', '--paginate', '-f', `query=${query}`,
        '-f', `q=is:pr reviewed-by:${login} -author:${login} updated:>=${since.toISOString().slice(0, 10)}`,
        '--jq', '.data.search.nodes[] | .timelineItems.nodes | tojson']);
    const who = login.toLowerCase();
    let reviewed = 0;
    const waits = [];
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
        const events = JSON.parse(line);
        const reviews = events.filter((e) => e.__typename === 'PullRequestReview' && e.author?.login?.toLowerCase() === who).map((e) => new Date(e.createdAt));
        if (!reviews.some((t) => t >= since)) continue;
        reviewed++;
        const requests = events.filter((e) => e.__typename === 'ReviewRequestedEvent'
            && (e.requestedReviewer?.__typename !== 'User' || e.requestedReviewer.login?.toLowerCase() === who)).map((e) => new Date(e.createdAt));
        const asked = requests.sort((a, b) => a - b)[0];
        const first = asked && reviews.filter((t) => t >= asked).sort((a, b) => a - b)[0];
        if (first && first >= since) waits.push((first - asked) / 3600_000);
    }
    return { reviewed, firstReviewHours: median(waits), samples: waits.length };
}

async function computeBenchmark() {
    if (benchmarkRunning) return;
    benchmarkRunning = true;
    try {
        const [org, slug] = BENCHMARK_TEAM.split('/');
        const me = await viewerLogin();
        const members = (await gh(['api', `orgs/${org}/teams/${slug}/members`, '--paginate', '--jq', '.[].login']))
            .split(/\r?\n/).filter((l) => l && !/\[bot\]$|^svc-/i.test(l));
        const since = new Date(Date.now() - BENCHMARK_DAYS * 86_400_000);
        const day = since.toISOString().slice(0, 10);
        const aliases = members.map((m, i) => `c${i}: search(query: ${JSON.stringify(`is:pr author:${m} created:>=${day}`)}, type: ISSUE, first: 0) { issueCount } `
            + `m${i}: search(query: ${JSON.stringify(`is:pr author:${m} is:merged merged:>=${day}`)}, type: ISSUE, first: 0) { issueCount }`);
        const counts = JSON.parse(await gh(['api', 'graphql', '-f', `query=query { ${aliases.join(' ')} }`])).data;
        const people = [];
        for (const [i, login] of members.entries()) {
            const activity = await reviewActivity(login, since).catch(() => ({ reviewed: 0, firstReviewHours: null, samples: 0 }));
            people.push({ login, me: login.toLowerCase() === me.toLowerCase(), created: counts[`c${i}`].issueCount, merged: counts[`m${i}`].issueCount, ...activity });
        }
        const active = people.filter((p) => p.me || p.created || p.merged || p.reviewed);
        const summary = {};
        for (const key of ['created', 'merged', 'reviewed', 'firstReviewHours']) {
            const values = active.map((p) => p[key]).filter((v) => v !== null);
            const mine = people.find((p) => p.me)?.[key] ?? null;
            const better = key === 'firstReviewHours' ? (v) => v < mine : (v) => v > mine;
            summary[key] = { me: mine, median: median(values), rank: mine === null ? null : values.filter(better).length + 1, of: values.length };
        }
        benchmark = { at: new Date().toISOString(), team: BENCHMARK_TEAM, days: BENCHMARK_DAYS, summary, people };
        await writeFile(BENCHMARK_FILE, JSON.stringify(benchmark, null, 2));
    } finally {
        benchmarkRunning = false;
    }
}

async function getBenchmark() {
    if (!BENCHMARK_TEAM) return { disabled: true };
    if (benchmark === undefined) {
        try { benchmark = JSON.parse(await readFile(BENCHMARK_FILE, 'utf8')); } catch { benchmark = null; }
    }
    if ((!benchmark || Date.now() - new Date(benchmark.at) > BENCHMARK_TTL || benchmark.team !== BENCHMARK_TEAM) && !benchmarkRunning) {
        computeBenchmark().catch((err) => console.error('benchmark failed', err.message));
    }
    return benchmark ? { at: benchmark.at, team: benchmark.team, days: benchmark.days, summary: benchmark.summary, computing: benchmarkRunning } : { computing: true };
}

const STATS_TTL = 30 * 60_000;
const STATS_PERIODS = { week: 7, month: 30, quarter: 90 };
let statsCache = null;
async function fetchStats(force) {
    if (!force && statsCache && Date.now() - statsCache.at < STATS_TTL) return statsCache.data;
    const me = await viewerLogin();
    const since = Object.fromEntries(Object.entries(STATS_PERIODS).map(([k, days]) => [k, new Date(Date.now() - days * 86_400_000)]));
    const day = (d) => d.toISOString().slice(0, 10);
    const searches = [];
    for (const [k, d] of Object.entries(since)) {
        searches.push(`created_${k}: search(query: ${JSON.stringify(`is:pr author:@me created:>=${day(d)}`)}, type: ISSUE, first: 0) { issueCount }`);
        searches.push(`merged_${k}: search(query: ${JSON.stringify(`is:pr author:@me is:merged merged:>=${day(d)}`)}, type: ISSUE, first: 0) { issueCount }`);
    }
    const counts = JSON.parse(await gh(['api', 'graphql', '-f', `query=query { ${searches.join(' ')} }`])).data;
    const reviewedQuery = 'query($q: String!, $me: String!, $endCursor: String) { search(query: $q, type: ISSUE, first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { reviews(last: 30, author: $me) { nodes { submittedAt } } } } } }';
    const pages = await gh(['api', 'graphql', '--paginate', '-f', `query=${reviewedQuery}`, '-f', `q=is:pr reviewed-by:@me -author:@me updated:>=${day(since.quarter)}`, '-f', `me=${me}`, '--jq', '.data.search.nodes[] | [.reviews.nodes[].submittedAt | select(. != null)] | max // empty']);
    const lastReviewed = pages.split(/\r?\n/).filter(Boolean).map((s) => new Date(s.replace(/"/g, '')));
    const data = { at: new Date().toISOString(), periods: STATS_PERIODS, created: {}, merged: {}, reviewed: {} };
    for (const [k, d] of Object.entries(since)) {
        data.created[k] = counts[`created_${k}`].issueCount;
        data.merged[k] = counts[`merged_${k}`].issueCount;
        data.reviewed[k] = lastReviewed.filter((t) => t >= d).length;
    }
    statsCache = { at: Date.now(), data };
    return data;
}

let approvedCache = { approved: [], dismissed: [] };
async function fetchApproved() {
    const me = await viewerLogin();
    const [raw, sessions, localClones] = await Promise.all([
        gh(['api', 'graphql', '-f', `query=${APPROVED_QUERY}`, '-f', 'q=is:pr is:open archived:false reviewed-by:@me -author:@me sort:updated-desc', '-f', `me=${me}`]),
        findReviewSessions(),
        findClones(),
    ]);
    const items = [];
    const dismissed = [];
    for (const pr of JSON.parse(raw).data.search.nodes) {
        if (!pr?.number) continue;
        const mineAll = pr.myReviews.nodes.filter((r) => r.state !== 'PENDING' && r.submittedAt);
        const latest = pr.latestOpinionatedReviews.nodes.find((r) => r.author?.login?.toLowerCase() === me.toLowerCase());
        const lastOpinion = [...mineAll].reverse().find((r) => r.state !== 'COMMENTED');
        const mine = latest ?? lastOpinion;
        if (mine?.state !== 'APPROVED' && mine?.state !== 'DISMISSED') continue;
        const repo = pr.repository.nameWithOwner;
        const commits = pr.commits.nodes.map((n) => n.commit);
        const approvedOid = mine.commit?.oid ?? null;
        const at = approvedOid ? commits.findIndex((c) => c.oid === approvedOid) : -1;
        const after = at >= 0 ? commits.slice(at + 1) : null;
        const since = approvedOid === pr.headRefOid
            ? { commits: 0, changed: false }
            : at >= 0
                ? { commits: after.filter((c) => c.parents.totalCount < 2).length, changed: true }
                : { commits: null, changed: true };
        const review = {
            previous: 'approved', reviewedAt: mine.submittedAt, baseOid: approvedOid, headOid: pr.headRefOid,
            rewritten: approvedOid !== pr.headRefOid && at < 0,
            commits: after ? after.filter((c) => c.parents.totalCount < 2).length : null,
            merges: after ? after.filter((c) => c.parents.totalCount >= 2).length : null,
        };
        (mine.state === 'DISMISSED' ? dismissed : items).push({
            number: pr.number, title: pr.title, url: pr.url, repo, isDraft: pr.isDraft, createdAt: pr.createdAt, updatedAt: pr.updatedAt,
            additions: pr.additions, deletions: pr.deletions, reviewDecision: pr.reviewDecision,
            author: pr.author ? { login: pr.author.login, avatarUrl: pr.author.avatarUrl } : null,
            approvedAt: mine.submittedAt,
            sinceApproval: since,
            review,
            pending: pendingInfo(pr),
            checks: commits.at(-1)?.statusCheckRollup?.state ?? null,
            queue: pr.mergeQueueEntry ? { state: pr.mergeQueueEntry.state, position: pr.mergeQueueEntry.position } : null,
            localClone: localClones.get(repo.toLowerCase()) ?? null,
            session: sessionSummary(sessions.get(`${repo.toLowerCase()}#${pr.number}`)),
        });
    }
    items.sort((a, b) => (a.queue?.position ?? 1e9) - (b.queue?.position ?? 1e9) || b.approvedAt.localeCompare(a.approvedAt));
    dismissed.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
    approvedCache = { approved: items, dismissed };
    return approvedCache;
}

const prStates = new Map();
const OPEN_STATE_TTL = 5 * 60_000;
async function findFinishedSessions() {
    await findReviewSessions();
    const keys = [...lastAllSessions.keys()];
    const stale = keys.filter((k) => {
        const s = prStates.get(k);
        return !s || (s.state === 'OPEN' && Date.now() - s.at > OPEN_STATE_TTL);
    });
    if (stale.length) {
        const byRepo = new Map();
        for (const key of stale) {
            const [repo, number] = key.split('#');
            if (!byRepo.has(repo)) byRepo.set(repo, []);
            byRepo.get(repo).push(Number(number));
        }
        const parts = [...byRepo].map(([repo, numbers], i) => {
            const [owner, name] = repo.split('/');
            const prs = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { state }`).join(' ');
            return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${prs} }`;
        });
        const raw = await gh(['api', 'graphql', '-f', `query=query { ${parts.join(' ')} }`]).catch((err) => err.stdout ?? '');
        const data = (() => { try { return JSON.parse(raw).data ?? {}; } catch { return {}; } })();
        [...byRepo].forEach(([repo, numbers], i) => {
            for (const n of numbers) {
                const state = data[`r${i}`]?.[`p${n}`]?.state;
                if (state) prStates.set(`${repo}#${n}`, { state, at: Date.now() });
            }
        });
    }
    const finished = [];
    for (const [key, byId] of lastAllSessions) {
        const state = prStates.get(key)?.state;
        if (state !== 'MERGED' && state !== 'CLOSED') continue;
        const [repo, number] = key.split('#');
        for (const s of byId.values()) finished.push({ id: s.id, title: s.title, repo, number: Number(number), state: state.toLowerCase() });
    }
    const goingAway = new Set(finished.map((s) => s.id));
    const idleBefore = Date.now() - HELPER_IDLE_MS;
    const open = allDesktopSessions.filter((s) => !s.isArchived && s.id);
    for (const s of open) {
        const helper = s.cliId && helperByCli.get(s.cliId);
        if (!helper || s.lastActive > idleBefore || goingAway.has(s.id)) continue;
        if (helper === 'dispatcher' && autoState.enabled) continue;
        const keep = open.filter((c) => c.parent === s.id && !goingAway.has(c.id)).map((c) => ({ id: c.id, title: c.title }));
        finished.push({ id: s.id, title: s.title, helper, keep, state: 'done' });
        goingAway.add(s.id);
    }
    return finished;
}

const HELPER_IDLE_MS = 15 * 60_000;

async function launchArchiveFinished(ids) {
    const finished = pickChosen(await findFinishedSessions(), ids);
    if (!finished.length) throw Object.assign(new Error('No sessions for merged or closed PRs'), { status: 404 });
    const dir = await defaultDir();
    const describe = (s) => s.helper
        ? `${s.id} ("${s.title}", a finished ${s.helper} session)`
        : `${s.id} ("${s.title}", PR #${s.number} ${s.state})`;
    const direct = finished.filter((s) => !s.keep?.length);
    const parents = finished.filter((s) => s.keep?.length);
    let prompt = `Archive these ${finished.length} Claude Code sessions, because their PRs are merged or closed or their batch work is done. `;
    if (direct.length) prompt += `Archive these directly with archive_session: ${direct.map(describe).join('; ')}. `;
    if (parents.length) {
        prompt += 'These sessions started side sessions that must live on, and archiving them would archive those too, so do not archive them yourself. '
            + 'Instead send each one a message with SendMessage (to set to its id) that says exactly: '
            + '"Detach these sessions you started with detach_session, one by one: <ids>. Then archive this session with archive_session and session_id self." '
            + `with <ids> replaced by its list: ${parents.map((s) => `${describe(s)}, detach ${s.keep.map((c) => `${c.id} ("${c.title}")`).join(', ')}`).join('; ')}. `;
    }
    prompt += 'Archive only, do not delete anything, and do not touch any other session. Then list what you archived and what you messaged, and stop.';
    openInClaudeApp(`claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(dir)}`);
    return { count: finished.length };
}

let login = null;
async function viewerLogin() {
    if (!login) login = (await gh(['api', 'user', '--jq', '.login'])).trim();
    return login;
}

async function launchCheckReplies(repo, number) {
    const localClones = await findClones();
    const dir = localClones.get(String(repo).toLowerCase()) ?? await defaultDir();
    if (!dir) throw Object.assign(new Error('No local clone found to open Claude in'), { status: 404 });
    const own = localClones.get(String(repo).toLowerCase()) === dir;
    const prompt = `Check the replies to the review comments I left on PR ${number}${own ? '' : ` in ${repo} (use gh with --repo ${repo})`}. `
        + 'For each thread or comment that got a reply since my last comment, tell me what was said and whether it needs an answer, a fix check or a re-review from me. '
        + 'Do not post, reply to, approve or resolve anything on GitHub unless I ask.';
    openInClaudeApp(`claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(dir)}`);
    await markSeen(`${String(repo).toLowerCase()}#${number}`);
    if (repliesCache) repliesCache.items = repliesCache.items.filter((r) => !(r.repo.toLowerCase() === String(repo).toLowerCase() && r.number === number));
    return { dir };
}

function sessionSummary(session) {
    return session
        ? { kind: session.kind, id: session.id, title: session.title ?? null, cwd: session.cwd, lastActive: new Date(session.lastActive).toISOString() }
        : null;
}

function openInClaudeApp(url) {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
}

async function launchReview(repo, number) {
    const session = (await findReviewSessions()).get(`${String(repo).toLowerCase()}#${number}`);
    if (session) {
        openInClaudeApp(session.kind === 'desktop'
            ? `claude://claude.ai/epitaxy/${encodeURIComponent(session.id)}`
            : `claude://resume?session=${encodeURIComponent(session.id)}`);
        return { resumed: true, session: sessionSummary(session) };
    }
    const dir = (await findClones()).get(String(repo).toLowerCase());
    if (!dir) throw Object.assign(new Error(`No local clone of ${repo} found`), { status: 404 });
    const prompt = autoState.enabled ? `/review-pr-draft ${number}` : `Review PR ${number} with the review-pr skill`;
    openInClaudeApp(`claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(dir)}`);
    return { resumed: false, dir, draft: autoState.enabled };
}

async function launchReviewAll(prs) {
    const localClones = await findClones();
    const withDir = prs.map((pr) => ({ ...pr, dir: localClones.get(pr.repo.toLowerCase()) ?? null }));
    const counts = new Map();
    for (const pr of withDir) if (pr.dir) counts.set(pr.dir, (counts.get(pr.dir) ?? 0) + 1);
    const folder = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!folder) throw Object.assign(new Error('None of these PRs has a local clone'), { status: 404 });
    const list = withDir
        .map((pr) => `${pr.repo}#${pr.number} in ${pr.dir ?? `${folder} (no local clone; that session must use gh with --repo ${pr.repo})`}`)
        .join('; ');
    const prompt = `I want these ${prs.length} PRs reviewed in parallel, each in its own new session. Do not review any of them here. `
        + `Start one session per PR right away with start_session (initiation "user_asked", context "fresh", use_worktree false, and cwd set to the folder given only when it is not this folder), `
        + `whose prompt is "/${autoState.enabled ? 'review-pr-draft' : 'review-pr'} <number>" plus, for a PR without a local clone, a line naming its repo: ${list}. `
        + 'When they are all started, list them with a link to each session and stop.';
    openInClaudeApp(`claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(folder)}`);
    return { folder, count: prs.length };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (c) => {
            body += c;
            if (body.length > 20_000) req.destroy();
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body || '{}'));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Extensions: extra tabs from local folders, listed in config.json as
// { "id": "notes", "label": "Notes", "module": "C:/path/to/extension.mjs" }.
// The module's default export gets { id, origins } and returns { handle(req, res, pathname, searchParams) };
// it is mounted under /ext/<id>/ and shown in the widget in an iframe of its own.
const EXTENSIONS = new Map();
async function loadExtensions() {
    for (const ext of CONFIG.extensions ?? []) {
        if (!/^[a-z0-9-]{1,32}$/.test(ext?.id ?? '') || typeof ext.module !== 'string') {
            console.error('Skipping an extension without a valid id and module');
            continue;
        }
        try {
            const mod = await import(pathToFileURL(path.resolve(here, ext.module)).href);
            const instance = await mod.default({ id: ext.id, origins: [`http://localhost:${PORT}`, `http://${HOST}:${PORT}`] });
            EXTENSIONS.set(ext.id, { id: ext.id, label: String(ext.label ?? ext.id), handle: instance.handle });
        } catch (err) {
            console.error(`Extension ${ext.id} failed to load:`, err);
        }
    }
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);

        const extPath = /^\/ext\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname);
        if (extPath) {
            const ext = EXTENSIONS.get(extPath[1]);
            if (!ext) return send(res, 404, { error: 'No such extension' });
            if (!extPath[2]) {
                res.writeHead(301, { Location: `/ext/${ext.id}/` });
                return res.end();
            }
            return await ext.handle(req, res, extPath[2], url.searchParams);
        }

        if (req.method === 'GET' && url.pathname === '/api/extensions') {
            return send(res, 200, [...EXTENSIONS.values()].map(({ id, label }) => ({ id, label })));
        }

        if (req.method === 'GET' && url.pathname === '/') {
            return send(res, 200, await readFile(path.join(here, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
        }

        if (req.method === 'GET' && url.pathname === '/widget') {
            return send(res, 200, await readFile(path.join(here, 'widget.html'), 'utf8'), 'text/html; charset=utf-8');
        }

        if (req.method === 'GET' && url.pathname === '/widget.png') {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
            return res.end(await readFile(path.join(here, 'widget.png')));
        }

        if (req.method === 'GET' && url.pathname === '/api/prs') {
            const force = url.searchParams.has('force');
            const [prs, replies, approved, finished, oldArchived] = await Promise.all([
                fetchPrs(),
                fetchReplies(force).catch(() => repliesCache?.items ?? []),
                fetchApproved().catch(() => approvedCache),
                findFinishedSessions().catch(() => []),
                findOldArchived().catch(() => []),
            ]);
            const mine = await fetchMine(force).catch(() => []);
            const merged = await fetchMerged(force).catch(() => mergedCache?.items ?? []);
            const rateLimit = await gh(['api', 'rate_limit', '--jq', '.resources.graphql'])
                .then((out) => JSON.parse(out))
                .then((r) => ({ used: r.used, remaining: r.remaining, limit: r.limit, resetAt: new Date(r.reset * 1000).toISOString() }))
                .catch(() => null);
            const requestedKeys = new Set(prs.prs.map((p) => `${p.repo.toLowerCase()}#${p.number}`));
            const dismissed = approved.dismissed.filter((p) => !requestedKeys.has(`${p.repo.toLowerCase()}#${p.number}`));
            const sessionsNow = await findReviewSessions();
            const repliesOut = replies.map((r) => ({ ...r, session: sessionSummary(sessionsNow.get(`${r.repo.toLowerCase()}#${r.number}`)) }));
            await autoTick(prs.prs);
            return send(res, 200, { ...prs, replies: repliesOut, approved: approved.approved, dismissed, mine, merged, mergedDays: MERGED_DAYS, pending: allPending(), auto: autoStatus(), finished, oldArchived, rateLimit, homeRepo: homeRepo(), deleteAfterDays: DELETE_AFTER_DAYS });
        }

        if (req.method === 'GET' && url.pathname === '/api/stats') {
            const [stats, bench] = await Promise.all([fetchStats(url.searchParams.has('force')), getBenchmark()]);
            return send(res, 200, { ...stats, benchmark: bench });
        }

        if (req.method === 'GET' && url.pathname === '/api/sessions') {
            const sessions = await findReviewSessions();
            return send(res, 200, Object.fromEntries([...sessions].map(([key, s]) => [key, sessionSummary(s)])));
        }

        if (req.method === 'POST' && (url.pathname.startsWith('/api/review') || url.pathname === '/api/open' || url.pathname === '/api/replies/check' || url.pathname === '/api/archive-finished' || url.pathname === '/api/delete-old-archived')) {
            const origin = req.headers.origin;
            if (origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`) {
                return send(res, 403, { error: 'Cross-origin request refused' });
            }
            if (!String(req.headers['content-type']).startsWith('application/json')) {
                return send(res, 415, { error: 'Expected JSON' });
            }
        }

        if (req.method === 'POST' && url.pathname === '/api/auto/started') {
            const origin = req.headers.origin;
            if (origin && origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`) {
                return send(res, 403, { error: 'Cross-origin request refused' });
            }
            if (!String(req.headers['content-type']).startsWith('application/json')) {
                return send(res, 415, { error: 'Expected JSON' });
            }
        }

        if (req.method === 'POST' && url.pathname === '/api/open') {
            const { url: target } = await readJson(req);
            if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?:\/files)?$/.test(target ?? '')) return send(res, 400, { error: 'Not a GitHub PR link' });
            spawn('rundll32.exe', ['url.dll,FileProtocolHandler', target], { detached: true, stdio: 'ignore' }).unref();
            return send(res, 200, { ok: true });
        }

        if (req.method === 'POST' && url.pathname === '/api/review-all') {
            const { prs } = await readJson(req);
            const valid = Array.isArray(prs) && prs.length > 0 && prs.length <= 30
                && prs.every((pr) => Number.isInteger(pr?.number) && pr.number > 0 && /^[\w.-]+\/[\w.-]+$/.test(pr?.repo ?? ''));
            if (!valid) return send(res, 400, { error: 'Invalid PR list' });
            return send(res, 200, await launchReviewAll(prs));
        }

        if (req.method === 'POST' && url.pathname === '/api/review/pending/submit') {
            const { repo, number, event } = await readJson(req);
            if (!Number.isInteger(number) || number <= 0 || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
                return send(res, 400, { error: 'Invalid repo or PR number' });
            }
            return send(res, 200, await submitPending(repo, number, event));
        }

        if (req.method === 'POST' && url.pathname === '/api/review/auto') {
            const { enabled } = await readJson(req);
            return send(res, 200, await setAuto(enabled === true));
        }

        if (req.method === 'POST' && url.pathname === '/api/review/auto/dispatcher') {
            return send(res, 200, await openDispatcher());
        }

        if (req.method === 'GET' && url.pathname === '/api/auto/queue') {
            return send(res, 200, await autoQueue(url.searchParams.has('dry'), url.searchParams.get('v') === '2'));
        }

        if (req.method === 'GET' && url.pathname === '/api/auto/heartbeat') {
            if (autoState.enabled && Date.now() - lastFetchAt > 90_000) {
                await fetchPrs().then((r) => autoTick(r.prs)).catch(() => {});
            }
            return send(res, 200, autoHeartbeat());
        }

        if (req.method === 'POST' && url.pathname === '/api/auto/started') {
            const { keys } = await readJson(req);
            return send(res, 200, await autoMarkStarted(Array.isArray(keys) ? keys : []));
        }

        if (req.method === 'POST' && url.pathname === '/api/review/mine') {
            const { repo, number, action } = await readJson(req);
            if (!Number.isInteger(number) || number <= 0 || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !['address', 'fixci', 'open'].includes(action)) {
                return send(res, 400, { error: 'Invalid request' });
            }
            return send(res, 200, await launchMineAction(repo, number, action));
        }

        if (req.method === 'POST' && url.pathname === '/api/review/recheck-all') {
            const { prs, dry } = await readJson(req);
            const valid = Array.isArray(prs) && prs.length > 0 && prs.length <= 30
                && prs.every((pr) => Number.isInteger(pr?.number) && pr.number > 0 && /^[\w.-]+\/[\w.-]+$/.test(pr?.repo ?? ''));
            if (!valid) return send(res, 400, { error: 'Invalid PR list' });
            return send(res, 200, await launchRecheckAll(prs, dry === true));
        }

        if (req.method === 'POST' && url.pathname === '/api/review/recheck') {
            const { repo, number, dry } = await readJson(req);
            if (!Number.isInteger(number) || number <= 0 || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
                return send(res, 400, { error: 'Invalid repo or PR number' });
            }
            return send(res, 200, await launchRecheck(repo, number, dry === true));
        }

        if (req.method === 'POST' && url.pathname === '/api/delete-old-archived') {
            const { ids } = await readJson(req);
            return send(res, 200, await launchDeleteOldArchived(ids));
        }

        if (req.method === 'POST' && url.pathname === '/api/archive-finished') {
            const { ids } = await readJson(req);
            return send(res, 200, await launchArchiveFinished(ids));
        }

        if (req.method === 'POST' && url.pathname === '/api/replies/check') {
            const { repo, number } = await readJson(req);
            if (!Number.isInteger(number) || number <= 0 || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
                return send(res, 400, { error: 'Invalid repo or PR number' });
            }
            return send(res, 200, await launchCheckReplies(repo, number));
        }

        if (req.method === 'POST' && url.pathname === '/api/review') {
            const { repo, number } = await readJson(req);
            if (!Number.isInteger(number) || number <= 0 || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
                return send(res, 400, { error: 'Invalid repo or PR number' });
            }
            return send(res, 200, await launchReview(repo, number));
        }

        send(res, 404, { error: 'Not found' });
    } catch (err) {
        send(res, err.status ?? 500, { error: err.stderr?.toString().trim() || err.message });
    }
});

await loadExtensions();
server.listen(PORT, HOST, () => {
    const address = `http://localhost:${PORT}`;
    console.log(`PR inbox running at ${address}`);
    if (!process.argv.includes('--no-open')) {
        spawn('cmd.exe', ['/c', 'start', '', address], { detached: true, stdio: 'ignore' }).unref();
    }
});
