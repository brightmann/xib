/**
 * xib blog worker — Cloudflare Workers port of xiongwilee/iblog
 * Server-side renders GitHub issues as a blog using Nunjucks templates.
 * GitHub token stays server-side (Worker secret), never exposed to clients.
 */

import nunjucks from 'nunjucks';

// ---------------------------------------------------------------------------
// Templates (ported from views/, asset paths rewritten /iblog/static -> /static)
// ---------------------------------------------------------------------------
const T = {};

// Layout
T['common/layout.html'] = `<!DOCTYPE HTML>
<html class="theme">
<head>
  <title>{% block title %}{{siteInfo.title}}{% endblock %}</title>
  <meta name="viewport" content="width=device-width,user-scalable=no">
  <link rel="icon" href="/static/image/favicon.ico">
  <script src="/static/js/lib/require.js" type="text/javascript"></script>
  <script src="/static/js/require.config.js" type="text/javascript"></script>
  <script type="text/javascript">
    window.CONSTANT = {% if constant %}{{constant | dump | safe}}{% else %}{}{% endif %};
  </script>
  {% block head %}{% endblock %}
</head>
<body>
  {% block body %} 
  {% block header %} 
  {% include "./header.html" %}
  {% endblock %}
  <section class="main">
    <div class="container clearfix">
      {% block main %}
      <div class="main-right">
        {% include "./rightbar.html"%}
      </div>
      <div class="main-left">
        {% block content %} {% endblock %}
      </div>
      {% endblock %}
    </div>
  </section>
  {% endblock %} {% block foot %} {% endblock %} {% include "./footer.html" %}
</body>
</html>`;

T['common/header.html'] = `<header class="header" style="background-image: url({{siteInfo.banner}})">
  <nav class="top">
    <div class="container">
      <a class="home" href="/">home</a>
    </div>
  </nav>
  <div class="banner">
    <div class="container">
      <h1 class="title">{{siteInfo.name}}</h1>
      <span class="sub-title">{{siteInfo.intro}}</span>
    </div>
  </div>
</header>`;

T['common/rightbar.html'] = `<div class="rightbar">
  <div class="avatar">
    <a class="avatar-link" href="{{ownerInfo.html_url}}"><img class="avatar-image" src="{{ownerInfo.avatar_url}}"></a>
    <h3 class="avatar-title">{{ownerInfo.name}}</h3>
    <span class="avatar-intro">{{ownerInfo.bio}}</span>
  </div>
  <div class="opera" id="rightbarOpera">
    <a class="opera-link" href="#"><i class="fa icon-reorder"></i></a>
  </div>
  <div class="nav rightbar-item">
    <h3 class="rightbar-title">LABELS</h3>
    <ul class="rightbar-ul">
      <li class="rightbar-list {{ 'active' if (not siteInfo.label)}}"><a class="rightbar-link" href="/">home</a></li>
      {% for label in labelInfo %}
      <li class="rightbar-list {{ 'active' if label.name == siteInfo.label}}"><a class="rightbar-link" href="/post/label/{{label.name}}">{{label.name}}</a></li>
      {% endfor %}
    </ul>
  </div>
  <div class="links rightbar-item">
    <h3 class="rightbar-title">LINKS</h3>
    <ul class="rightbar-ul">
      {% for link in siteInfo.links %}
      <li class="rightbar-list"><a class="rightbar-link" href="{{link.url}}">{{link.name}}</a></li>
      {% endfor %}
    </ul>
  </div>
</div>`;

T['common/footer.html'] = `<footer class="footer">
  <div class="container">
    <p>Copyright © {{siteInfo.year}} {{siteInfo.name}} </p>
    <p>Powered by <a href="https://github.com/brightmann/xib">xib</a> on Cloudflare Workers</p>
  </div>
</footer>`;

T['common/post-header.html'] = `<header class="post-header" style="background-image: url({{postInfo.query.image or siteInfo.banner}})">
  <nav class="top">
    <div class="container">
      <a class="home" href="/">home</a>
    </div>
  </nav>
  <div class="banner">
    <div class="container">
      <h1 class="title">{{postInfo.title}}</h1>
      <span class="sub-title">{{postInfo.intro}}</span>
      <div class="label">
        {% for label in postInfo.labels%}<a class="label-link" href="/post/label/{{label.name}}">{{label.name}}</a>{% endfor %}
      </div>
      <div class="opera">
        <a class="opera-item link" href="{{postInfo.user.html_url}}">{{postInfo.user.login}}</a> • <span class="opera-item">{{postInfo.update_time}}</span> • <a class="opera-item link" href="{{postInfo.html_url}}">view on github</a>
      </div>
    </div>
  </div>
</header>`;

