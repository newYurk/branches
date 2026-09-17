// Prepares a built branch for living next to the real games on the same origin.
//
//   node tools/inject.mjs <dir> <repo> <branch> <sha> <path>
//
// Every .html page gets one inline script, placed before any other script, that
//   - keeps the branch's localStorage writes under its own prefix, so a preview
//     can never overwrite the saves of the game served from main (reads fall
//     through to main's values, so the preview starts from your real progress);
//   - drops requests to the counter hosts listed in projects.json (blockHosts), so previews
//     do not count as players;
//   - shows a small "⎇ branch · sha" label and marks the tab title.
// Links to the game's own live address and to its files at main are pointed at the branch.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { urlBranch } from './plan.mjs'

const [dir, repo, branch, sha, path] = process.argv.slice(2)
if (!path) {
  console.error('usage: node tools/inject.mjs <dir> <repo> <branch> <sha> <path>')
  process.exit(2)
}
const config = JSON.parse(readFileSync(new URL('../projects.json', import.meta.url), 'utf8'))
const project = config.projects.find((p) => p.repo === repo) ?? {}
const block = [...(config.blockHosts ?? []), ...(project.blockHosts ?? [])]

const data = JSON.stringify({ repo, branch, sha, path, block }).replace(/</g, '\\u003c')

// Kept dependency-free and ES2015 so it runs before anything the page loads.
const SHIM = `<script data-branch-preview>(function () {
  var B = ${data};
  var NS = 'branch:' + B.path + ':';
  var GONE = '\\u0000removed-in-branch';

  try {
    var ls = window.localStorage;
    var P = Storage.prototype;
    var get = P.getItem, set = P.setItem, del = P.removeItem, key = P.key, clear = P.clear;
    var len = Object.getOwnPropertyDescriptor(P, 'length').get;
    var mine = function (s) { return s === ls; };
    var visible = function (s) {
      var own = Object.create(null), out = [], i, k;
      for (i = 0; i < len.call(s); i++) {
        k = key.call(s, i);
        if (k.indexOf(NS) === 0) own[k.slice(NS.length)] = get.call(s, k) !== GONE;
      }
      for (i = 0; i < len.call(s); i++) {
        k = key.call(s, i);
        if (k.indexOf('branch:') !== 0 && !(k in own)) out.push(k);
      }
      for (k in own) if (own[k]) out.push(k);
      return out;
    };
    P.getItem = function (k) {
      if (!mine(this)) return get.call(this, k);
      k = String(k);
      var v = get.call(this, NS + k);
      if (v === GONE) return null;
      return v !== null ? v : get.call(this, k);
    };
    P.setItem = function (k, v) {
      return mine(this) ? set.call(this, NS + String(k), String(v)) : set.call(this, k, v);
    };
    // Native removeItem never throws; a tombstone write could, when the shared 5 MB is full.
    var drop = function (s, k) {
      if (get.call(s, k) === null) return del.call(s, NS + k);
      try { set.call(s, NS + k, GONE); } catch (e) {
        del.call(s, NS + k);
        try { set.call(s, NS + k, GONE); } catch (e2) {}
      }
    };
    P.removeItem = function (k) {
      return mine(this) ? drop(this, String(k)) : del.call(this, k);
    };
    P.key = function (i) {
      if (!mine(this)) return key.call(this, i);
      var all = visible(this);
      i = Math.floor(Number(i)) || 0;
      return i >= 0 && i < all.length ? all[i] : null;
    };
    P.clear = function () {
      if (!mine(this)) return clear.call(this);
      var all = visible(this);
      for (var i = 0; i < all.length; i++) drop(this, all[i]);
    };
    Object.defineProperty(P, 'length', {
      configurable: true,
      get: function () { return mine(this) ? visible(this).length : len.call(this); },
    });

    // localStorage.x = 1, localStorage[k], delete, Object.keys(localStorage): same rules.
    var named = function (k) { return typeof k === 'string' && !(k in P); };
    var proxy = new Proxy(ls, {
      get: function (t, k) {
        if (!named(k)) {
          var v = Reflect.get(t, k, t);
          return typeof v === 'function' ? v.bind(t) : v;
        }
        var got = P.getItem.call(t, k);
        return got === null ? undefined : got;
      },
      set: function (t, k, v) {
        if (named(k)) P.setItem.call(t, k, v);
        return true;
      },
      has: function (t, k) { return named(k) ? P.getItem.call(t, k) !== null : k in t; },
      deleteProperty: function (t, k) {
        if (named(k)) P.removeItem.call(t, k);
        return true;
      },
      ownKeys: function (t) { return visible(t); },
      getOwnPropertyDescriptor: function (t, k) {
        var got = named(k) ? P.getItem.call(t, k) : null;
        return got === null ? undefined : { value: got, writable: true, enumerable: true, configurable: true };
      },
      defineProperty: function (t, k, d) {
        if (named(k) && 'value' in d) P.setItem.call(t, k, d.value);
        return true;
      },
    });
    Object.defineProperty(window, 'localStorage', { configurable: true, enumerable: true, get: function () { return proxy; } });
  } catch (e) {}

  var blocked = function (url) {
    try {
      var host = new URL(String(url), location.href).hostname;
      return B.block.some(function (h) { return host === h || host.slice(-h.length - 1) === '.' + h; });
    } catch (e) { return false; }
  };
  try {
    var src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true, enumerable: src.enumerable, get: src.get,
      set: function (v) { if (!blocked(v)) src.set.call(this, v); },
    });
    var fetch0 = window.fetch;
    if (fetch0) window.fetch = function (input) {
      if (blocked(input && input.url || input)) return Promise.resolve(new Response(null, { status: 204 }));
      return fetch0.apply(this, arguments);
    };
    var beacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
    if (beacon) navigator.sendBeacon = function (url) { return blocked(url) ? true : beacon.apply(null, arguments); };
  } catch (e) {}

  var label = function () {
    if (!document.body || document.querySelector('branch-preview-label')) return;
    var el = document.createElement('branch-preview-label');
    el.textContent = '\\u2387 ' + B.branch + ' \\u00b7 ' + B.sha.slice(0, 7);
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'all:initial;position:fixed;z-index:2147483647;pointer-events:none;' +
      'left:50%;top:calc(env(safe-area-inset-top, 0px) + 4px);transform:translateX(-50%);' +
      'max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'padding:1px 8px;border-radius:999px;background:rgba(12,11,9,.55);color:#ece8e1;' +
      'font:500 10px/16px ui-monospace,SFMono-Regular,Menlo,monospace;';
    document.body.appendChild(el);
    if (document.title.indexOf('\\u2387') !== 0) document.title = '\\u2387 ' + document.title;
    // Games use the top of the screen too: after a few seconds only a faint glyph stays.
    setTimeout(function () {
      el.textContent = '\\u2387';
      el.style.opacity = '0.45';
    }, 5000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', label);
  else label();
})();</script>
<meta name="robots" content="noindex" />
`

