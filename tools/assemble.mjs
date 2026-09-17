// Finishes the site: static files, the public plan and index.html.
//
//   node tools/assemble.mjs <plan.json> <site dir> <status.json>
//
// A branch whose build failed has no folder in <site dir>; it is still listed, with a link to the log.

import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathFor } from './plan.mjs'

const [planFile, siteDir, statusFile] = process.argv.slice(2)
const plan = JSON.parse(readFileSync(planFile, 'utf8'))
const statuses = existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, 'utf8')) : {}
const config = JSON.parse(readFileSync(new URL('../projects.json', import.meta.url), 'utf8'))
const runUrl = process.env.RUN_URL ?? ''
const workflowUrl = `https://github.com/${config.owner}/${config.site}/actions/workflows/publish.yml`
// How long a pushed commit may wait for its preview before the page calls the watcher stuck.
const STALE_MINUTES = 20

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const statusOf = (branch) => statuses[branch.path] ?? { ok: false, gate: null, log: runUrl }

function entriesFor(project, branch) {
  const cfg = config.projects.find((p) => p.repo === project.repo)
  return (cfg.entries ?? [{ path: '', label: 'открыть' }]).filter((e) => {
    const target = join(siteDir, branch.path, e.path)
    return existsSync(e.path === '' || e.path.endsWith('/') ? join(target, 'index.html') : target)
  })
}

const CHANGED = { docs: 'только доки — игра как в main', same: 'совпадает с main' }

function renderBranch(project, b) {
  const status = statusOf(b)
  const entries = status.ok ? entriesFor(project, b) : []
  const href = entries.length ? `./${b.path}/${entries[0].path}` : null
  const meta = [
    `<time datetime="${esc(b.committedAt)}">${esc(b.committedAt.slice(0, 16).replace('T', ' '))}</time>`,
    b.ahead ? `+${b.ahead} к ${esc(project.defaultBranch)}` : null,
    b.behind ? `отстаёт на ${b.behind}` : null,
    b.pr ? `<a href="${esc(b.pr.url)}">PR #${b.pr.number}${b.pr.draft ? ' · черновик' : ''}</a>` : null,
    `<a href="${esc(b.url)}"><code>${esc(b.sha.slice(0, 7))}</code></a>`,
  ].filter(Boolean)

  const notes = []
  if (!status.ok) notes.push(`<span class="note bad">сборка не удалась — <a href="${esc(status.log)}">лог</a></span>`)
  if (status.gate === 'fail')
    notes.push(`<span class="note bad">проверки, которые стоят перед выкладкой main, не прошли — <a href="${esc(status.log)}">лог</a></span>`)
  if (CHANGED[b.changed]) notes.push(`<span class="note">${CHANGED[b.changed]}</span>`)

  const more = entries.length > 1 ? entries.map((e) => `<a href="./${esc(b.path)}/${esc(e.path)}">${esc(e.label)}</a>`) : []

  return `
      <li class="branch${b.changed === 'game' ? '' : ' quiet'}" data-repo="${esc(project.repo)}" data-branch="${esc(b.branch)}" data-sha="${esc(b.sha)}" data-path="${esc(b.path)}">
        ${href ? `<a class="name" href="${esc(href)}">${esc(b.branch)}</a>` : `<span class="name">${esc(b.branch)}</span>`}
        <p class="subject">${esc(b.subject.replace(`[${b.branch}] `, ''))}</p>
        <p class="meta">${meta.join('<span class="dot">·</span>')}</p>
        ${more.length ? `<p class="more">${more.join('')}</p>` : ''}
        ${notes.length ? `<p class="notes">${notes.join('')}</p>` : ''}
        <p class="live" hidden></p>
      </li>`
}

