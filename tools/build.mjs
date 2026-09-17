// Builds every branch from plan.json into <site>/<repo>/<branch>/ and records how it went.
//
//   node tools/build.mjs <plan.json> <site dir> <status.json>
//
// One branch failing never stops the others: its folder is simply missing and the
// listing shows "сборка не удалась" with a link to this run's log.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [planFile, siteDir, statusFile] = process.argv.slice(2).map((p) => resolve(p))
const plan = JSON.parse(readFileSync(planFile, 'utf8'))
const config = JSON.parse(readFileSync(new URL('../projects.json', import.meta.url), 'utf8'))
const inject = fileURLToPath(new URL('inject.mjs', import.meta.url))
const runUrl = process.env.RUN_URL ?? ''

// The publish job has 30 minutes; whatever is not built by then is reported, not waited for.
const BUDGET_MS = 18 * 60_000
const started = Date.now()
// GNU timeout kills the whole process group (test runners leave children behind); macOS has none.
const TIMEOUT = existsSync('/usr/bin/timeout') ? '/usr/bin/timeout' : null

function run(argv, cwd, { env = {}, minutes = 10 } = {}) {
  const [cmd, ...args] = TIMEOUT ? [TIMEOUT, '-k', '15', String(minutes * 60), ...argv] : argv
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true', GIT_TERMINAL_PROMPT: '0', ...env },
    timeout: (minutes * 60 + 30) * 1000,
  })
  return r.status === 0
}
const sh = (script, cwd, opts) => {
  console.log(`$ ${script}`)
  return run(['bash', '-o', 'pipefail', '-c', script], cwd, opts)
}
// Network steps get three tries; build and test failures are real and are not retried.
function retry(step, times = 3) {
  for (let i = 1; i <= times; i++) {
    if (step()) return true
    if (i < times) spawnSync('sleep', [String(5 * i * i)])
  }
  return false
}
function must(ok, what) {
  if (!ok) throw new Error(`failed: ${what}`)
}

// What legacy GitHub Pages would have published, minus the Jekyll-rendered markdown
// (no entry page links to it in any of the games): tracked files, without names starting
// with . _ # ~ and without Jekyll's default excludes at the site root.
const ROOT_EXCLUDES = new Set(['node_modules', 'Gemfile', 'Gemfile.lock', 'gemfiles', 'vendor'])
function copyLikePages(from, to, root = true) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (/^[._#~]/.test(entry.name) || entry.isSymbolicLink()) continue
    if (root && ROOT_EXCLUDES.has(entry.name)) continue
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) copyLikePages(src, dst, false)
    else cpSync(src, dst)
  }
}

const status = {}
const work = mkdtempSync(join(tmpdir(), 'branches-'))

for (const project of plan.projects) {
  const recipe = config.projects.find((p) => p.repo === project.repo).build
  for (const b of project.branches) {
    const result = (status[b.path] = { ok: false, gate: null, reason: null, log: runUrl })
    if (b.skip) {
      result.reason = b.note
      continue
    }
    if (Date.now() - started > BUDGET_MS) {
      result.reason = 'не хватило времени на сборку — будет в следующий раз'
      continue
    }
    const src = join(work, String(b.id))
    const out = join(siteDir, b.path)
    console.log(`::group::${project.repo} · ${b.branch} · ${b.sha.slice(0, 7)}`)
    try {
      mkdirSync(src, { recursive: true })
      const url = `https://github.com/${config.owner}/${project.repo}.git`
      must(run(['git', 'init', '-q'], src), 'git init')
      must(retry(() => run(['git', 'fetch', '-q', '--depth', '1', url, b.sha], src, { minutes: 5 })), 'git fetch')
      must(run(['git', '-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], src), 'git checkout')

      if (recipe.copy) {
        copyLikePages(src, out)
      } else {
        // The builds read GITHUB_SHA for their own version stamp; here it must be the branch's commit.
        const env = { GITHUB_SHA: b.sha }
        for (const cmd of recipe.install ?? []) must(retry(() => sh(cmd, src, { env })), cmd)
        if (recipe.gate) result.gate = recipe.gate.every((cmd) => sh(cmd, src, { env, minutes: 5 })) ? 'pass' : 'fail'
        for (const cmd of recipe.run) must(sh(cmd, src, { env }), cmd)
        const built = join(src, recipe.out)
        if (!existsSync(join(built, 'index.html'))) throw new Error(`no index.html in ${recipe.out}`)
        mkdirSync(out, { recursive: true })
        cpSync(built, out, { recursive: true })
      }

      must(run([process.execPath, inject, out, project.repo, b.branch, b.sha, b.path], src), 'inject')
      result.ok = true
    } catch (err) {
      result.reason = err.message
      console.log(`::error title=${project.repo} ${b.branch}::${err.message}`)
      rmSync(out, { recursive: true, force: true })
    } finally {
      rmSync(src, { recursive: true, force: true })
      console.log('::endgroup::')
    }
  }
}

rmSync(work, { recursive: true, force: true })
writeFileSync(statusFile, JSON.stringify(status, null, 2))
const failed = Object.entries(status).filter(([, s]) => !s.ok)
console.log(`built ${Object.keys(status).length - failed.length}/${Object.keys(status).length}`)
for (const [path, s] of failed) console.log(`::warning::not published: ${path} (${s.reason})`)