function inject(html) {
  if (html.includes('data-branch-preview')) return html
  // Search a copy with comments blanked out (same length, so positions still match).
  const bare = html.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length))
  const charset = /<meta\s+charset=[^>]*>/i.exec(bare)
  const head = /<head(\s[^>]*)?>/i.exec(bare)
  const firstScript = /<script[\s>]/i.exec(bare)
  let at
  if (charset) at = charset.index + charset[0].length
  else if (head) at = head.index + head[0].length
  else {
    const doctype = /<!doctype[^>]*>/i.exec(bare)
    at = doctype ? doctype.index + doctype[0].length : 0
  }
  // Never after a script of the page itself.
  if (firstScript && firstScript.index < at) at = firstScript.index
  return html.slice(0, at) + '\n' + SHIM + html.slice(at)
}

// Pages link to their own game by full address ("живой стенд" in the Roti overview) and to their
// docs on GitHub at main. Inside a preview both should stay on the branch.
const host = `${config.owner.toLowerCase()}.github.io`
const liveRe = new RegExp(`(https?:)?//${host.replace(/\./g, '\\.')}/${repo}/`, 'gi')
const branchInUrl = urlBranch(branch).replace(/'/g, '%27')
const blobRe = new RegExp(`(github\\.com/${config.owner}/${repo}/(?:blob|tree))/main/`, 'gi')
function rewrite(html) {
  return html
    .replace(liveRe, (_, scheme) => `${scheme ?? ''}//${host}${config.base}/${path}/`)
    .replace(blobRe, (_, prefix) => `${prefix}/${branchInUrl}/`)
}

function* htmlFiles(d) {
  for (const name of readdirSync(d)) {
    const full = join(d, name)
    if (statSync(full).isDirectory()) yield* htmlFiles(full)
    else if (/\.html?$/i.test(name)) yield full
  }
}

let n = 0
for (const file of htmlFiles(dir)) {
  writeFileSync(file, inject(rewrite(readFileSync(file, 'utf8'))))
  n++
}
console.error(`inject: ${n} page(s) in ${dir}`)