T['common/post-list.html'] = `<div class="post-list">
  {% for post in postInfo.list %}
  <article class="post-list-item">
    <h3 class="post-list-title"><a class="post-list-link" href="/post/detail/{{post.number}}">{{post.title}}</a></h3> {% if post.query.image %}
    <div class="post-list-image" style="background-image: url({{post.query.image}})"></div>
    {% endif %}
    <div class="post-list-intro"><a class="post-list-link" href="/post/detail/{{post.number}}">{{post.intro}}</a></div>
    <div class="post-list-opera">{% if post.query.type == 'slider' %}<a class="post-list-link post-list-link-icon" title="post slider" href="/post/slider/{{post.number}}"><i class="fa icon-facetime-video"></i></a> • {% endif %}<a class="post-list-opera-item post-list-link" href="{{post.user.html_url}}" title="post author">{{post.user.login}}</a> • <span class="post-list-opera-item">{{post.update_time}}</span> • <a class="post-list-opera-item post-list-link" href="/post/detail/{{post.number}}#comments" title="post comments">{{post.comments}} Comments</a></div>
  </article>
  {% else %} <p>No posts yet.</p> {% endfor %}
  <div class="post-list-page">
    {% if postInfo.page.prev %}<a class="page-item page-prev" href="?page={{postInfo.page.prev}}"><i class="fa icon-angle-left"></i></a>{% endif %}
    <span class="page-item page-curr">{{postInfo.page.curr}} / {{postInfo.page.total}}</span>
    {% if postInfo.page.next %}<a class="page-item page-next" href="?page={{postInfo.page.next}}"><i class="fa icon-angle-right"></i></a>{% endif %}
  </div>
</div>`;

T['common/post-detail.html'] = `<div class="post-detail">
  <div class="post-container" id="postContainer">
    {{postInfo.body_html | safe}}
  </div>
  <div class="post-footer">
    {% if postInfo.query.type == 'slider' %}<a class="post-footer-play" href="/post/slider/{{postInfo.number}}"><i class="fa icon-facetime-video"></i></a>{% endif %}
  </div>
</div>`;

T['home.html'] = `{% extends "./common/layout.html" %}
{% block head %}
<link rel="stylesheet" href="/static/css/home/index.css" type="text/css">
{% endblock %}
{% block content %}
  {% include './common/post-list.html'%}
{% endblock %}
{% block foot %}
<script src="/static/js/home/index.js" type="text/javascript"></script>
{% endblock %}`;

T['post-detail.html'] = `{% extends "./common/layout.html" %}
{% block head %}
<link rel="stylesheet" href="/static/css/post/detail.css" type="text/css">
{% endblock %}
{% block header %}
  {% include './common/post-header.html'%}
{% endblock %}
{% block main %}
  {% include './common/post-detail.html'%}
{% endblock %}`;

T['post-label.html'] = `{% extends "./common/layout.html" %}
{% block head %}
<link rel="stylesheet" href="/static/css/post/label.css" type="text/css">
{% endblock %}
{% block content %}
  {% include './common/post-list.html'%}
{% endblock %}
{% block foot %}
<script src="/static/js/post/label.js" type="text/javascript"></script>
{% endblock %}`;

function zeroPad(num) { return ('0' + num).slice(-2); }

function formatTime(time) {
  const d = new Date(time);
  return `${d.getFullYear()}-${zeroPad(d.getMonth() + 1)}-${zeroPad(d.getDate())} ${zeroPad(d.getHours())}:${zeroPad(d.getMinutes())}:${zeroPad(d.getSeconds())}`;
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
  const lines = body.split('\n');
  for (const line of lines) {
    const m = line.match(re);
    if (m && m.length === 3) {
      result[m[1]] = (m[2] || '').trim();
    } else break;
  }
  return result;
}

function getPost(post) {
  if (!post || !post.body) return {};
  const q = getPostQuery(post.body);
  const intro = q.intro || getPostIntro(post.body);
  return Object.assign({}, post, {
    intro,
    query: q,
    create_time: formatTime(post.created_at),
    update_time: formatTime(post.updated_at),
  });
}