function renderProject(p) {
  const idle = p.branches.length === 0
  return `
    <section class="project${idle ? ' idle' : ''}" data-repo="${esc(p.repo)}" data-default="${esc(p.defaultBranch)}">
      <h2><span>${esc(p.title)}</span> <a class="main" href="${esc(p.live)}">${esc(p.defaultBranch)} ↗</a></h2>
      <p class="tagline">${idle ? 'других веток нет' : esc(p.tagline)}</p>
      <ul>${p.branches.map((b) => renderBranch(p, b)).join('')}
      </ul>
    </section>`
}

const active = plan.projects.filter((p) => p.branches.length)
const idle = plan.projects.filter((p) => !p.branches.length)

const html = `<!DOCTYPE html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ветки · newYurk</title>
    <meta name="description" content="Превью веток, над которыми сейчас идёт работа." />
    <meta name="robots" content="noindex" />
    <meta name="theme-color" content="#ece8e1" />
    <link rel="icon" type="image/svg+xml" href="./favicon.svg" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500&display=swap"
    />
    <style>
      :root {
        --ink: #0c0b09;
        --linen: #ece8e1;
        --stone: #8a847c;
        --moss: #4f6b3a;
        --rust: #a2462b;
        --line: color-mix(in oklab, #0c0b09 12%, transparent);
      }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      html, body {
        margin: 0;
        background: var(--linen);
        color: var(--ink);
        font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
      }
      body { padding: 3rem 1rem 4rem; }
      main { max-width: 30rem; margin: 0 auto; }
      a { color: inherit; }
      .kicker {
        font-size: 0.72rem;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--stone);
        margin: 0 0 0.6rem;
      }
      h1, h2 { font-family: "Cormorant Garamond", "Times New Roman", serif; font-weight: 500; }
      h1 { font-size: clamp(2.4rem, 8vw, 3.2rem); letter-spacing: -0.03em; margin: 0 0 0.4rem; }
      .lede { margin: 0 0 2.4rem; color: var(--stone); font-size: 0.92rem; line-height: 1.5; }
      .project { margin-top: 2.2rem; }
      h2 {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 1rem;
        margin: 0;
        font-size: 1.9rem;
      }
      h2 .main {
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        font-size: 0.78rem;
        color: var(--stone);
        text-decoration: none;
      }
      .tagline { margin: 0.1rem 0 0.8rem; font-size: 0.85rem; color: var(--stone); }
      ul { list-style: none; margin: 0; padding: 0; }
      .branch { padding: 0.95rem 0; border-top: 1px solid var(--line); }
      .branch:last-child { border-bottom: 1px solid var(--line); }
      .name {
        display: block;
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        font-size: 1rem;
        font-weight: 500;
        overflow-wrap: anywhere;
        text-decoration: none;
      }
      a.name::after { content: " →"; color: var(--stone); }
      .subject { margin: 0.3rem 0 0; font-size: 0.9rem; line-height: 1.4; }
      .meta, .more, .notes, .live { margin: 0.35rem 0 0; font-size: 0.78rem; color: var(--stone); }
      .meta a { text-decoration: none; }
      .meta code { font-family: "IBM Plex Mono", ui-monospace, monospace; }
      .dot { margin: 0 0.4em; }
      .more a { margin-right: 1em; }
      .note { display: inline-block; margin-right: 0.8em; }
      .note.bad, .live.bad { color: var(--rust); }
      .live.fresh { color: var(--moss); }
      .quiet .name, .quiet .subject { color: var(--stone); }
      .empty { margin-top: 2.2rem; color: var(--stone); font-size: 0.9rem; }
      .idle { margin-top: 1.2rem; }
      .idle h2 { font-size: 1.35rem; color: var(--stone); }
      .idle .tagline { margin-bottom: 0; }
      footer { margin-top: 2.6rem; font-size: 0.78rem; color: var(--stone); line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <p class="kicker">ветки в работе</p>
      <h1>newYurk</h1>
      <p class="lede">Каждая ветка с GitHub, собранная так же, как собирается main. Основные адреса игр не меняются.</p>
${active.length ? '' : '      <p class="empty">Сейчас ни одной ветки, кроме main.</p>'}
${[...active, ...idle].map(renderProject).join('\n')}
      <footer>
        Собрано <time id="built" datetime="${esc(plan.generatedAt)}">${esc(plan.generatedAt.slice(0, 16).replace('T', ' '))} UTC</time>.
        Проверка новых коммитов — раз в несколько минут; <a href="${esc(workflowUrl)}">обновить сейчас</a>.<br />
        Ветки, которые не запушены на GitHub, здесь не видны.
        <span id="stale" class="note bad" hidden><br />Новые коммиты ждут дольше ${STALE_MINUTES} минут — похоже, автопроверка стоит. <a href="${esc(workflowUrl)}">Запустить publish вручную</a>.</span>
      </footer>
    </main>
    <script type="module">
      const OWNER = ${JSON.stringify(config.owner)}
      ${pathFor}
      const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' })
      function ago(iso) {
        const s = (new Date(iso) - Date.now()) / 1000
        for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
          if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit)
        }
        return 'только что'
      }
      for (const t of document.querySelectorAll('time')) t.textContent = ago(t.dateTime)

      // Previews keep their saves under "branch:<repo>/<branch>:" (see tools/inject.mjs).
      // Once a branch is gone from GitHub its saves are dead weight in the shared 5 MB.
      const alive = new Set([...document.querySelectorAll('.branch')].map((li) => li.dataset.path))
      const checked = new Set()
      let lagging = false

      // Built pages lag behind pushes by a few minutes; say so instead of pretending.
      for (const section of document.querySelectorAll('.project')) {
        const repo = section.dataset.repo
        let heads
        try {
          const res = await fetch(\`https://api.github.com/repos/\${OWNER}/\${repo}/branches?per_page=100\`)
          if (!res.ok) continue
          heads = new Map((await res.json()).map((b) => [b.name, b.commit.sha]))
        } catch {
          continue
        }
        checked.add(repo)
        for (const name of heads.keys()) alive.add(pathFor(repo, name))
        const shown = new Set()
        for (const li of section.querySelectorAll('.branch')) {
          shown.add(li.dataset.branch)
          const live = li.querySelector('.live')
          const sha = heads.get(li.dataset.branch)
          if (!sha) Object.assign(live, { hidden: false, className: 'live bad', textContent: 'ветку уже удалили' })
          else if (sha !== li.dataset.sha && (lagging = true))
            Object.assign(live, { hidden: false, className: 'live fresh', textContent: \`есть новые коммиты (\${sha.slice(0, 7)}) — превью догонит через несколько минут\` })
        }
        for (const name of heads.keys()) {
          if (name === section.dataset.default || shown.has(name)) continue
          const li = document.createElement('li')
          li.className = 'branch quiet'
          li.innerHTML = '<span class="name"></span><p class="live fresh">новая ветка — превью готовится</p>'
          li.querySelector('.name').textContent = name
          section.querySelector('ul').append(li)
          lagging = true
        }
      }
      const built = new Date(document.getElementById('built').dateTime)
      if (lagging && Date.now() - built > ${STALE_MINUTES} * 60e3) document.getElementById('stale').hidden = false
      try {
        for (const key of Object.keys(localStorage)) {
          const m = /^branch:(.+?):/.exec(key)
          if (m && !alive.has(m[1]) && checked.has(m[1].split('/')[0])) localStorage.removeItem(key)
        }
      } catch {}
    </script>
  </body>
</html>
`

cpSync(new URL('../site/', import.meta.url), siteDir, { recursive: true })
writeFileSync(join(siteDir, 'plan.json'), JSON.stringify({ ...plan, statuses }, null, 2))
writeFileSync(join(siteDir, 'index.html'), html)
console.error(`index: ${active.length} project(s) with branches, ${idle.length} idle`)
