/* 健康记录 — 无依赖单页应用
   数据：GitHub 私有仓库 data/health.json
   离线：本地缓存 + 待同步队列，联网自动补传
*/
(() => {
'use strict';

/* ============ 常量 ============ */
const K = {
  cfg: 'hr.cfg', data: 'hr.data', queue: 'hr.queue',
  meta: 'hr.meta', draft: 'hr.draft'
};
const DATA_PATH = 'data/health.json';
const SCHEMA = 1;

/* 健康基线（与电脑端 健康基线.md 保持一致，来源：WHO / 中国居民膳食指南2022 / 全国爱卫办） */
const BASE = {
  sleep:   { lo: 7, hi: 9,   unit: 'h',    label: '睡眠',     dec: 2 },
  kcal:    { lo: null, hi: null, unit: 'kcal', label: '活动消耗', dec: 0 },
  weight:  { lo: null, hi: null, unit: 'kg',   label: '体重',     dec: 1 },
  steps:   { lo: null, hi: null, unit: '步',   label: '步数',     dec: 0 },
  hr:      { lo: 50, hi: 100, unit: '次/分', label: '静息心率', dec: 0 },
  strength:{ lo: 2, hi: null, unit: '天/周', label: '力量训练', dec: 0, perWeek: true },
  veg:     { lo: null, hi: null, unit: '次',  label: '蔬菜',     dec: 0 }
};
const SUGARY = ['可乐','雪碧','奶茶','果汁','含糖','甜饮料','碳酸','啤酒'];
const TAGS = ['蔬菜','水果','蛋类','乳制品','全谷','禽肉','红肉','鱼虾','豆制品','油炸','外卖','夜宵'];

/* ============ 工具 ============ */
const $  = (s, r = document) => r.querySelector(s);
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const pad = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = v => { const f = parseFloat(v); return Number.isFinite(f) ? f : null; };
const fmt = (v, dec = 1) => v == null ? '—' : (dec === 0 ? Math.round(v) : Number(v.toFixed(dec))).toLocaleString('zh-CN');
const esc = s => String(s ?? '');

function toast(msg, ms = 1900) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => { t.hidden = true; }, ms);
}

function load(k, def) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }
  catch { return def; }
}
function save(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch (e) { toast('⚠️ 本地存储写入失败，可能是无痕模式'); return false; }
}

/* ============ 状态 ============ */
const cfg   = load(K.cfg, { owner: '', repo: '', branch: 'main', token: '' });
let   data  = load(K.data, { schema: SCHEMA, daily: [], meals: [], events: [], exercises: [] });
let   queue = load(K.queue, []);       // 待上传的完整数据快照（最新覆盖旧的）
let   meta  = load(K.meta, { sha: null, lastSync: 0, lastErr: '' });
let   online = navigator.onLine;

const configured = () => !!(cfg.owner && cfg.repo && cfg.token);
const recCount = () => data.daily.length + data.meals.length + data.events.length + data.exercises.length;

function goto(tab) { state.tab = tab; render(); window.scrollTo(0, 0); }
const openSettings = () => { goto('settings'); toast('先填 GitHub 配置'); };

function persist() { save(K.data, data); }
function enqueue() { queue = [{ at: Date.now() }]; save(K.queue, queue); }

