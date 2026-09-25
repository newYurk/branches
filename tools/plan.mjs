// Decides what the branch site should contain right now.
//
//   node tools/plan.mjs heads  -> prints a fingerprint of every branch head and open PR
//   node tools/plan.mjs full   -> writes plan.json (uses the GitHub API)
//
// Every game repo is public, so reading needs no secret; GITHUB_TOKEN only raises the rate limit.
// A repo or branch that cannot be read never stops the others: it is recorded with an error.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const config = JSON.parse(readFileSync(new URL('projects.json', ROOT), 'utf8'))
const OWNER = config.owner

function lsRemote(repo) {
  const out = execFileSync('git', ['ls-remote', '--symref', `https://github.com/${OWNER}/${repo}.git`, 'HEAD', 'refs/heads/*'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 60_000,
  })
  let defaultBranch = null
  const heads = []
  for (const line of out.split('\n')) {
    const [left, ref] = line.split('\t')
    if (!ref) continue
    if (left.startsWith('ref: ')) defaultBranch = left.slice('ref: refs/heads/'.length)
    else if (ref.startsWith('refs/heads/')) heads.push({ branch: ref.slice('refs/heads/'.length), sha: left })
  }
  return { defaultBranch: defaultBranch ?? 'main', heads: heads.sort((a, b) => a.branch.localeCompare(b.branch)) }
}

const sha1 = (s) => createHash('sha1').update(s).digest('hex')

// A branch name becomes a folder under /branches/<repo>/. Slashes stay (they read well in the
// address bar). The first part with characters a URL or a file system would choke on is cleaned
// up and gets "~" plus a hash of the whole name: git never allows "~" in a branch name, so a
// cleaned folder can neither equal nor contain the folder of another branch.
// Self-contained on purpose: tools/assemble.mjs puts this very function into the listing page.
export async function pathFor(repo, branch) {
  const parts = []
  let marked = false
  for (const part of branch.split('/')) {
    const safe = part.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '-')
    if (safe === part || marked) {
      parts.push(safe)
      continue
    }
    marked = true
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(branch))
    const hex = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('')
    parts.push(`${safe}~${hex.slice(0, 6)}`)
  }
  return `${repo}/${parts.join('/')}`
}

// For links to github.com: every part of the name percent-encoded, slashes kept.
export const urlBranch = (branch) => branch.split('/').map(encodeURIComponent).join('/')

async function api(path) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

// Does this branch change anything a player would see? `quiet` globs from projects.json name
// the paths that never reach the page (notes, simulations, CI). A branch that touches nothing
// else is shown dimmed as "только доки".
export function whatChanged(files, quiet) {
  const matchers = quiet.map(globToRegExp)
  if (files.length === 0) return 'same'
  return files.every((f) => matchers.some((re) => re.test(f))) ? 'docs' : 'game'
}

function globToRegExp(glob) {
  // "**/" is any number of folders, a trailing "**" is everything below, "*" stays within one name.
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) (re += '(?:.*/)?'), (i += 2)
    else if (glob.startsWith('**', i)) (re += '.*'), (i += 1)
    else if (glob[i] === '*') re += '[^/]*'
    else re += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function builderVersion() {
  // Rebuild everything when the recipe itself changes.
  const hash = createHash('sha256')
  const walk = (rel) => {
    const url = new URL(rel, ROOT)
    if (!existsSync(url)) return
    if (statSync(url).isDirectory()) for (const name of readdirSync(url).sort()) walk(`${rel}/${name}`)
    else hash.update(rel).update(readFileSync(url))
  }
  for (const rel of ['projects.json', 'tools', 'site', '.github/workflows/publish.yml']) walk(rel)
  return hash.digest('hex').slice(0, 12)
}

// PR links are a nicety: when the API is unavailable the branches still get built.
async function openPulls(repo) {
  try {
    const pulls = await api(`/repos/${OWNER}/${repo}/pulls?state=open&per_page=100`)
    return pulls.filter((p) => p.head.repo?.full_name?.toLowerCase() === `${OWNER}/${repo}`.toLowerCase())
  } catch (err) {
    console.error(`::warning::${repo}: no PR list (${err.message.split('\n')[0]})`)
    return null
  }
}

// Everything the listing shows that can change without a push to this repo:
// branch heads, the default branch, open PRs (number, draft, title).
async function heads() {
  const lines = [`builder ${builderVersion()}`]
  const repos = {}
  for (const project of config.projects) {
    try {
      const remote = lsRemote(project.repo)
      remote.pulls = await openPulls(project.repo)
      repos[project.repo] = remote
      lines.push(`${project.repo} default ${remote.defaultBranch}`)
      for (const h of remote.heads) lines.push(`${project.repo} ${h.branch} ${h.sha}`)
      if (!remote.pulls) lines.push(`${project.repo} pr unknown`)
      for (const p of remote.pulls ?? []) lines.push(`${project.repo} pr ${p.number} ${p.head.ref} ${p.draft} ${sha1(p.title)}`)
    } catch (err) {
      repos[project.repo] = { error: String(err.message ?? err).split('\n')[0] }
      lines.push(`${project.repo} unavailable`)
      console.error(`::warning::${project.repo}: ${repos[project.repo].error}`)
    }
  }
  const fingerprint = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
  return { fingerprint, repos, builder: builderVersion() }
}


