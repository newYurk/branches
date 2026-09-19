// Builds the overview page: where the three games stand, in one glance.
//
//   node tools/overview.mjs <site dir>
//
// Everything here is read from the GitHub API at build time, so nothing is kept by hand and
// nothing can go stale. The three game repos are public, so no secret is needed; GITHUB_TOKEN
// only raises the rate limit, exactly as in plan.mjs.
//
// ⚑ MILESTONES ARE THE ONLY REAL STRUCTURE (19.09). The owner asked for infographics about how
// the projects move. A survey found that milestones already carry the whole staging — 15 of them
// across the three games — while GitHub Projects boards, releases, tags and sub-issues are all
// unused, and issue-to-issue dependencies exist only as prose (three of 179 open issues name one).
// So the page draws what is true — milestones and labels — and invents no structure on top.
//
// The page degrades rather than fails: a repo whose API call breaks is shown with its error and
// the rest of the page still builds. A broken overview must never take the branch listing down.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const siteDir = process.argv[2] ?? '_site'
const config = JSON.parse(readFileSync(new URL('../projects.json', import.meta.url), 'utf8'))

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

async function api(path) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return res.json()
}

/** Milestones with their counts, plus the open issues grouped by label. */
async function readGame(repo) {
  const full = `${config.owner}/${repo}`
  const [milestones, issues] = await Promise.all([
    api(`/repos/${full}/milestones?state=all&per_page=100`),
    api(`/repos/${full}/issues?state=open&per_page=100&filter=all`),
  ])
  const labels = new Map()
  // Pull requests come back from the issues endpoint too; they are not tasks and are dropped.
  const tasks = issues.filter((i) => !i.pull_request)
  for (const i of tasks) for (const l of i.labels) labels.set(l.name, (labels.get(l.name) ?? 0) + 1)
  const stones = milestones
    .map((m) => ({ title: m.title, done: m.closed_issues, all: m.closed_issues + m.open_issues, url: m.html_url }))
    .filter((m) => m.all > 0)
    // Where the work is now, first: most open, then biggest.
    .sort((a, b) => (b.all - b.done) - (a.all - a.done) || b.all - a.all)
  return {
    stones,
    open: tasks.length,
    done: stones.reduce((n, m) => n + m.done, 0),
    total: stones.reduce((n, m) => n + m.all, 0),
    labels: [...labels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  }
}

const bar = (done, all) => {
  const pct = all ? Math.round((done / all) * 100) : 0
  // A span, not a div: the bar sits inside a <p>, and a block element there is split out by the parser.
  return `<span class="bar" role="img" aria-label="${done} из ${all}"><i style="width:${pct}%"></i></span>`
}

const gameBlock = (project, data) => {
  if (data.error) {
    return `<section class="game"><h2>${esc(project.title)}</h2>
      <p class="err">Не удалось прочитать GitHub: ${esc(data.error)}. Остальная страница собрана.</p></section>`
  }
  const pct = data.total ? Math.round((data.done / data.total) * 100) : 0
  const stones = data.stones.map((m) => `
      <li>
        <a href="${esc(m.url)}">${esc(m.title)}</a>
        <span class="n">${m.done} / ${m.all}</span>
        ${bar(m.done, m.all)}
      </li>`).join('')
  const labels = data.labels.map(([name, n]) =>
    `<span class="chip">${esc(name)}<b>${n}</b></span>`).join('')
  return `
    <section class="game">
      <h2><a href="https://github.com/${esc(config.owner)}/${esc(project.repo)}">${esc(project.title)}</a></h2>
      <p class="tag">${esc(project.tagline ?? '')}</p>
      <p class="sum"><b>${pct}%</b> задач закрыто · открыто <b>${data.open}</b> · вех <b>${data.stones.length}</b></p>
      ${bar(data.done, data.total)}
      <h3>Вехи — где работа сейчас</h3>
      <ul class="stones">${stones}</ul>
      <h3>Чем заняты задачи</h3>
      <p class="chips">${labels || '<span class="chip">без меток</span>'}</p>
    </section>`
}

const games = []
for (const project of config.projects) {
  try {
    games.push([project, await readGame(project.repo)])
  } catch (e) {
    games.push([project, { error: e.message }])
  }
}

const ok = games.filter(([, d]) => !d.error).map(([, d]) => d)
const allOpen = ok.reduce((n, d) => n + d.open, 0)
const allDone = ok.reduce((n, d) => n + d.done, 0)
const allTotal = ok.reduce((n, d) => n + d.total, 0)
const when = new Date().toISOString().slice(0, 16).replace('T', ' ')

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Обзор — три игры</title>
<link rel="icon" href="favicon.svg">
<style>
  :root{--ink:#0c0b09;--linen:#ece8e1;--moss:#4f6b3a;--rust:#a2462b;--stone:#8a847c;
        --line:color-mix(in oklab,#0c0b09 12%,transparent)}
  *{box-sizing:border-box}
  body{margin:0;background:var(--linen);color:var(--ink);
       font:16px/1.55 ui-serif,Georgia,serif;padding:28px 16px 64px}
  .wrap{max-width:1040px;margin:0 auto}
  h1{font-size:30px;margin:0 0 2px}
  .lead{color:var(--stone);margin:0 0 22px}
  .total{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 26px;background:#fff6}
  .games{display:grid;gap:22px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
  .game{border:1px solid var(--line);border-radius:10px;padding:16px;background:#fff6}
  .game h2{font-size:21px;margin:0 0 2px}
  .game h3{font:600 13px/1.4 ui-sans-serif,system-ui,sans-serif;text-transform:uppercase;
           letter-spacing:.06em;color:var(--stone);margin:18px 0 8px}
  .tag{color:var(--stone);margin:0 0 10px;font-style:italic}
  .sum{margin:0 0 8px}
  a{color:var(--rust);text-decoration:none}
  a:hover{text-decoration:underline}
  .bar{display:block;height:8px;border-radius:4px;margin-top:7px;
       background:color-mix(in oklab,var(--ink) 8%,transparent);overflow:hidden}
  .bar i{display:block;height:100%;background:var(--moss)}
  ul.stones{list-style:none;margin:0;padding:0}
  ul.stones li{margin:0 0 11px}
  ul.stones .n{float:right;color:var(--stone);font-size:14px}
  .chips{margin:0;display:flex;flex-wrap:wrap;gap:6px}
  .chip{font:13px/1 ui-sans-serif,system-ui,sans-serif;border:1px solid var(--line);
        border-radius:999px;padding:5px 9px;color:var(--stone)}
  .chip b{color:var(--ink);margin-left:6px}
  .err{color:var(--rust)}
  footer{color:var(--stone);font-size:13px;margin-top:28px}
</style></head><body><div class="wrap">
<h1>Три игры — где мы</h1>
<p class="lead">Собрано из вех и задач GitHub при каждой публикации. Руками здесь ничего не ведётся.</p>
<p class="total">Всего по трём играм: закрыто <b>${allDone}</b> из <b>${allTotal}</b> задач в вехах,
открыто <b>${allOpen}</b>. ${bar(allDone, allTotal)}</p>
<div class="games">${games.map(([p, d]) => gameBlock(p, d)).join('')}</div>
<footer>Собрано ${when} UTC · <a href="./">ветки в работе</a> ·
<a href="https://github.com/${esc(config.owner)}/${esc(config.site)}">как это устроено</a></footer>
</div></body></html>
`

mkdirSync(dirname(join(siteDir, 'overview.html')), { recursive: true })
writeFileSync(join(siteDir, 'overview.html'), html)
console.log(JSON.stringify({
  page: join(siteDir, 'overview.html'),
  games: games.length,
  failed: games.filter(([, d]) => d.error).map(([p]) => p.repo),
  milestones: ok.reduce((n, d) => n + d.stones.length, 0),
  open: allOpen,
}, null, 1))