/* ============ GitHub 同步 ============ */
const api = () => `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${DATA_PATH}`;
const headers = () => ({
  'Authorization': `Bearer ${cfg.token}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
});
const b64e = s => btoa(unescape(encodeURIComponent(s)));
const b64d = s => decodeURIComponent(escape(atob(String(s).replace(/\s/g, ''))));

/* 带超时的 fetch：网络被卡住时必须报错，不能永远停在"同步中" */
async function fetchT(url, opt = {}, ms = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opt, signal: ac.signal });
  } catch (e) {
    if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) {
      throw new Error(`请求超时（${ms / 1000} 秒无响应）— 网络到 GitHub 不通`);
    }
    throw new Error('连不上 GitHub（网络被阻断或断网）');
  } finally {
    clearTimeout(timer);
  }
}

function setStatus(kind, text) {
  const d = $('#statusDot');
  d.className = 'dot ' + (kind || '');
  if (text) $('#brandText').textContent = text;
  else $('#brandText').textContent = '健康记录';
}

async function pull() {
  if (!configured()) throw new Error('未配置 GitHub');
  const url = `${api()}?ref=${encodeURIComponent(cfg.branch)}&t=${Date.now()}`;
  const r = await fetchT(url, { headers: headers(), cache: 'no-store' });
  if (r.status === 404) return { fresh: true };
  if (!r.ok) throw new Error(`读取失败 HTTP ${r.status}${r.status === 401 ? '（令牌无效或已过期）' : r.status === 403 ? '（令牌权限不足或超限）' : ''}`);
  const j = await r.json();
  meta.sha = j.sha;
  save(K.meta, meta);
  const txt = b64d(j.content || '');
  if (!txt.trim()) return { fresh: true };
  return { remote: JSON.parse(txt) };
}

async function push(snapshot, msg) {
  if (!configured()) throw new Error('未配置 GitHub');
  const body = {
    message: msg,
    content: b64e(JSON.stringify(snapshot, null, 1)),
    branch: cfg.branch
  };
  if (meta.sha) body.sha = meta.sha;
  const r = await fetchT(api(), {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 20000);
  if (r.status === 409) throw new Error('__CONFLICT__');
  if (!r.ok) {
    let d = '';
    try { d = (await r.json()).message || ''; } catch {}
    const hint = r.status === 401 ? '（令牌无效或已过期）'
      : r.status === 403 ? '（令牌权限不足，检查 Contents 是否为 Read and write）'
      : r.status === 404 ? '（仓库名/用户名不对，或令牌没勾选这个仓库）'
      : r.status === 422 ? `（分支 ${cfg.branch} 不存在 —— 你的仓库可能是 master）`
      : '';
    throw new Error(`写入失败 HTTP ${r.status}${hint}${d ? '｜' + d : ''}`);
  }
  const j = await r.json();
  meta.sha = j.content && j.content.sha;
  meta.lastSync = Date.now(); meta.lastErr = '';
  save(K.meta, meta);
}

/* 合并：按 id 去重，远端与本地取并集；已删除的 id 用墓碑标记，防止被远端"复活" */
function mergeRecords(a, b) {
  const map = new Map();
  for (const list of [a, b]) for (const r of (list || [])) if (r && r.id) map.set(r.id, r);
  return [...map.values()];
}
function mergeData(local, remote) {
  if (!remote) return local;
  const tomb = new Set([...(local.deleted || []), ...(remote.deleted || [])]);
  const merged = {
    schema: SCHEMA,
    deleted: [...tomb],
    daily:     mergeRecords(local.daily, remote.daily),
    meals:     mergeRecords(local.meals, remote.meals),
    events:    mergeRecords(local.events, remote.events),
    exercises: mergeRecords(local.exercises, remote.exercises)
  };
  for (const k of ['daily', 'meals', 'events', 'exercises']) {
    merged[k] = merged[k].filter(r => !tomb.has(r.id));
  }
  return merged;
}
/* 标记删除：记录墓碑、从各表移除 */
function removeRecord(kind, id) {
  data[kind] = data[kind].filter(o => o.id !== id);
  data.deleted = [...new Set([...(data.deleted || []), id])];
}

let syncing = false;

/* 网络诊断：逐项测通，把结果打在设置页上（不含令牌，可以截图发人） */
let diagLog = [];
async function diagnose() {
  diagLog = [];
  const say = s => { diagLog.push(s); if (state.tab === 'settings') render(); };
  diagLog.push('— 网络诊断 ' + new Date().toLocaleTimeString('zh-CN') + ' —');

  // 1. 能不能上网
  say('1) 判断设备是否在线…');
  if (!navigator.onLine) { say('   ❌ 设备处于离线状态'); return; }
  say('   ✅ 设备报告在线');

  // 2. 能不能到 GitHub API
  say('2) 测试连接 api.github.com…');
  const t0 = Date.now();
  try {
    const r = await fetchT('https://api.github.com/rate_limit', { headers: { 'Accept': 'application/vnd.github+json' } }, 12000);
    say(`   ✅ 通了（HTTP ${r.status}，${Date.now() - t0} ms）`);
  } catch (e) {
    say('   ❌ ' + e.message);
    say('   → 这就是同步卡住的原因：网络到 GitHub 不通');
    say('   → 换 WiFi / 切蜂窝数据 / 检查代理或 VPN 后再试');
    return;
  }

  // 3. 令牌能不能用
  if (!configured()) { say('3) 跳过：还没填 GitHub 配置'); return; }
  say('3) 测试令牌是否有效…');
  try {
    const r = await fetchT('https://api.github.com/user', { headers: headers() }, 12000);
    if (r.status === 200) {
      const u = await r.json();
      say(`   ✅ 令牌有效，登录身份：${u.login}`);
    } else {
      say(`   ❌ HTTP ${r.status}${r.status === 401 ? ' — 令牌无效/已过期' : ''}`);
      return;
    }
  } catch (e) { say('   ❌ ' + e.message); return; }

  // 4. 仓库和分支能不能访问
  say(`4) 测试仓库 ${cfg.owner}/${cfg.repo}（分支 ${cfg.branch}）…`);
  try {
    const r = await fetchT(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}`, { headers: headers() }, 12000);
    if (r.status === 200) {
      const j = await r.json();
      say(`   ✅ 仓库可访问（可见性：${j.private ? '私有' : '公开'}，默认分支：${j.default_branch}）`);
      if (j.private !== true) say('   ⚠️ 这个仓库是公开的！健康数据不应该放公开仓库');
      if (j.default_branch !== cfg.branch) say(`   ⚠️ 分支填的是 ${cfg.branch}，但仓库默认分支是 ${j.default_branch} → 把设置里分支改成 ${j.default_branch}`);
    } else if (r.status === 404) {
      say('   ❌ HTTP 404 — 仓库名/用户名写错，或令牌没勾选这个仓库');
      return;
    } else {
      say(`   ❌ HTTP ${r.status}`);
      return;
    }
  } catch (e) { say('   ❌ ' + e.message); return; }

  // 5. 直接试读数据文件
  say('5) 尝试读取 data/health.json…');
  try {
    const { remote, fresh } = await pull();
    if (fresh) say('   文件还不存在（首次同步会创建它）');
    else say(`   已存在，含 ${(remote.daily || []).length + (remote.meals || []).length} 条记录`);
  } catch (e) { say('   ❌ ' + e.message); return; }

  say('诊断结束。以上全部 ✅ 的话，同步应该能成功。');
}

async function sync(manual) {
  if (syncing) return;
  if (!configured()) { if (manual) openSettings(); return; }
  if (!navigator.onLine) { setStatus('off', '离线'); if (manual) toast('离线中，已记录待同步'); return; }
  syncing = true; setStatus('', '同步中…');
  try {
    const { remote, fresh } = await pull();
    if (fresh && !remote) {
      // 远端还没有文件：直接把本地推上去
      await push(data, `初始化健康数据 (${recCount()} 条)`);
    } else {
      const merged = mergeData(data, remote);
      data = merged; persist();
      const changed = JSON.stringify(merged) !== JSON.stringify(remote);
      if (changed || queue.length) {
        try { await push(data, `同步健康数据 (${recCount()} 条)`); }
        catch (e) {
          if (String(e.message) === '__CONFLICT__') {
            const again = await pull();
            data = mergeData(data, again.remote); persist();
            await push(data, `同步健康数据 (合并后 ${recCount()} 条)`);
          } else throw e;
        }
      }
    }
    queue = []; save(K.queue, queue);
    setStatus('ok');
    if (manual) toast('✅ 同步完成');
  } catch (e) {
    meta.lastErr = e.message; save(K.meta, meta);
    setStatus('err', '同步失败');
    if (manual) toast('❌ ' + e.message, 3200);
  } finally {
    syncing = false;
    renderBanner();
    if (state.tab === 'settings') render();
  }
}