// Tip of the default branch (main), even when a game has no feature branches.
async function tipOf(repo, defaultBranch, head) {
  const tip = {
    sha: head?.sha ?? null,
    subject: '',
    committedAt: null,
    url: head?.sha
      ? `https://github.com/${OWNER}/${repo}/commit/${head.sha}`
      : `https://github.com/${OWNER}/${repo}/tree/${urlBranch(defaultBranch)}`,
  }
  if (!head?.sha) return tip
  try {
    const commit = await api(`/repos/${OWNER}/${repo}/commits/${head.sha}`)
    tip.subject = commit.commit.message.split('\n')[0]
    tip.committedAt = commit.commit.committer.date
  } catch (err) {
    console.error(`::warning::${repo} ${defaultBranch}: ${err.message}`)
  }
  return tip
}

async function describe(project, defaultBranch, head, pulls) {
  const branch = {
    branch: head.branch,
    sha: head.sha,
    path: await pathFor(project.repo, head.branch),
    url: `https://github.com/${OWNER}/${project.repo}/tree/${urlBranch(head.branch)}`,
    subject: '',
    committedAt: null,
    ahead: null,
    behind: null,
    changed: 'game',
    pr: null,
    note: null,
  }
  const pr = pulls?.find((p) => p.head.ref === head.branch)
  if (pr) branch.pr = { number: pr.number, title: pr.title, draft: pr.draft, url: pr.html_url }
  try {
    const commit = await api(`/repos/${OWNER}/${project.repo}/commits/${head.sha}`)
    branch.subject = commit.commit.message.split('\n')[0]
    branch.committedAt = commit.commit.committer.date
  } catch (err) {
    branch.note = 'нет данных о последнем коммите'
    console.error(`::warning::${project.repo} ${head.branch}: ${err.message}`)
  }
  try {
    const compare = await api(`/repos/${OWNER}/${project.repo}/compare/${urlBranch(defaultBranch)}...${head.sha}?per_page=100`)
    branch.ahead = compare.ahead_by
    branch.behind = compare.behind_by
    // Everything in the branch is already in main: the preview is just an older main.
    if (compare.ahead_by === 0) branch.changed = 'merged'
    else branch.changed = whatChanged((compare.files ?? []).map((f) => f.filename), project.quiet ?? [])
  } catch (err) {
    // An orphan branch has no history in common with main; compare answers 404.
    branch.note = `не сравнить с ${defaultBranch}`
    console.error(`::warning::${project.repo} ${head.branch}: ${err.message}`)
  }
  return branch
}

async function full() {
  const { fingerprint, repos, builder } = await heads()
  const plan = { fingerprint, builder, generatedAt: new Date().toISOString(), projects: [] }
  let id = 0

  for (const project of config.projects) {
    const remote = repos[project.repo]
    const entry = {
      repo: project.repo,
      title: project.title,
      tagline: project.tagline,
      defaultBranch: remote.defaultBranch ?? 'main',
      error: remote.error ?? null,
      branches: [],
    }
    plan.projects.push(entry)
    if (remote.error) continue

    const defaultHead = remote.heads.find((h) => h.branch === remote.defaultBranch)
    entry.main = await tipOf(project.repo, remote.defaultBranch, defaultHead)

    for (const head of remote.heads) {
      if (head.branch === remote.defaultBranch) continue
      entry.branches.push({ id: id++, ...(await describe(project, remote.defaultBranch, head, remote.pulls)) })
    }
    entry.branches.sort((a, b) => (b.committedAt ?? '').localeCompare(a.committedAt ?? ''))
  }

  // Folders must be unique and never nested in one another, or two previews would mix.
  // pathFor() makes that so; should it ever fail, the later branch goes without a preview.
  const all = plan.projects.flatMap((p) => p.branches)
  for (const b of all) {
    const clash = all.find((o) => o.id < b.id && (o.path === b.path || o.path.startsWith(b.path + '/') || b.path.startsWith(o.path + '/')))
    if (clash) Object.assign(b, { skip: true, note: `папка превью совпала с веткой ${clash.branch}` })
  }

  writeFileSync('plan.json', JSON.stringify(plan, null, 2))
  return plan
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
const mode = direct ? process.argv[2] : null
if (mode === 'heads') {
  process.stdout.write((await heads()).fingerprint + '\n')
} else if (mode === 'full') {
  const plan = await full()
  const count = plan.projects.reduce((n, p) => n + p.branches.length, 0)
  console.error(`plan ${plan.fingerprint}: ${count} branch(es)`)
} else if (mode !== null) {
  console.error('usage: node tools/plan.mjs heads|full')
  process.exit(2)
}
