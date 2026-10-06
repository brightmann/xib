/**
 * xib blog worker — Cloudflare Workers port of xiongwilee/iblog
 * Server-side renders GitHub issues as a blog.
 * Uses plain template literals (nunjucks uses new Function(), forbidden on Workers).
 * GitHub token stays server-side (Worker secret), never exposed to clients.
 * Auto-deploy check: pushes to master build and deploy via `npx wrangler deploy`.
 */

// ---------------------------------------------------------------------------
// Helpers (ported from controller/base.js)
// ---------------------------------------------------------------------------
function zeroPad(num) { return ('0' + num).slice(-2); }

function formatTime(time) {
  const d = new Date(time);
  return `${d.getFullYear()}-${zeroPad(d.getMonth() + 1)}-${zeroPad(d.getDate())} ${zeroPad(d.getHours())}:${zeroPad(d.getMinutes())}:${zeroPad(d.getSeconds())}`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getPostIntro(body) {
  const blank = /^\s+$/;
  let n = 0;
  return body.split('\n').filter(line => {
    if (n < 5 && !blank.test(line)) { n++; return true; }
    return false;
  }).join('\n');
}

function getPostQuery(body) {
  const result = {};
  if (!body) return result;
  const re = /^\[(\w+)\]\:([\s|\S]+)/;
  for (const line of body.split('\n')) {
    const m = line.match(re);
    if (m && m.length === 3) result[m[1]] = (m[2] || '').trim();
    else break;
  }
  return result;
}

function getPost(post) {
  if (!post || !post.body) return {};
  const q = getPostQuery(post.body);
  return Object.assign({}, post, {
    intro: q.intro || getPostIntro(post.body),
    query: q,
    create_time: formatTime(post.created_at),
    update_time: formatTime(post.updated_at),
  });
}

const PER_PAGE = 5;

// GitHub's issues API now uses cursor pagination (Link header has rel="next"
// with an `after` cursor but no rel="last"), so a single request can't tell us
// the total page count. Fetch all open issues (capped at 500) and paginate
// in the worker instead.
async function fetchAllIssues(env, label) {
  const issues = [];
  let path = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues?state=open&filter=created&per_page=100` +
    (label ? `&labels=${encodeURIComponent(label)}` : '');
  for (let i = 0; i < 5 && path; i++) {
    const res = await gh(path, env);
    if (res.status !== 200 || !Array.isArray(res.body)) break;
    issues.push(...res.body);
    const link = res.headers.get('link') || '';
    const m = link.match(/<([^>]+)>\s*;\s*rel="next"/);
    path = m ? m[1].replace(/^https:\/\/api\.github\.com/, '') : null;
  }
  return issues;
}

function paginate(items, pageParam) {
  const total = Math.max(1, Math.ceil(items.length / PER_PAGE));
  const curr = Math.min(Math.max(parseInt(pageParam) || 1, 1), total);
  return {
    page: { curr, total },
    list: items.slice((curr - 1) * PER_PAGE, curr * PER_PAGE).map(getPost),
  };
}

// ---------------------------------------------------------------------------
// Templates (plain functions; ported from views/)
// ---------------------------------------------------------------------------
function tplHeader(siteInfo) {
  const bg = siteInfo.banner ? ` style="background-image: url(${esc(siteInfo.banner)})"` : '';
  return `<header class="header"${bg}>
  <nav class="top"><div class="container"><a class="home" href="/">home</a></div></nav>
  <div class="banner"><div class="container">
    <h1 class="title">${esc(siteInfo.name)}</h1>
    <span class="sub-title">${esc(siteInfo.intro)}</span>
  </div></div>
</header>`;
}

function tplRightbar(ownerInfo, labelInfo, siteInfo) {
  const links = (siteInfo.links || []).map(l =>
    `<li class="rightbar-list"><a class="rightbar-link" href="${esc(l.url)}">${esc(l.name)}</a></li>`
  ).join('\n      ');
  return `<div class="rightbar">
  <div class="avatar">
    <a class="avatar-link" href="${esc(ownerInfo.html_url)}"><img class="avatar-image" src="${esc(ownerInfo.avatar_url)}"></a>
    <h3 class="avatar-title">${esc(ownerInfo.name)}</h3>
    <span class="avatar-intro">${esc(ownerInfo.bio)}</span>
  </div>
  <div class="opera" id="rightbarOpera"><a class="opera-link" href="#"><i class="fa icon-reorder"></i></a></div>
  <div class="links rightbar-item"><h3 class="rightbar-title">LINKS</h3>
    <ul class="rightbar-ul">${links}</ul>
  </div>
</div>`;
}

function tplFooter(siteInfo) {
  return `<footer class="footer"><div class="container">
    <p>Copyright © ${siteInfo.year} ${esc(siteInfo.name)} </p>
    <p>Powered by <a href="https://github.com/brightmann/xib">xib</a> on Cloudflare Workers</p>
  </div></div></footer>`;
}

function tplPostHeader(postInfo, siteInfo) {
  const banner = postInfo.query.image || siteInfo.banner;
  const bg = banner ? ` style="background-image: url(${esc(banner)})"` : '';
  const labels = (postInfo.labels || []).map(l =>
    `<a class="label-link" href="/post/label/${esc(l.name)}">${esc(l.name)}</a>`
  ).join('');
  return `<header class="post-header"${bg}>
  <nav class="top"><div class="container"><a class="home" href="/">home</a></div></nav>
  <div class="banner"><div class="container">
    <h1 class="title">${esc(postInfo.title)}</h1>
    <span class="sub-title">${esc(postInfo.intro)}</span>
    <div class="label">${labels}</div>
    <div class="opera">
      <a class="opera-item link" href="${esc(postInfo.user.html_url)}">${esc(postInfo.user.login)}</a> • <span class="opera-item">${esc(postInfo.update_time)}</span> • <a class="opera-item link" href="${esc(postInfo.html_url)}">view on github</a>
    </div>
  </div></div>
</header>`;
}

function pageNav(curr, total) {
  const nums = [...new Set([1, total, curr - 1, curr, curr + 1])]
    .filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
  let html = '';
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) html += '<span class="page-ellipsis">...</span>';
    html += n === curr
      ? `<span class="page-item page-num active">${n}</span>`
      : `<a class="page-item page-num" href="?page=${n}">${n}</a>`;
    prev = n;
  }
  const prevBtn = curr > 1
    ? `<a class="page-item page-prev" href="?page=${curr - 1}">Previous</a>`
    : '<span class="page-item page-prev disabled">Previous</span>';
  const nextBtn = curr < total
    ? `<a class="page-item page-next" href="?page=${curr + 1}">Next</a>`
    : '<span class="page-item page-next disabled">Next</span>';
  return `<div class="post-list-page">${prevBtn}${html}${nextBtn}</div>`;
}

function tplPostList(postInfo) {
  const items = (postInfo.list || []).map(post => {
    const slider = post.query.type === 'slider'
      ? `<a class="post-list-link post-list-link-icon" title="post slider" href="/post/slider/${post.number}"><i class="fa icon-facetime-video"></i></a> • ` : '';
    const img = post.query.image
      ? `<div class="post-list-image" style="background-image: url(${esc(post.query.image)})"></div>` : '';
    return `<article class="post-list-item">
    <h3 class="post-list-title"><a class="post-list-link" href="/post/detail/${post.number}">${esc(post.title)}</a></h3>${img}
    <div class="post-list-intro">${esc(post.intro)} <a class="post-list-link read-more" href="/post/detail/${post.number}">read more...</a></div>
    <div class="post-list-opera">${slider}<a class="post-list-opera-item post-list-link" href="${esc(post.user.html_url)}" title="post author">${esc(post.user.login)}</a> • <span class="post-list-opera-item">${esc(post.update_time)}</span> • <a class="post-list-opera-item post-list-link" href="/post/detail/${post.number}#comments" title="post comments">${post.comments} Comments</a></div>
  </article>`;
  }).join('\n  ');
  return `<div class="post-list">
  ${items || '<p>No posts yet.</p>'}
  ${pageNav(postInfo.page.curr, postInfo.page.total)}
</div>`;
}

function tplLayout(o) {
  // o: { title, siteInfo, ownerInfo, labelInfo, headerHtml, mainHtml, headExtra, footExtra, constant }
  return `<!DOCTYPE HTML>
<html class="theme">
<head>
  <title>${esc(o.title)}</title>
  <meta name="viewport" content="width=device-width,user-scalable=no">
  <link rel="icon" href="/static/image/favicon.ico">
  <script src="/static/js/lib/require.js" type="text/javascript"></script>
  <script src="/static/js/require.config.js" type="text/javascript"></script>
  <script type="text/javascript">window.CONSTANT = ${o.constant ? JSON.stringify(o.constant) : '{}'};</script>
  ${o.headExtra || ''}
</head>
<body>
  ${o.headerHtml}
  <section class="main"><div class="container clearfix">
    <div class="main-right">${tplRightbar(o.ownerInfo, o.labelInfo, o.siteInfo)}</div>
    <div class="main-left">${o.mainHtml}</div>
  </div></section>
  ${o.footExtra || ''}
  ${tplFooter(o.siteInfo)}
</body>
</html>`;
}

function pageHome(ctx) {
  return tplLayout({
    title: ctx.siteInfo.title,
    siteInfo: ctx.siteInfo,
    ownerInfo: ctx.ownerInfo,
    labelInfo: ctx.labelInfo,
    headerHtml: tplHeader(ctx.siteInfo),
    mainHtml: tplPostList(ctx.postInfo),
    headExtra: '<link rel="stylesheet" href="/static/css/home/index.css" type="text/css">',
    footExtra: '<script src="/static/js/home/index.js" type="text/javascript"></script>',
  });
}

function pagePostDetail(ctx) {
  const postHtml = `<div class="post-detail">
  <div class="post-container" id="postContainer">${ctx.postInfo.body_html || ''}</div>
  <div class="post-footer">${ctx.postInfo.query.type === 'slider' ? `<a class="post-footer-play" href="/post/slider/${ctx.postInfo.number}"><i class="fa icon-facetime-video"></i></a>` : ''}</div>
</div>`;
  return tplLayout({
    title: `${ctx.postInfo.title} - ${ctx.siteInfo.title}`,
    siteInfo: ctx.siteInfo,
    ownerInfo: ctx.ownerInfo,
    labelInfo: ctx.labelInfo,
    headerHtml: tplPostHeader(ctx.postInfo, ctx.siteInfo),
    mainHtml: postHtml,
    headExtra: '<link rel="stylesheet" href="/static/css/post/detail.css" type="text/css">',
    constant: ctx.constant,
  });
}

function pageLabel(ctx) {
  return tplLayout({
    title: ctx.siteInfo.title,
    siteInfo: ctx.siteInfo,
    ownerInfo: ctx.ownerInfo,
    labelInfo: ctx.labelInfo,
    headerHtml: tplHeader(ctx.siteInfo),
    mainHtml: tplPostList(ctx.postInfo),
    headExtra: '<link rel="stylesheet" href="/static/css/post/label.css" type="text/css">',
    footExtra: '<script src="/static/js/post/label.js" type="text/javascript"></script>',
  });
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------
async function gh(path, env, accept) {
  const headers = {
    'Accept': accept || 'application/vnd.github.v3+json',
    'User-Agent': 'xib-worker',
  };
  if (env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, headers: res.headers, body };
}

async function getDefaultData(env) {
  const owner = env.GITHUB_OWNER, repo = env.GITHUB_REPO;
  const [userRes, repoRes, labelRes] = await Promise.all([
    gh(`/users/${owner}`, env),
    gh(`/repos/${owner}/${repo}`, env),
    gh(`/repos/${owner}/${repo}/labels`, env),
  ]);
  return {
    ownerInfo: userRes.body || {},
    labelInfo: Array.isArray(labelRes.body) ? labelRes.body : [],
    siteInfo: {
      description: (repoRes.body || {}).description || '',
      logo: '',
      name: env.SITE_NAME || owner,
      intro: env.SITE_INTRO || '',
      title: env.SITE_TITLE || `${owner}'s Blog`,
      year: new Date().getFullYear(),
      banner: env.SITE_BANNER || '',
      links: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function handleHome(url, env) {
  const def = await getDefaultData(env);
  const pg = paginate(await fetchAllIssues(env), url.searchParams.get('page'));
  return new Response(pageHome({
    ownerInfo: def.ownerInfo, labelInfo: def.labelInfo,
    siteInfo: def.siteInfo, postInfo: pg,
  }), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
}

async function handlePostDetail(id, env) {
  const def = await getDefaultData(env);
  const res = await gh(`/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues/${id}`, env,
    'application/vnd.github.v3.full+json');
  if (res.status !== 200) return new Response('Post not found', { status: 404 });
  const postInfo = getPost(res.body);
  return new Response(pagePostDetail({
    ownerInfo: def.ownerInfo, labelInfo: def.labelInfo,
    siteInfo: def.siteInfo, postInfo,
    constant: { issues_id: parseInt(id) || 1, html_url: postInfo.html_url },
  }), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
}

async function handleLabel(label, url, env) {
  const def = await getDefaultData(env);
  const pg = paginate(await fetchAllIssues(env, label), url.searchParams.get('page'));
  return new Response(pageLabel({
    ownerInfo: def.ownerInfo, labelInfo: def.labelInfo,
    siteInfo: Object.assign({}, def.siteInfo, { label }), postInfo: pg,
  }), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/' || path === '/index.html') return handleHome(url, env);
    let m = path.match(/^\/post\/detail\/(\d+)$/);
    if (m) return handlePostDetail(m[1], env);
    m = path.match(/^\/post\/label\/([^/]+)$/);
    if (m) return handleLabel(decodeURIComponent(m[1]), url, env);
    // Static files: wrangler.jsonc serves ./static as the assets directory,
    // so strip the /static prefix and serve from the ASSETS binding.
    if (path === '/static' || path.startsWith('/static/')) {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = path.replace(/^\/static/, '') || '/';
      const res = await env.ASSETS.fetch(new Request(assetUrl, request));
      if (res.status !== 404) return res;
    }
    return new Response('Not found', { status: 404 });
  },
};
