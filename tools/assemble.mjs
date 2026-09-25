// Finishes the site: static files, the public plan, index.html and home.html.
//
//   node tools/assemble.mjs <plan.json> <site dir> <status.json>
//
// A branch whose build failed has no folder in <site dir>; it is still listed, with a link to the log.
//
// index.html (the listing at /branches/) and home.html (fetched by the user-site root,
// https://newyurk.github.io/, repository newYurk.github.io) are the same page by construction:
// the owner wants both addresses to look identical. A <base href="/branches/"> sends its relative
// links back here, and each game title carries a link to the site published from main.

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

const statusOf = (branch) => statuses[branch.path] ?? { ok: false, gate: null, reason: null, log: runUrl }

// A game's entries are main and its branches, each with the time of its last commit. Only the
// newest one is shown in dark type; the older ones are dimmed to the grey of the secondary text.
// A tie goes to the earlier entry (main comes first); an entry without a time loses to any with one.
// Self-contained on purpose: the listing page runs this very function again after its live check.
function newestOf(times) {
  let best = 0
  let bestAt = -Infinity
  times.forEach((time, i) => {
    const at = Date.parse(time ?? '')
    if (at > bestAt) (best = i), (bestAt = at)
  })
  return best
}

function entriesFor(project, branch) {
  const cfg = config.projects.find((p) => p.repo === project.repo)
  return (cfg.entries ?? [{ path: '', label: 'открыть' }]).filter((e) => {
    const target = join(siteDir, branch.path, e.path)
    return existsSync(e.path === '' || e.path.endsWith('/') ? join(target, 'index.html') : target)
  })
}

// What a reader should know about the game in this preview compared with main.
function compared(b, main) {
  const older = b.behind ? `, а ${main} с тех пор ушла вперёд — игра в превью старее` : ''
  if (b.changed === 'merged') return b.behind ? `всё из ветки уже в ${main}${older}` : `совпадает с ${main}`
  if (b.changed === 'docs') return b.behind ? `только доки${older}` : `только доки — игра как в ${main}`
  if (b.changed === 'same') return b.behind ? `итог правок пуст${older}` : `совпадает с ${main}`
  return null
}

function renderBranch(project, b, older) {
  const status = statusOf(b)
  const entries = status.ok ? entriesFor(project, b) : []
  const href = entries.length ? `./${b.path}/${entries[0].path}` : null
  const meta = [
    b.committedAt ? `<time datetime="${esc(b.committedAt)}">${esc(b.committedAt.slice(0, 16).replace('T', ' '))}</time>` : null,
    b.ahead ? `+${b.ahead} к ${esc(project.defaultBranch)}` : null,
    b.behind ? `отстаёт на ${b.behind}` : null,
    b.pr ? `<a href="${esc(b.pr.url)}">PR #${b.pr.number}${b.pr.draft ? ' · черновик' : ''}</a>` : null,
    `<a href="${esc(b.url)}"><code>${esc(b.sha.slice(0, 7))}</code></a>`,
  ].filter(Boolean)

  const notes = []
  const main = esc(project.defaultBranch)
  if (!status.ok)
    notes.push(`<span class="note bad">превью нет${status.reason ? ` (${esc(status.reason)})` : ''} — <a href="${esc(status.log)}">лог</a></span>`)
  if (status.gate === 'fail')
    notes.push(`<span class="note bad">проверки, которые стоят перед выкладкой ${main}, не прошли — <a href="${esc(status.log)}">лог</a></span>`)
  if (status.gate === 'timeout')
    notes.push(`<span class="note bad">проверки перед выкладкой ${main} не уложились в 10 минут — <a href="${esc(status.log)}">лог</a></span>`)
  if (status.gate === 'later') notes.push(`<span class="note">проверки перед выкладкой ${main} ещё не прогнаны</span>`)
  if (b.note) notes.push(`<span class="note">${esc(b.note)}</span>`)
  const vsMain = compared(b, main)
  if (vsMain) notes.push(`<span class="note">${vsMain}</span>`)

  const more = entries.length > 1 ? entries.map((e) => `<a href="./${esc(b.path)}/${esc(e.path)}">${esc(e.label)}</a>`) : []

  return `
      <li class="branch${older ? ' older' : ''}" data-repo="${esc(project.repo)}" data-branch="${esc(b.branch)}" data-sha="${esc(b.sha)}" data-path="${esc(b.path)}" data-at="${esc(b.committedAt)}">
        ${href ? `<a class="name" href="${esc(href)}">${esc(b.branch)}</a>` : `<span class="name">${esc(b.branch)}</span>`}
        ${b.subject ? `<p class="subject">${esc(b.subject.replace(`[${b.branch}] `, ''))}</p>` : ''}
        <p class="meta">${meta.join('<span class="dot">·</span>')}</p>
        ${more.length ? `<p class="more">${more.join('')}</p>` : ''}
        ${notes.length ? `<p class="notes">${notes.join('')}</p>` : ''}
        <p class="live" hidden></p>
      </li>`
}