function getPage(linkHeader) {
  const result = {};
  if (!linkHeader) return result;
  const re = /(<([\S]+)>)[\S\s]+"([\w]+)"/;
  linkHeader.split(',').forEach(item => {
    const m = item.match(re);
    if (m && m.length === 4) {
      try {
        const u = new URL(m[2]);
        result[m[3]] = parseInt(u.searchParams.get('page')) || 1;
      } catch (e) {}
    }
  });
  return result;
}

function getPostList(items, linkHeader) {
  const pageInfo = getPage(linkHeader);
  const list = (Array.isArray(items) ? items : []).map(getPost);
  return { page: pageInfo, list };
}

class ObjLoader extends nunjucks.Loader {
  getSource(name) {
    let key = name.replace(/^\.\//, '');
    const parts = key.split('/');
    if (parts.length > 2) key = parts.slice(-2).join('/');
    if (T[key]) return { src: T[key], path: key, noCache: true };
    return null;
  }
}
const nj = new nunjucks.Environment(new ObjLoader(), { autoescape: true });
function render(name, ctx) {
  const key = name.replace(/^\.\//, '');
  return nj.render(key, ctx);
}

async function gh(path, env, accept) {
  const headers = {
    'Accept': accept || 'application/vnd.github.v3+json',
    'User-Agent': 'xib-worker',
  };
  if (env.GITHUB_TOKEN) {
    headers['Authorization'] = `token ${env.GITHUB_TOKEN}`;
  }
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
  const siteInfo = Object.assign(
    { description: (repoRes.body || {}).description || '' },
    {
      logo: '',
      name: env.SITE_NAME || owner,
      intro: env.SITE_INTRO || '',
      title: env.SITE_TITLE || `${owner}'s Blog`,
      year: new Date().getFullYear(),
      banner: env.SITE_BANNER || '',
      links: [],
    }
  );
  return {
    ownerInfo: userRes.body || {},
    repoInfo: repoRes.body || {},
    labelInfo: Array.isArray(labelRes.body) ? labelRes.body : [],
    siteInfo,
  };
}

async function handleHome(url, env) {
  const page = parseInt(url.searchParams.get('page')) || 1;
  const def = await getDefaultData(env);
  const res = await gh(`/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues?state=open&filter=created&page=${page}`, env);
  const postInfo = getPostList(res.body, res.headers.get('link'));
  postInfo.page.curr = page;
  postInfo.page.total = postInfo.page.last || 1;
  const html = render('home.html', {
    ownerInfo: def.ownerInfo,
    labelInfo: def.labelInfo,
    siteInfo: def.siteInfo,
    postInfo,
  });
  return new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
}

async function handlePostDetail(id, env) {
  const def = await getDefaultData(env);
  const res = await gh(`/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues/${id}`, env,
    'application/vnd.github.v3.full+json');
  if (res.status !== 200) {
    return new Response('Post not found', { status: 404 });
  }
  const postInfo = getPost(res.body);
  const siteInfo = Object.assign({}, def.siteInfo, {
    title: `${postInfo.title} - ${def.siteInfo.title}`,
  });
  const html = render('post-detail.html', {
    constant: { issues_id: parseInt(id) || 1, html_url: postInfo.html_url },
    ownerInfo: def.ownerInfo,
    labelInfo: def.labelInfo,
    siteInfo,
    postInfo,
  });
  return new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
}

async function handleLabel(label, url, env) {
  const page = parseInt(url.searchParams.get('page')) || 1;
  const def = await getDefaultData(env);
  const res = await gh(`/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues?state=open&filter=created&page=${page}&labels=${encodeURIComponent(label)}`, env);
  const postInfo = getPostList(res.body, res.headers.get('link'));
  postInfo.page.curr = page;
  postInfo.page.total = postInfo.page.last || 1;
  const siteInfo = Object.assign({}, def.siteInfo, { label });
  const html = render('post-label.html', {
    ownerInfo: def.ownerInfo,
    labelInfo: def.labelInfo,
    siteInfo,
    postInfo,
  });
  return new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/' || path === '/index.html') {
      return handleHome(url, env);
    }
    let m = path.match(/^\/post\/detail\/(\d+)$/);
    if (m) return handlePostDetail(m[1], env);
    m = path.match(/^\/post\/label\/([^/]+)$/);
    if (m) return handleLabel(decodeURIComponent(m[1]), url, env);
    return new Response('Not found', { status: 404 });
  },
};
