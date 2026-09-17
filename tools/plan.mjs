// Decides what the branch site should contain right now.
//
//   node tools/plan.mjs heads  -> prints a fingerprint of every branch head (git only, no API)
//   node tools/plan.mjs full   -> writes plan.json and matrix.json (uses the GitHub API)
//
// Every game repo is public, so reading needs no secret; GITHUB_TOKEN only raises the rate limit.

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
  })
  let defaultBranch = 'main'
  const heads = []
  for (const line of out.trim().split('\n')) {
    const [left, ref] = line.split('\t')
    if (left.startsWith('ref: ')) defaultBranch = left.slice('ref: refs/heads/'.length)
    else if (ref.startsWith('refs/heads/')) heads.push({ branch: ref.slice('refs/heads/'.length), sha: left })
  }
  return { defaultBranch, heads }
}

// A branch name becomes a directory under /branches/<repo>/. Slashes stay (they read well in the
// address bar), anything a URL or a file system would choke on turns into "-".
export function pathFor(repo, branch) {
  const safe = branch
    .split('/')
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '-'))
    .join('/')
  return `${repo}/${safe}`
}

async function api(path) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com${path}`, { headers })
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`)
  return res.json()
}

// Does this branch change anything a player would see? Only the file list is needed:
// `quiet` globs from projects.json name the paths that never reach the page
// (notes, simulations, CI). A branch that touches nothing else is shown
// dimmed as "только доки" — the preview is still built, it just looks like main.
export function whatChanged(files, quiet) {
  const matchers = quiet.map(globToRegExp)
  const loud = files.filter((f) => !matchers.some((re) => re.test(f)))
  if (files.length === 0) return 'same'
  return loud.length === 0 ? 'docs' : 'game'
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

function heads() {
  const lines = [`builder ${builderVersion()}`]
  const repos = {}
  for (const project of config.projects) {
    const remote = lsRemote(project.repo)
    repos[project.repo] = remote
    lines.push(`${project.repo} default ${remote.defaultBranch}`)
    for (const h of remote.heads.sort((a, b) => a.branch.localeCompare(b.branch))) {
      lines.push(`${project.repo} ${h.branch} ${h.sha}`)
    }
  }
  const fingerprint = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
  return { fingerprint, repos, builder: builderVersion() }
}

async function full() {
  const { fingerprint, repos, builder } = heads()
  const plan = { fingerprint, builder, generatedAt: new Date().toISOString(), projects: [] }
  const matrix = []

  for (const project of config.projects) {
    const { defaultBranch, heads: all } = repos[project.repo]
    const main = all.find((h) => h.branch === defaultBranch)
    const pulls = await api(`/repos/${OWNER}/${project.repo}/pulls?state=open&per_page=100`)
    const entry = {
      repo: project.repo,
      title: project.title,
      tagline: project.tagline,
      live: project.live,
      defaultBranch,
      mainSha: main?.sha ?? null,
      branches: [],
    }

    for (const head of all) {
      if (head.branch === defaultBranch) continue
      const [commit, compare] = await Promise.all([
        api(`/repos/${OWNER}/${project.repo}/commits/${head.sha}`),
        api(`/repos/${OWNER}/${project.repo}/compare/${defaultBranch}...${head.sha}?per_page=100`),
      ])
      const files = (compare.files ?? []).map((f) => f.filename)
      const pr = pulls.find((p) => p.head.ref === head.branch && p.head.repo?.full_name === `${OWNER}/${project.repo}`)
      const branch = {
        id: matrix.length,
        branch: head.branch,
        sha: head.sha,
        path: pathFor(project.repo, head.branch),
        subject: commit.commit.message.split('\n')[0],
        committedAt: commit.commit.committer.date,
        ahead: compare.ahead_by,
        behind: compare.behind_by,
        changed: whatChanged(files, project.quiet ?? []),
        pr: pr ? { number: pr.number, title: pr.title, draft: pr.draft, url: pr.html_url } : null,
        url: `https://github.com/${OWNER}/${project.repo}/tree/${head.branch}`,
      }
      entry.branches.push(branch)
      matrix.push({ id: branch.id, repo: project.repo, branch: head.branch, sha: head.sha, path: branch.path, build: project.build })
    }

    entry.branches.sort((a, b) => b.committedAt.localeCompare(a.committedAt))
    plan.projects.push(entry)
  }

  writeFileSync('plan.json', JSON.stringify(plan, null, 2))
  writeFileSync('matrix.json', JSON.stringify({ include: matrix }))
  return plan
}

const mode = import.meta.url === pathToFileURL(process.argv[1]).href ? process.argv[2] : null
if (mode === 'heads') {
  process.stdout.write(heads().fingerprint + '\n')
} else if (mode === 'full') {
  const plan = await full()
  const count = plan.projects.reduce((n, p) => n + p.branches.length, 0)
  console.error(`plan ${plan.fingerprint}: ${count} branch(es)`)
} else if (mode !== null) {
  console.error('usage: node tools/plan.mjs heads|full')
  process.exit(2)
}