function renderMainTip(p, older) {
  const m = p.main
  if (!m?.sha) return ''
  const meta = [
    m.committedAt
      ? `<time datetime="${esc(m.committedAt)}">${esc(m.committedAt.slice(0, 16).replace('T', ' '))}</time>`
      : null,
    `<a href="${esc(m.url)}"><code>${esc(m.sha.slice(0, 7))}</code></a>`,
  ].filter(Boolean)
  return `
      <p class="main-tip${older ? ' older' : ''}" data-sha="${esc(m.sha)}" data-at="${esc(m.committedAt)}">
        <span class="label">${esc(p.defaultBranch)}</span>${
          m.subject ? `<span class="subject-inline">${esc(m.subject)}</span>` : ''
        }<span class="when">${meta.join('<span class="dot">·</span>')}</span>
        <span class="live" hidden></span>
      </p>`
}

function renderProject(p, home) {
  // A game without branches looks like any other; only its tagline says so.
  const idle = p.branches.length === 0
  // Entries in page order: main (when its tip is known), then the branches.
  const first = p.main?.sha ? 1 : 0
  const newest = newestOf([...(first ? [p.main.committedAt] : []), ...p.branches.map((b) => b.committedAt)])
  const live = config.projects.find((item) => item.repo === p.repo)?.live
  const heading =
    home && live
      ? `<span>${esc(p.title)}</span> <a class="main" href="${esc(live)}">${esc(p.defaultBranch)} ↗</a>`
      : esc(p.title)
  return `
    <section class="project" data-repo="${esc(p.repo)}" data-default="${esc(p.defaultBranch)}">
      <h2>${heading}</h2>
      <p class="tagline${p.error ? ' bad' : ''}">${p.error ? 'репозиторий сейчас не прочитать — его превью убраны' : idle ? 'других веток нет' : esc(p.tagline)}</p>
${renderMainTip(p, newest !== 0)}      <ul>${p.branches.map((b, i) => renderBranch(p, b, newest !== first + i)).join('')}
      </ul>
    </section>`
}

const active = plan.projects.filter((p) => p.branches.length)
// Project order follows projects.json (via plan.projects), including idle repos with only main.

