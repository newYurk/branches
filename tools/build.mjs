// Builds every branch from plan.json into <site>/<repo>/<branch>/ and records how it went.
//
//   node tools/build.mjs <plan.json> <site dir> <status.json>
//
// One branch failing never stops the others: its folder is simply missing and the
// listing shows "сборка не удалась" with a link to this run's log.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [planFile, siteDir, statusFile] = process.argv.slice(2).map((p) => resolve(p))
const plan = JSON.parse(readFileSync(planFile, 'utf8'))
const config = JSON.parse(readFileSync(new URL('../projects.json', import.meta.url), 'utf8'))
const work = resolve('work')
const inject = new URL('inject.mjs', import.meta.url).pathname
const runUrl = process.env.RUN_URL ?? ''

function sh(cmd, cwd, env = {}) {
  console.log(`$ ${cmd}`)
  const r = spawnSync('bash', ['-o', 'pipefail', '-c', cmd], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true', ...env },
    timeout: 10 * 60 * 1000,
  })
  return r.status === 0
}

function must(cmd, cwd, env) {
  if (!sh(cmd, cwd, env)) throw new Error(`failed: ${cmd}`)
}

// What legacy GitHub Pages would have published, minus the Jekyll-rendered markdown
// (no entry page links to it in any of the games): tracked files, without the
// names Jekyll leaves out.
const JEKYLL_SKIPS = new Set(['node_modules', 'vendor', 'Gemfile', 'Gemfile.lock'])
function copyLikePages(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (/^[._#~]/.test(entry.name) || JEKYLL_SKIPS.has(entry.name) || entry.isSymbolicLink()) continue
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) copyLikePages(src, dst)
    else cpSync(src, dst)
  }
}

const status = {}
rmSync(work, { recursive: true, force: true })

for (const project of plan.projects) {
  const recipe = config.projects.find((p) => p.repo === project.repo).build
  for (const b of project.branches) {
    const src = join(work, String(b.id))
    const out = join(siteDir, b.path)
    const result = (status[b.path] = { ok: false, gate: null, log: runUrl })
    console.log(`::group::${project.repo} · ${b.branch} · ${b.sha.slice(0, 7)}`)
    try {
      mkdirSync(src, { recursive: true })
      must('git init -q && git fetch -q --depth 1 "$URL" "$SHA" && git -c advice.detachedHead=false checkout -q FETCH_HEAD', src, {
        URL: `https://github.com/${config.owner}/${project.repo}.git`,
        SHA: b.sha,
      })

      if (recipe.copy) {
        copyLikePages(src, out)
      } else {
        // The builds read GITHUB_SHA for their own version stamp; here it must be the branch's commit.
        const env = { GITHUB_SHA: b.sha }
        for (const cmd of recipe.install ?? []) must(cmd, src, env)
        if (recipe.gate) result.gate = recipe.gate.every((cmd) => sh(cmd, src, env)) ? 'pass' : 'fail'
        for (const cmd of recipe.run) must(cmd, src, env)
        const built = join(src, recipe.out)
        if (!existsSync(join(built, 'index.html'))) throw new Error(`no index.html in ${recipe.out}`)
        mkdirSync(out, { recursive: true })
        cpSync(built, out, { recursive: true })
      }

      must(`node "${inject}" "${out}" "${project.repo}" "${b.branch}" "${b.sha}" "${b.path}"`, src)
      result.ok = true
    } catch (err) {
      console.log(`::error title=${project.repo} ${b.branch}::${err.message}`)
      rmSync(out, { recursive: true, force: true })
    } finally {
      rmSync(src, { recursive: true, force: true })
      console.log('::endgroup::')
    }
  }
}

writeFileSync(statusFile, JSON.stringify(status, null, 2))
const failed = Object.entries(status).filter(([, s]) => !s.ok)
console.log(`built ${Object.keys(status).length - failed.length}/${Object.keys(status).length}`)
for (const [path] of failed) console.log(`::warning::not published: ${path}`)