function renderBanner() {
  const b = $('#banner');
  if (!configured()) {
    b.hidden = false; b.className = 'banner';
    b.textContent = '还没配置存储。点「设置」填入你的 GitHub 仓库信息，数据才会保存到云端。现在记的东西只存在这台手机上。';
    return;
  }
  if (!online) { b.hidden = false; b.className = 'banner'; b.textContent = '当前离线。记录会先存在手机上，联网后自动上传。'; return; }
  if (meta.lastErr) { b.hidden = false; b.className = 'banner err'; b.textContent = '同步出错：' + meta.lastErr; return; }
  if (queue.length) { b.hidden = false; b.className = 'banner'; b.textContent = '有 ' + queue.length + ' 条待上传，稍后会自动同步。'; return; }
  b.hidden = true;
}

/* ============ 趋势计算 ============ */
const dOnly = s => String(s || '').slice(0, 10);
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return dOnly(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`); };

function inWindow(rows, from, to) {
  return rows.filter(r => { const d = dOnly(r.date); return d && d >= from && d <= to; });
}
function mean(list) {
  const v = list.filter(x => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function stat(field) {
  const d7 = inWindow(data.daily, daysAgo(6), todayStr());
  const d30 = inWindow(data.daily, daysAgo(29), todayStr());
  const v7 = d7.map(r => r[field]).filter(x => typeof x === 'number');
  const v30 = d30.map(r => r[field]).filter(x => typeof x === 'number');
  return { v7, v30, m7: mean(v7), m30: mean(v30), n7: v7.length, n30: v30.length };
}

/* 力量训练：按周计天数 */
function strengthPerWeek() {
  const rows = inWindow(data.exercises, daysAgo(6), todayStr()).filter(r => /力量|抗阻|器械|哑铃|深蹲|硬拉/.test(String(r.kind || '')));
  return new Set(rows.map(r => dOnly(r.date))).size;
}
function exerciseMinutes() {
  const rows = inWindow(data.exercises, daysAgo(6), todayStr());
  return rows.reduce((s, r) => s + (num(r.minutes) || 0), 0);
}
function mealStats() {
  const rows = inWindow(data.meals, daysAgo(6), todayStr());
  const days = new Set(rows.map(r => dOnly(r.date))).size || 1;
  const blob = rows.map(r => String(r.text || '')).join(' ');
  const hit = (arr) => arr.reduce((s, k) => s + (blob.split(k).length - 1), 0);
  return {
    rows: rows.length, days,
    veg: hit(['蔬菜','青菜','西兰花','菠菜','生菜','番茄','西红柿','黄瓜','胡萝卜','白菜','芹菜','蘑菇','菌菇','茄子','南瓜','沙拉']),
    fruit: hit(['水果','苹果','香蕉','橙','橘','葡萄','蓝莓','草莓','西瓜','桃','梨','猕猴桃']),
    protein: hit(['鸡蛋','蛋','牛奶','酸奶','豆浆','豆腐','鸡','牛','鱼','虾','肉']),
    whole: hit(['全麦','燕麦','糙米','杂粮','玉米','红薯','藜麦']),
    sugary: rows.filter(r => r.sugary === true).length + hit(['可乐','雪碧','奶茶','果汁','含糖','甜饮料','碳酸']),
    fried: hit(['炸','油条','薯条','烧烤','油煎']),
    late: rows.filter(r => String(r.time || '') >= '21:00' || String(r.meal || '') === '夜宵').length
  };
}
function streak() {
  let n = 0;
  for (let i = 0; i < 400; i++) {
    const d = daysAgo(i);
    if (data.daily.some(r => dOnly(r.date) === d)) n++;
    else if (i > 0) break;
  }
  return n;
}
function verdict(key, m7) {
  const b = BASE[key];
  if (m7 == null) return { cls: 'pill', txt: '无数据' };
  if (b.lo != null && b.hi != null) {
    if (m7 < b.lo) return { cls: 'pill warn', txt: '偏低' };
    if (m7 > b.hi) return { cls: 'pill warn', txt: '偏高' };
    return { cls: 'pill ok', txt: '达标' };
  }
  if (b.lo != null && b.perWeek) return m7 >= b.lo ? { cls: 'pill ok', txt: '达标' } : { cls: 'pill warn', txt: '不达标' };
  return { cls: 'pill', txt: '记录中' };
}

/* 迷你走势图 */
function sparkline(values, lo, hi) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark'); svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('viewBox', '0 0 300 44');
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x));
  if (v.length < 2) return null;
  const pad1 = 5, W = 300, H = 44;
  let mn = Math.min(...v), mx = Math.max(...v);
  if (lo != null) mn = Math.min(mn, lo);
  if (hi != null) mx = Math.max(mx, hi);
  if (mx - mn < 1e-6) { mx += 1; mn -= 1; }
  const x = i => (i / (v.length - 1)) * W;
  const y = val => H - pad1 - ((val - mn) / (mx - mn)) * (H - pad1 * 2);
  const mk = (t, a) => { const e = document.createElementNS('http://www.w3.org/2000/svg', t); for (const k in a) e.setAttribute(k, a[k]); return e; };
  if (lo != null && hi != null && hi > mn && lo < mx) {
    svg.appendChild(mk('rect', { x: 0, width: W, y: y(hi), height: Math.max(1, y(lo) - y(hi)), fill: 'currentColor', opacity: .13 }));
  }
  const d = v.map((val, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(' ');
  svg.appendChild(mk('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: .9 }));
  const last = v.length - 1;
  svg.appendChild(mk('circle', { cx: x(last), cy: y(v[last]), r: 3, fill: 'currentColor' }));
  return svg;
}

/* ============ 视图状态 ============ */
const state = { tab: 'today', logFilter: 'all' };

function render() {
  const view = $('#view');
  view.innerHTML = '';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.tab));
  ({ today: renderToday, trend: renderTrend, log: renderLog, settings: renderSettings }[state.tab] || renderToday)(view);
  renderBanner();
}

/* ---------- 记录页 ---------- */
function renderToday(v) {
  const t = todayStr();
  const td = data.daily.find(r => dOnly(r.date) === t) || {};
  const strip = el('div', 'today-strip');
  const cell = (val, label, unit) => {
    const c = el('div', 'ts');
    const b = el('b', null, val == null || val === '' ? '—' : String(val));
    if (unit && val != null && val !== '') b.textContent += unit;
    c.append(b, el('span', null, label));
    return c;
  };
  strip.append(
    cell(td.sleep_h != null ? Number(td.sleep_h).toFixed(1) : null, '睡眠', 'h'),
    cell(td.active_kcal, '消耗', ''),
    cell(td.weight_kg != null ? Number(td.weight_kg).toFixed(1) : null, '体重', 'kg')
  );
  v.appendChild(el('h2', 'sec', '今天 ' + t + (streak() > 0 ? ` · 已连续记录 ${streak()} 天` : '')));
  v.appendChild(strip);

  const g = el('div', 'grid2');
  const big = (cls, ico, title, sub, fn) => {
    const b = el('button', 'big ' + (cls || ''));
    b.type = 'button';
    b.append(el('span', 'ico', ico), el('b', null, title), el('small', null, sub));
    b.onclick = fn; return b;
  };
  g.append(
    big('primary', '◉', td.date ? '补全今日指标' : '记录今日指标', '睡眠·消耗·体重·步数', () => formDaily()),
    big('', '🍚', '记一餐', '吃了什么，随手记', () => formMeal()),
    big('', '💪', '记运动', '力量训练要单独记', () => formExercise()),
    big('', '➕', '记事件', '用药·就医·生病·情绪', () => formEvent())
  );
  v.appendChild(g);

  const recent = [
    ...data.meals.map(r => ({ ...r, _k: 'meal' })),
    ...data.exercises.map(r => ({ ...r, _k: 'ex' })),
    ...data.events.map(r => ({ ...r, _k: 'ev' }))
  ].filter(r => dOnly(r.date) === t).sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));

  v.appendChild(el('h2', 'sec', '今天的其他记录'));
  if (!recent.length) {
    const e = el('div', 'empty', '今天还没记别的。吃完了随手记一餐就行。');
    v.appendChild(e);
  } else {
    recent.forEach(r => v.appendChild(itemEl(r)));
  }
}

/* ---------- 趋势页 ---------- */
function renderTrend(v) {
  if (!data.daily.length && !data.meals.length) {
    v.appendChild(el('div', 'empty', '还没有数据。先去「记录」页记两天，趋势才有意义。'));
    return;
  }
  v.appendChild(el('h2', 'sec', '近 7 天'));

  const card = (key, st, extra) => {
    const b = BASE[key];
    const c = el('div', 'tcard');
    const head = el('div', 'head');
    const left = el('div');
    const val = el('span', 'val', fmt(st.m7, b.dec));
    left.append(val, el('span', 'unit', b.unit));
    const vd = verdict(key, st.m7);
    head.append(left, el('span', vd.cls, vd.txt));
    c.appendChild(head);

    if (st.m7 != null && st.m30 != null) {
      const diff = st.m7 - st.m30;
      const pct = st.m30 ? (diff / st.m30) * 100 : 0;
      const cmp = el('div', 'cmp');
      cmp.textContent = `对比 30 天均值 ${fmt(st.m30, b.dec)}${b.unit}　${diff >= 0 ? '↑' : '↓'}${fmt(Math.abs(diff), b.dec)}（${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%）`;
      if (key === 'sleep') cmp.classList.add(diff >= 0 ? 'good' : 'bad');
      if (key === 'weight' || key === 'hr') cmp.classList.add(diff <= 0 ? 'good' : 'bad');
      c.appendChild(cmp);
    }
    const series = st.v30.length >= 2 ? st.v30 : st.v7;
    const sp = sparkline(series, b.lo, b.hi);
    if (sp) c.appendChild(sp);
    else c.appendChild(el('div', 'spark-empty', `7 天记录 ${st.n7} 天，30 天 ${st.n30} 天 — 至少 2 天后出走势`));
    if (extra) c.appendChild(extra);
    return c;
  };

  v.appendChild(card('sleep', stat('sleep_h')));
  v.appendChild(card('kcal', stat('active_kcal')));
  v.appendChild(card('weight', stat('weight_kg')));
  v.appendChild(card('steps', stat('steps')));
  v.appendChild(card('hr', stat('resting_hr')));

  /* 力量训练（按周计天，不用均值） */
  const spw = strengthPerWeek();
  const sc = el('div', 'tcard');
  const sh = el('div', 'head');
  const sl = el('div');
  sl.append(el('span', 'val', String(spw)), el('span', 'unit', '天/周'));
  sh.append(sl, el('span', spw >= 2 ? 'pill ok' : 'pill warn', spw >= 2 ? '达标' : '不达标'));
  sc.appendChild(sh);
  sc.appendChild(el('div', 'cmp', `WHO 建议每周 ≥2 天力量训练　本期共 ${fmt(exerciseMinutes(), 0)} 分钟运动`));
  if (!data.exercises.length) {
    const n = el('div', 'spark-empty', '运动补记是空的 —— 手环只告诉消耗，看不出练了什么');
    sc.appendChild(n);
  }
  v.appendChild(sc);

  /* 饮食 */
  const ms = mealStats();
  v.appendChild(el('h2', 'sec', '近 7 天饮食'));
  const mc = el('div', 'tcard');
  if (!ms.rows) {
    mc.appendChild(el('div', 'cmp', '这 7 天没有饮食记录'));
  } else {
    mc.appendChild(el('div', 'cmp', `共 ${ms.rows} 餐，覆盖 ${ms.days} 天`));
    const ul = el('div', null);
    const line = (label, val, good) => {
      const kv = el('div', 'kv');
      kv.append(el('span', null, label), el('span', null, val));
      if (good === true) kv.lastChild.style.color = 'var(--acc)';
      if (good === false) kv.lastChild.style.color = 'var(--warn)';
      return kv;
    };
    ul.append(
      line('蔬菜', ms.veg + ' 次', ms.veg >= ms.days),
      line('水果', ms.fruit + ' 次', ms.fruit >= Math.max(1, Math.floor(ms.days / 2))),
      line('优质蛋白', ms.protein + ' 次', ms.protein >= ms.days),
      line('全谷粗粮', ms.whole + ' 次', ms.whole >= 1),
      line('含糖饮料', ms.sugary + ' 次', ms.sugary === 0),
      line('油炸烧烤', ms.fried + ' 次', ms.fried === 0),
      line('深夜进食', ms.late + ' 次', ms.late === 0)
    );
    mc.appendChild(ul);
    mc.appendChild(el('div', 'faint',
      '膳食指南建议每天 12 种以上食物、添加糖 <25g。'));
  }
  v.appendChild(mc);

  /* 记录连续性 */
  v.appendChild(el('h2', 'sec', '记录情况'));
  const dc = el('div', 'tcard');
  const total = el('div');
  const kv = (a, b) => { const n = el('div', 'kv'); n.append(el('span', null, a), el('span', null, b)); return n; };
  total.append(
    kv('连续记录', streak() + ' 天'),
    kv('累计指标', data.daily.length + ' 天'),
    kv('累计饮食', data.meals.length + ' 条'),
    kv('累计运动', data.exercises.length + ' 次'),
    kv('累计事件', data.events.length + ' 条')
  );
  dc.appendChild(total);
  v.appendChild(dc);
}

/* ---------- 明细页 ---------- */
function itemEl(r) {
  const it = el('div', 'item');
  const t = el('div', 't', r._k === 'meal' ? (r.time || '') : (r.time || ''));
  let main, kind = '';
  if (r._k === 'meal') { main = r.text; kind = r.meal || ''; }
  else if (r._k === 'ex') { main = r.kind + (r.minutes ? ` ${r.minutes} 分钟` : ''); kind = '运动'; }
  else { main = r.text; kind = r.type || ''; }
  const m = el('div', 'm', esc(main));
  const k = el('div', 'k', kind);
  const x = el('button', 'x', '✕');
  x.title = '删除';
  x.onclick = () => {
    if (!confirm('删除这条记录？')) return;
    const key = { meal: 'meals', ex: 'exercises', ev: 'events' }[r._k];
    removeRecord(key, r.id);
    persist(); enqueue(); render(); if (configured()) sync(false);
    toast('已删除');
  };
  it.append(t, m, k, x);
  return it;
}

function renderLog(v) {
  const filters = [['all', '全部'], ['daily', '指标'], ['meal', '饮食'], ['ex', '运动'], ['ev', '事件']];
  const bar = el('div', 'chips');
  bar.style.marginBottom = '14px';
  filters.forEach(([k, label]) => {
    const c = el('button', 'chip' + (state.logFilter === k ? ' on' : ''), label);
    c.type = 'button';
    c.onclick = () => { state.logFilter = k; render(); };
    bar.appendChild(c);
  });
  v.appendChild(bar);

  const rows = [];
  if (state.logFilter === 'all' || state.logFilter === 'daily')
    data.daily.forEach(r => rows.push({ ...r, _k: 'daily', date: dOnly(r.date) }));
  if (state.logFilter === 'all' || state.logFilter === 'meal')
    data.meals.forEach(r => rows.push({ ...r, _k: 'meal' }));
  if (state.logFilter === 'all' || state.logFilter === 'ex')
    data.exercises.forEach(r => rows.push({ ...r, _k: 'ex' }));
  if (state.logFilter === 'all' || state.logFilter === 'ev')
    data.events.forEach(r => rows.push({ ...r, _k: 'ev' }));

  if (!rows.length) { v.appendChild(el('div', 'empty', '没有记录。')); return; }
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.time || '').localeCompare(String(a.time || '')));

  const byDay = new Map();
  rows.forEach(r => { const d = dOnly(r.date); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r); });

  [...byDay.keys()].slice(0, 60).forEach(day => {
    const grp = el('div', 'daygroup');
    grp.appendChild(el('div', 'dayhead', day));
    byDay.get(day).forEach(r => {
      if (r._k === 'daily') {
        const it = el('div', 'item');
        const parts = [];
        if (r.sleep_h != null) parts.push('睡眠 ' + Number(r.sleep_h).toFixed(1) + 'h');
        if (r.active_kcal != null) parts.push('消耗 ' + r.active_kcal);
        if (r.weight_kg != null) parts.push('体重 ' + Number(r.weight_kg).toFixed(1) + 'kg');
        if (r.steps != null) parts.push('步数 ' + r.steps);
        if (r.resting_hr != null) parts.push('静息心率 ' + r.resting_hr);
        const m = el('div', 'm', parts.join('　') || '（空）');
        const k = el('div', 'k', '指标');
        const x = el('button', 'x', '✕');
        x.onclick = () => {
          if (!confirm('删除这天的指标？')) return;
          removeRecord('daily', r.id);
          persist(); enqueue(); render(); if (configured()) sync(false); toast('已删除');
        };
        it.append(el('div', 't', ''), m, k, x);
        grp.appendChild(it);
      } else grp.appendChild(itemEl(r));
    });
    v.appendChild(grp);
  });
}

/* ============ 抽屉表单 ============ */
function openSheet(title, build) {
  $('#sheetTitle').textContent = title;
  const f = $('#sheetForm');
  f.innerHTML = '';
  build(f);
  $('#sheetWrap').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  $('#sheetWrap').hidden = true;
  document.body.style.overflow = '';
}
$('#sheetClose').onclick = closeSheet;
$('#sheetMask').onclick = closeSheet;

function field(parent, label, opts = {}) {
  const wrap = el('div', 'f');
  const lb = el('label', null, label);
  if (opts.hint) lb.append(el('span', 'hint', '　' + opts.hint));
  wrap.appendChild(lb);
  let input;
  if (opts.type === 'textarea') input = el('textarea');
  else if (opts.type === 'select') {
    input = el('select');
    (opts.options || []).forEach(o => {
      const op = el('option', null, o.label ?? o);
      op.value = o.value ?? o; input.appendChild(op);
    });
  } else {
    input = el('input');
    input.type = opts.type || 'text';
    if (opts.step) input.step = opts.step;
    if (opts.inputmode) input.inputMode = opts.inputmode;
  }
  input.name = opts.name || '';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.value != null) input.value = opts.value;
  if (opts.required) input.required = true;
  wrap.appendChild(input);
  parent.appendChild(wrap);
  return input;
}
function actions(parent, onSave, onDelete) {
  const a = el('div', 'actions');
  const s = el('button', 'btn', '保存');
  s.type = 'submit';
  a.appendChild(s);
  if (onDelete) {
    const d = el('button', 'btn danger', '删除');
    d.type = 'button';
    d.onclick = () => { if (confirm('确定删除？')) { onDelete(); closeSheet(); render(); if (configured()) sync(false); } };
    a.appendChild(d);
  }
  const c = el('button', 'btn sec', '取消');
  c.type = 'button'; c.onclick = closeSheet;
  a.appendChild(c);
  parent.appendChild(a);
  return s;
}

/* --- 每日指标 --- */
function formDaily(existing) {
  const t = todayStr();
  const rec = existing || data.daily.find(r => dOnly(r.date) === t) || { date: t };
  openSheet(existing ? '编辑指标' : '今日指标', f => {
    field(f, '日期', { name: 'date', type: 'date', value: dOnly(rec.date) || t, required: true });
    const row1 = el('div', 'f2');
    f.appendChild(row1);
    field(row1, '睡眠小时', { name: 'sleep_h', type: 'number', step: '0.01', inputmode: 'decimal', placeholder: '7.33', value: rec.sleep_h ?? '' });
    field(row1, '活动消耗 kcal', { name: 'active_kcal', type: 'number', inputmode: 'numeric', placeholder: '620', value: rec.active_kcal ?? '' });
    const row2 = el('div', 'f2');
    f.appendChild(row2);
    field(row2, '体重 kg', { name: 'weight_kg', type: 'number', step: '0.1', inputmode: 'decimal', placeholder: '71.5', value: rec.weight_kg ?? '' });
    field(row2, '步数', { name: 'steps', type: 'number', inputmode: 'numeric', placeholder: '9200', value: rec.steps ?? '' });
    field(f, '静息心率', { name: 'resting_hr', type: 'number', inputmode: 'numeric', placeholder: '61', hint: '健康 App 首页', value: rec.resting_hr ?? '' });
    field(f, '备注', { name: 'note', type: 'textarea', placeholder: '熬夜、生病、饮酒…（可留空）', value: rec.note ?? '' });
    actions(f, null, existing ? () => {
      removeRecord('daily', existing.id);
      persist(); enqueue();
    } : null);
  });
  $('#sheetForm').onsubmit = e => {
    e.preventDefault();
    const g = n => $('[name="' + n + '"]', $('#sheetForm')).value.trim();
    const d = g('date') || t;
    const obj = {
      id: rec.id || uid(), date: d,
      sleep_h: num(g('sleep_h')), active_kcal: num(g('active_kcal')),
      weight_kg: num(g('weight_kg')), steps: num(g('steps')),
      resting_hr: num(g('resting_hr')), note: g('note'), src: 'app'
    };
    Object.keys(obj).forEach(k => { if (obj[k] === null) delete obj[k]; });
    if (!obj.note) delete obj.note;
    const others = data.daily.filter(o => !(dOnly(o.date) === d) && o.id !== rec.id);
    data.daily = [...others, obj];
    persist(); enqueue(); closeSheet(); render();
    toast('已记录');
    if (configured()) sync(false);
  };
}

/* --- 饮食 --- */
function formMeal() {
  openSheet('记一餐', f => {
    const row = el('div', 'f2');
    f.appendChild(row);
    field(row, '日期', { name: 'date', type: 'date', value: todayStr(), required: true });
    field(row, '时间', { name: 'time', type: 'time', value: nowTime() });
    const wrap = el('div', 'f');
    wrap.appendChild(el('label', null, '餐次'));
    const chips = el('div', 'chips');
    let meal = '午餐';
    const opts = ['早餐', '午餐', '晚餐', '加餐', '夜宵'];
    const h = new Date().getHours();
    meal = h < 10 ? '早餐' : h < 15 ? '午餐' : h < 21 ? '晚餐' : '夜宵';
    opts.forEach(o => {
      const c = el('button', 'chip' + (o === meal ? ' on' : ''), o);
      c.type = 'button';
      c.onclick = () => { meal = o; [...chips.children].forEach(x => x.classList.toggle('on', x === c)); };
      chips.appendChild(c);
    });
    wrap.appendChild(chips);
    f.appendChild(wrap);
    field(f, '吃了什么', { name: 'text', type: 'textarea', placeholder: '食堂：米饭、青菜、鸡腿', required: true, hint: '不用算热量，说人话就行' });
    const tw = el('div', 'f');
    tw.appendChild(el('label', null, '标签（可点选，也可不选）'));
    const tc = el('div', 'chips');
    const picked = new Set();
    TAGS.forEach(tg => {
      const c = el('button', 'chip', tg);
      c.type = 'button';
      c.onclick = () => { picked.has(tg) ? picked.delete(tg) : picked.add(tg); c.classList.toggle('on'); };
      tc.appendChild(c);
    });
    tw.appendChild(tc); f.appendChild(tw);
    actions(f, null, null);
    f._getMeal = () => meal;
    f._getTags = () => [...picked];
  });
  $('#sheetForm').onsubmit = e => {
    e.preventDefault();
    const form = $('#sheetForm');
    const g = n => { const x = $('[name="' + n + '"]', form); return x ? x.value.trim() : ''; };
    const text = g('text');
    if (!text) { toast('写点吃了什么'); return; }
    const blob = text + ' ' + form._getTags().join(' ');
    data.meals.push({
      id: uid(), date: g('date') || todayStr(), time: g('time') || nowTime(),
      meal: form._getMeal(), text,
      tags: form._getTags(),
      sugary: SUGARY.some(s => blob.includes(s)),
      src: 'app'
    });
    persist(); enqueue(); closeSheet(); render();
    toast('已记录');
    if (configured()) sync(false);
  };
}

/* --- 运动 --- */
function formExercise() {
  openSheet('记运动', f => {
    const row = el('div', 'f2');
    f.appendChild(row);
    field(row, '日期', { name: 'date', type: 'date', value: todayStr(), required: true });
    field(row, '时长 分钟', { name: 'minutes', type: 'number', inputmode: 'numeric', placeholder: '40' });
    const wrap = el('div', 'f');
    wrap.appendChild(el('label', null, '运动类型'));
    const chips = el('div', 'chips');
    const opts = ['力量训练', '走路', '跑步', '骑车', '游泳', '球类', '瑜伽', '其他'];
    let kind = '力量训练';
    opts.forEach(o => {
      const c = el('button', 'chip' + (o === kind ? ' on' : ''), o);
      c.type = 'button';
      c.onclick = () => { kind = o; [...chips.children].forEach(x => x.classList.toggle('on', x === c)); };
      chips.appendChild(c);
    });
    wrap.appendChild(chips); f.appendChild(wrap);
    field(f, '备注', { name: 'note', type: 'textarea', placeholder: '练了哪些动作、强度…（可留空）' });
    actions(f, null, null);
    f._getKind = () => kind;
  });
  $('#sheetForm').onsubmit = e => {
    e.preventDefault();
    const form = $('#sheetForm');
    const g = n => { const x = $('[name="' + n + '"]', form); return x ? x.value.trim() : ''; };
    data.exercises.push({
      id: uid(), date: g('date') || todayStr(), time: nowTime(),
      kind: form._getKind(), minutes: num(g('minutes')), note: g('note'), src: 'app'
    });
    persist(); enqueue(); closeSheet(); render();
    toast('已记录');
    if (configured()) sync(false);
  };
}

/* --- 事件 --- */
function formEvent() {
  openSheet('记事件', f => {
    const row = el('div', 'f2');
    f.appendChild(row);
    field(row, '日期', { name: 'date', type: 'date', value: todayStr(), required: true });
    field(row, '时间', { name: 'time', type: 'time', value: nowTime() });
    const wrap = el('div', 'f');
    wrap.appendChild(el('label', null, '类型'));
    const chips = el('div', 'chips');
    const opts = ['用药', '就医', '生病', '情绪', '饮酒', '受伤', '体检', '其他'];
    let type = '用药';
    opts.forEach(o => {
      const c = el('button', 'chip' + (o === type ? ' on' : ''), o);
      c.type = 'button';
      c.onclick = () => { type = o; [...chips.children].forEach(x => x.classList.toggle('on', x === c)); };
      chips.appendChild(c);
    });
    wrap.appendChild(chips); f.appendChild(wrap);
    field(f, '内容', { name: 'text', type: 'textarea', placeholder: '维生素D 1粒 / 感冒低烧 / 加班到11点', required: true });
    actions(f, null, null);
    f._getType = () => type;
  });
  $('#sheetForm').onsubmit = e => {
    e.preventDefault();
    const form = $('#sheetForm');
    const g = n => { const x = $('[name="' + n + '"]', form); return x ? x.value.trim() : ''; };
    const text = g('text');
    if (!text) { toast('写点内容'); return; }
    data.events.push({
      id: uid(), date: g('date') || todayStr(), time: g('time') || nowTime(),
      type: form._getType(), text, src: 'app'
    });
    persist(); enqueue(); closeSheet(); render();
    toast('已记录');
    if (configured()) sync(false);
  };
}

/* ---------- 设置页 ---------- */
function renderSettings(v) {
  // 演示模式提示
  const inside = location.search.includes('demo=1');
  if (inside) {
    const d = el('div', 'warnbox');
    d.innerHTML = '🎬 <strong>演示模式</strong>：当前是生成的假数据，用来预览趋势图。<br>' +
      '退出并清空 → <a href="' + location.pathname + '" style="color:var(--info)">点这里</a>';
    v.appendChild(d);
    const b0 = el('div', 'actions');
    const gen = el('button', 'btn sec', '重新生成演示数据');
    gen.onclick = () => { seedDemo(); toast('已重新生成 30 天演示数据'); };
    const kill = el('button', 'btn danger', '清空并退出演示');
    kill.onclick = () => { localStorage.clear(); location.href = location.pathname; };
    b0.append(gen, kill);
    v.appendChild(b0);
  }

  const card = el('div', 'card');
  card.appendChild(el('h2', 'sec', '数据存储（GitHub）'));
  const note = el('div', 'warnbox');
  note.innerHTML = '数据保存在<strong>你自己的 GitHub 私有仓库</strong>里，别人看不到。令牌只存在这台手机上。<br><br>' +
    '⚠️ 换手机或清理浏览器数据后，需要重新填一次令牌。';
  v.appendChild(note);

  const mk = (label, key, ph, type) => {
    const w = el('div', 'set');
    w.appendChild(el('label', null, label));
    const i = el('input');
    i.type = type || 'text'; i.placeholder = ph; i.value = cfg[key] || '';
    i.autocapitalize = 'off'; i.autocomplete = 'off'; i.spellcheck = false;
    i.oninput = () => { cfg[key] = i.value.trim(); };
    w.appendChild(i); card.appendChild(w);
    return i;
  };
  mk('GitHub 用户名', 'owner', '例如 zhangsan');
  mk('仓库名', 'repo', '例如 my-health');
  mk('分支', 'branch', 'main');
  mk('访问令牌 (Token)', 'token', 'github_pat_…', 'password');

  const btnRow = el('div', 'actions');
  const saveBtn = el('button', 'btn', '保存并同步');
  saveBtn.onclick = async () => {
    save(K.cfg, cfg);
    if (!configured()) { toast('三项都要填'); return; }
    toast('正在测试连接…');
    await sync(true);
    render();
  };
  btnRow.appendChild(saveBtn);
  v.appendChild(card);
  card.appendChild(btnRow);

  /* 状态 */
  const st = el('div', 'card');
  st.appendChild(el('h2', 'sec', '状态'));
  const kv = (a, b) => { const n = el('div', 'kv'); n.append(el('span', null, a), el('span', null, b)); return n; };
  st.append(
    kv('已配置', configured() ? '是' : '否'),
    kv('网络', navigator.onLine ? '在线' : '离线'),
    kv('待上传', queue.length ? queue.length + ' 条' : '无'),
    kv('上次同步', meta.lastSync ? new Date(meta.lastSync).toLocaleString('zh-CN') : '从未'),
    kv('累计记录', recCount() + ' 条'),
    kv('同步错误', meta.lastErr || '无')
  );
  const b2 = el('div', 'actions');
  const nowBtn = el('button', 'btn sec', '立即同步');
  nowBtn.onclick = () => sync(true);
  const diagBtn = el('button', 'btn sec', '网络诊断');
  diagBtn.onclick = diagnose;
  b2.append(nowBtn, diagBtn);
  st.appendChild(b2);
  if (diagLog.length) {
    const pre = el('div', 'faint');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.marginTop = '10px';
    pre.textContent = diagLog.join('\n');
    st.appendChild(pre);
  }
  v.appendChild(st);

  /* 数据管理 */
  const mg = el('div', 'card');
  mg.appendChild(el('h2', 'sec', '数据'));
  const b3 = el('div', 'actions');
  const exp = el('button', 'btn sec', '导出 JSON');
  exp.onclick = () => {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = el('a'); a.href = URL.createObjectURL(blob);
    a.download = `health-${todayStr()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const imp = el('button', 'btn sec', '导入 JSON');
  imp.onclick = () => {
    const i = el('input'); i.type = 'file'; i.accept = '.json,application/json';
    i.onchange = async () => {
      const f = i.files && i.files[0]; if (!f) return;
      try {
        const obj = JSON.parse(await f.text());
        data = mergeData(data, obj); persist(); enqueue(); render();
        toast('已导入并合并'); if (configured()) sync(false);
      } catch { toast('文件格式不对'); }
    };
    i.click();
  };
  b3.append(exp, imp);
  mg.appendChild(b3);
  const b4 = el('div', 'actions');
  const clrBuf = el('button', 'btn danger', '清空本机数据');
  clrBuf.onclick = () => {
    if (!confirm('只清空这台手机上的缓存，云端数据不动。确定？')) return;
    [K.data, K.queue, K.meta, K.draft].forEach(k => localStorage.removeItem(k));
    location.reload();
  };
  b4.appendChild(clrBuf);
  mg.appendChild(b4);
  mg.appendChild(el('div', 'faint', '清空后重新同步即可从云端取回数据（需先填好上面的令牌）。'));
  v.appendChild(mg);

  const ab = el('div', 'card');
  ab.appendChild(el('h2', 'sec', '说明'));
  ab.appendChild(el('div', 'faint',
    '本工具用于个人生活管理，不是医疗工具：不做诊断、不调整用药。指标持续异常请就医。' +
    '基线来源：WHO 身体活动指南、《中国居民膳食指南（2022）》、全国爱卫办睡眠健康核心信息。'));
  v.appendChild(ab);
}

/* ============ 演示模式 ============
   用途：还没配置 GitHub 时，先看看填满数据后的趋势页长什么样。
   触发：网址后加 ?demo=1
   数据全部是生成的假数据，退出时清空。
*/
function seedDemo() {
  const daily = [], meals = [], exercises = [], events = [];
  const BREAK = ['两个水煮蛋、一杯牛奶、一片全麦面包', '燕麦粥一碗、一个鸡蛋、半个苹果', '包子两个、豆浆一杯'];
  const LUNCH = ['米饭、青菜、鸡腿', '沙拉、鸡胸肉、全麦面包', '盖饭、可乐一罐、薯条', '米饭、西兰花、清蒸鱼'];
  const DINNER = ['米饭、炒青菜、豆腐', '杂粮饭、番茄炒蛋、菠菜', '外卖炸鸡、薯条', '小米粥、青菜、鸡蛋'];
  for (let i = 29; i >= 0; i--) {
    const k = 29 - i, d = daysAgo(i);
    const sleep = [6.2, 7.4, 5.8, 8.1, 6.9, 7.2, 5.5, 7.8, 6.4, 8.3][k % 10];
    daily.push({
      id: 'demo-d' + i, date: d, sleep_h: sleep,
      active_kcal: 320 + (k % 7) * 55 + (k % 5 === 0 ? 180 : 0),
      weight_kg: Number((72.6 - k * 0.08 + (k % 4 === 0 ? 0.4 : -0.15)).toFixed(1)),
      steps: 5200 + (k % 7) * 850 + (k % 3 === 0 ? 2400 : 0),
      resting_hr: 59 + (k % 5), note: sleep < 6 ? '熬夜' : '', src: 'demo'
    });
    const bad = k % 3 === 0;
    meals.push({ id: 'demo-m' + i + 'a', date: d, time: '08:10', meal: '早餐', text: BREAK[k % 3], tags: [], sugary: false });
    meals.push({ id: 'demo-m' + i + 'b', date: d, time: '12:30', meal: '午餐', text: LUNCH[k % 4], tags: [], sugary: k % 4 === 2 });
    if (k % 4 === 0) {
      meals.push({ id: 'demo-m' + i + 'c', date: d, time: '19:00', meal: '晚餐', text: DINNER[2], tags: [], sugary: false });
      meals.push({ id: 'demo-m' + i + 'd', date: d, time: '22:20', meal: '夜宵', text: '泡面、可乐', tags: [], sugary: true });
    } else {
      meals.push({ id: 'demo-m' + i + 'c', date: d, time: '19:00', meal: '晚餐', text: DINNER[k % 4], tags: [], sugary: false });
    }
    if (k % 3 === 0) exercises.push({ id: 'demo-x' + i, date: d, time: '19:30', kind: '力量训练', minutes: 40, note: '', src: 'demo' });
    else if (k % 2 === 0) exercises.push({ id: 'demo-x' + i, date: d, time: '07:00', kind: '跑步', minutes: 30, note: '', src: 'demo' });
    if (k % 8 === 0) events.push({ id: 'demo-e' + i, date: d, time: '08:00', type: '用药', text: '维生素D 1粒', src: 'demo' });
    if (k === 12) events.push({ id: 'demo-e-sick', date: d, time: '09:00', type: '生病', text: '感冒，低烧一天', src: 'demo' });
  }
  data = { schema: SCHEMA, deleted: [], daily, meals, events, exercises };
  persist();
}

/* ============ 事件绑定 ============ */
$('#tabbar').addEventListener('click', e => {
  const b = e.target.closest('.tab'); if (!b) return;
  state.tab = b.dataset.tab; render(); window.scrollTo(0, 0);
});
$('#syncBtn').onclick = () => sync(true);
window.addEventListener('online',  () => { online = true;  renderBanner(); if (configured()) sync(false); });
window.addEventListener('offline', () => { online = false; renderBanner(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && configured()) sync(false); });

/* ============ 启动 ============ */
if (location.search.includes('demo=1')) {
  // 演示模式：只在没有真实数据时生成，避免覆盖用户已填的东西
  if (recCount() === 0) seedDemo();
  state.tab = 'trend';
}
setStatus(configured() ? (online ? 'ok' : 'off') : 'off');
render();
if (configured()) sync(false);

})();