function listing(home) {
  return `<!DOCTYPE html>
<html lang="ru"${home ? ' data-home="1"' : ''}>
  <head>
${home ? '    <base href="/branches/" />\n' : ''}    <meta charset="utf-8" />
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
      ${home ? `h2 {
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
      }` : 'h2 { margin: 0; font-size: 1.9rem; }'}
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
      .note.bad, .live.bad, .tagline.bad { color: var(--rust); }
      .live.fresh { color: var(--moss); }
      .empty { margin-top: 2.2rem; color: var(--stone); font-size: 0.9rem; }
      .main-tip {
        margin: 0.15rem 0 0.75rem;
        font-size: 0.78rem;
        color: var(--stone);
        line-height: 1.5;
      }
      .main-tip .label {
        font-family: "IBM Plex Mono", ui-monospace, monospace;
        color: var(--ink);
        margin-right: 0.55em;
      }
      .main-tip .subject-inline {
        margin-right: 0.55em;
        color: var(--ink);
      }
      .main-tip a { text-decoration: none; }
      .main-tip code { font-family: "IBM Plex Mono", ui-monospace, monospace; }
      .main-tip .live { display: block; margin: 0.1rem 0 0; }
      /* In each game only the newest entry (main or a branch, by last commit) stays dark. */
      .older .name, .older .subject, .older .label, .older .subject-inline { color: var(--stone); }
      footer { margin-top: 2.6rem; font-size: 0.78rem; color: var(--stone); line-height: 1.6; }
      #building a { color: inherit; }
    </style>
  </head>
  <body>
    <main>
      <p class="kicker">ветки в работе</p>
      <h1>newYurk</h1>
      <p class="lede">Каждая ветка с GitHub, собранная так же, как собирается main. Основные адреса игр не меняются.
      Где сейчас проекты по вехам и задачам — <a href="overview.html">обзор</a>.</p>
${active.length ? '' : '      <p class="empty">Сейчас ни одной ветки, кроме main.</p>'}
${plan.projects.map((p) => renderProject(p, home)).join('\n')}
      <footer>
        Собрано <time id="built" datetime="${esc(plan.generatedAt)}">${esc(plan.generatedAt.slice(0, 16).replace('T', ' '))} UTC</time>.
        Превью обновляется через пару минут после push; если отстаёт — <a href="${esc(workflowUrl)}">обновить сейчас</a>.
        <span id="building"><br />Проверяю, что сейчас собирается…</span><br />
        Ветки, которые не запушены на GitHub, здесь не видны.
        <span id="stale" class="note bad" hidden><br />Новые коммиты ждут дольше ${STALE_MINUTES} минут — похоже, автопроверка стоит. <a href="${esc(workflowUrl)}">Запустить publish вручную</a>.</span>
      </footer>
    </main>
    <script type="module">
      const OWNER = ${JSON.stringify(config.owner)}
      const SITE = ${JSON.stringify(config.site)}
      const BUILT_RUN = ${JSON.stringify(process.env.GITHUB_RUN_ID ?? null)}

      // Pages lets the browser keep this page for 10 minutes; if a newer build is out, load it.
      // A new query string skips the browser's copy. Once per build, so a slow CDN cannot loop us.
      try {
        const latest = await fetch('./plan.json', { cache: 'no-store' }).then((r) => r.json())
        const once = 'branches-reloaded-' + latest.runId
        if (BUILT_RUN && latest.runId && latest.runId !== BUILT_RUN && !sessionStorage.getItem(once)) {
          sessionStorage.setItem(once, '1')
          location.replace(location.pathname + '?v=' + latest.runId)
        }
      } catch {}
      const api = (path) => fetch(\`https://api.github.com\${path}\`).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
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

      const escText = (s) =>
        String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

      // Live Actions status for the listing builder (publish.yml).
      const buildingEl = document.getElementById('building')
      async function refreshBuilding() {
        if (!buildingEl) return
        try {
          const [running, queued] = await Promise.all([
            api(\`/repos/\${OWNER}/\${SITE}/actions/runs?status=in_progress&per_page=10\`),
            api(\`/repos/\${OWNER}/\${SITE}/actions/runs?status=queued&per_page=10\`),
          ])
          const runs = [...(running.workflow_runs ?? []), ...(queued.workflow_runs ?? [])].filter(
            (r) => (r.path && r.path.includes('publish.yml')) || r.name === 'publish',
          )
          if (!runs.length) {
            buildingEl.innerHTML = '<br />Сейчас ничего не собирается.'
            return
          }
          const r = runs[0]
          const label = escText(r.display_title || r.name || 'publish')
          const when = r.updated_at || r.created_at
          const agoBit = when ? \` · \${ago(when)}\` : ''
          buildingEl.innerHTML = \`<br />Сейчас собирается: <a href="\${escText(r.html_url)}">\${label}</a>\${agoBit}.\`
        } catch {
          buildingEl.innerHTML = '<br />Статус сборки сейчас не прочитать.'
        }
      }
      refreshBuilding()
      setInterval(refreshBuilding, 60_000)

      // Previews keep their saves under "branch:<repo>/<branch>:" (see tools/inject.mjs).
      // Once a branch is gone from GitHub its saves are dead weight in the shared 5 MB.
      const alive = new Set([...document.querySelectorAll('.branch')].map((li) => li.dataset.path))
      const checked = new Set()
      const lagging = []

      // Last commit time of a head this build has not seen: the same field tools/plan.mjs reads.
      const committedAt = (repo, sha) =>
        api(\`/repos/\${OWNER}/\${repo}/commits/\${sha}\`).then((c) => c.commit.committer.date, () => null)
      ${newestOf}
      function markNewest(section) {
        const entries = [...section.querySelectorAll('.main-tip, .branch')]
        const newest = newestOf(entries.map((el) => el.dataset.at))
        entries.forEach((el, i) => el.classList.toggle('older', i !== newest))
        return entries.length
      }

      // Built pages lag behind pushes by a few minutes; say so instead of pretending.
      for (const section of document.querySelectorAll('.project')) {
        const repo = section.dataset.repo
        const heads = new Map()
        try {
          for (let page = 1; page <= 5; page++) {
            const list = await api(\`/repos/\${OWNER}/\${repo}/branches?per_page=100&page=\${page}\`)
            for (const b of list) heads.set(b.name, b.commit.sha)
            if (list.length < 100) break
          }
        } catch {
          continue
        }
        checked.add(repo)
        for (const name of heads.keys()) alive.add(await pathFor(repo, name))
        // A push since this build moves an entry's time to its new commit, and the dark entry may move with it.
        const tip = section.querySelector('.main-tip')
        const mainSha = heads.get(section.dataset.default)
        const mainMoved = Boolean(tip && mainSha && mainSha !== tip.dataset.sha)
        const mainAt = mainMoved ? await committedAt(repo, mainSha) : null
        if (mainAt) tip.dataset.at = mainAt
        const shown = new Set()
        for (const li of section.querySelectorAll('.branch')) {
          shown.add(li.dataset.branch)
          const live = li.querySelector('.live')
          const sha = heads.get(li.dataset.branch)
          if (!sha) {
            // A deleted branch has no last commit any more, so it is never the newest entry.
            delete li.dataset.at
            Object.assign(live, { hidden: false, className: 'live bad', textContent: 'ветку уже удалили' })
          } else if (sha !== li.dataset.sha) {
            lagging.push([repo, li.dataset.branch])
            Object.assign(live, { hidden: false, className: 'live fresh', textContent: \`есть новые коммиты (\${sha.slice(0, 7)}) — превью догонит через несколько минут\` })
            const at = await committedAt(repo, sha)
            if (at) li.dataset.at = at
          }
        }
        for (const [name, sha] of heads) {
          if (name === section.dataset.default || shown.has(name)) continue
          const li = document.createElement('li')
          li.className = 'branch'
          li.innerHTML = '<span class="name"></span><p class="live fresh">новая ветка — превью готовится</p>'
          li.querySelector('.name').textContent = name
          const at = await committedAt(repo, sha)
          if (at) li.dataset.at = at
          section.querySelector('ul').append(li)
          lagging.push([repo, name])
        }
        // A moved main gets a plain note, never a promise and never the stuck warning. Every publish run
        // re-reads all the games, but runs start only from branch-preview.yml in a game (push, branch
        // deletion, pull request), a push here, a manual run, publish.yml's own retry, or the scheduled
        // watch.yml that GitHub runs hours apart, so the main of a game without branch-preview.yml
        // (temari-sim) can wait hours for the listing. The note shows whenever main moved and the game has
        // more than one entry, dark or grey; it explains a dark main whose line still shows an older commit.
        // A game whose only entry is main needs none.
        if (markNewest(section) > 1 && mainMoved)
          Object.assign(tip.querySelector('.live'), { hidden: false, className: 'live', textContent: \`есть новые коммиты (\${mainSha.slice(0, 7)}\${mainAt ? ', ' + ago(mainAt) : ''})\` })
      }

      // The watcher is stuck if a push is older than ${STALE_MINUTES} minutes and still not built.
      // The push time comes from the repository activity feed, not from the commit date.
      for (const [repo, name] of lagging.slice(0, 5)) {
        try {
          const [push] = await api(\`/repos/\${OWNER}/\${repo}/activity?ref=\${encodeURIComponent('refs/heads/' + name)}&per_page=1\`)
          if (push && Date.now() - new Date(push.timestamp) > ${STALE_MINUTES} * 60e3) {
            document.getElementById('stale').hidden = false
            break
          }
        } catch {}
      }
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
}

cpSync(new URL('../site/', import.meta.url), siteDir, { recursive: true })
// runId lets publish.yml tell this deploy from the previous one even when nothing else changed.
writeFileSync(join(siteDir, 'plan.json'), JSON.stringify({ ...plan, runId: process.env.GITHUB_RUN_ID ?? null, statuses }, null, 2))
const page = listing(true)
writeFileSync(join(siteDir, 'index.html'), page)
writeFileSync(join(siteDir, 'home.html'), page)
console.error(`index: ${active.length} project(s) with branches, ${plan.projects.length - active.length} idle (order = projects.json)`)
