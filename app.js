import { SUBJECTS, REASONS, dueItems, reviewed, validateBackup } from './core.js';
import { openDatabase, readSnapshot, saveRecords, disconnectSync } from './storage.js';
import { DeviceSync } from './sync-client.js';
import { APP_MODE, APP_VERSION } from './app-config.js';
import { OfflineApp } from './pwa.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = name => `<i data-lucide="${name}"></i>`;
const icons = () => window.lucide?.createIcons();
const date = time => new Date(time).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
let db, items = [], page = 'notebook', subject = '全部', status = 'all', query = '', sort = 'newest';
let editingId = null, photos = [], answerPhotos = [], photoKind = 'question', imageIndex = 0, workingImage = null, originalImage = null;
let detailId = null, reviewQueue = [], reviewIndex = 0, reviewAnswer = false, reviewActive = false;
let busy = false, pendingInstall = null, toastTimer;
const selectedIds = new Set();
let exportRecords = [], exportRevision = 0, documentUrl = null, documentFile = null;
let deviceSync, syncState, pairingCode = null, pairedDevices = [], syncInfoLoaded = false;
let offlineApp;
const active = () => items.filter(x => !x.deletedAt);
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3500); }
function openDB() {
  return openDatabase();
}
async function readItems() {
  const snapshot = await readSnapshot(db); syncState = snapshot.state; return snapshot.items;
}
async function putItems(records) {
  await saveRecords(db, records);
  items = await readItems();
  setTimeout(() => deviceSync?.run(), 250);
}
function storageError(error) { return error?.name === 'QuotaExceededError' ? '存储空间不足，请先导出备份并清理设备空间。' : '保存失败，请检查浏览器存储权限后重试。'; }
function navigation() {
  const links = [['notebook', 'book-open', '错题本'], ['review', 'calendar-check-2', '复习'], ['starred', 'bookmark', '重点题'], ['settings', 'settings-2', '设置']];
  $('#desktop-nav').innerHTML = links.map(([key, glyph, label]) => `<a class="nav-item ${page === key ? 'active' : ''}" href="#${key}" ${page === key ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span>${key === 'review' ? `<span class="nav-count">${dueItems(active()).length || ''}</span>` : ''}</a>`).join('');
  $('#mobile-nav').innerHTML = links.map(([key, glyph, label], index) => `${index === 2 ? `<button class="nav-item capture-nav" data-action="new">${icon('camera')}<span>收集</span></button>` : ''}<a class="nav-item ${page === key ? 'active' : ''}" href="#${key}" ${page === key ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span></a>`).join('');
  $('#page-name').textContent = { notebook: '错题本', review: '复习', starred: '重点题', settings: '数据与设置', trash: '回收站' }[page];
}
function heading(title, subtitle, action = true) {
  return `<div class="page-heading"><div><div class="eyebrow">拾题 / STUDY NOTEBOOK</div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div>${action ? `<button class="primary" data-action="new">${icon('plus')}收集错题</button>` : ''}</div>`;
}
function stats() {
  const all = active();
  return `<section class="stats" aria-label="学习统计">${[['book-open', '累计收集', all.length, '题'], ['clock-3', '待复习', dueItems(all).length, '题'], ['circle-check', '已掌握', all.filter(x => x.mastered).length, '题'], ['layers', '已收集学科', new Set(all.map(x => x.subject)).size, '科']].map(([glyph, label, value, unit]) => `<div class="stat"><div class="stat-label">${icon(glyph)}${label}</div><strong>${value}</strong><small>${unit}</small></div>`).join('')}</section>`;
}
function empty(title, description, button = '') {
  return `<div class="empty"><div class="empty-art"><img src="assets/icon-192.png" alt="拾题笔记本"></div><h3>${title}</h3><p>${description}</p>${button}</div>`;
}
function card(item) {
  const selectable = page === 'notebook' || page === 'starred';
  return `<article class="question-card ${selectable && selectedIds.has(item.id) ? 'is-selected' : ''}">${selectable ? `<label class="card-selection" title="选择题目"><input type="checkbox" data-select-id="${esc(item.id)}" aria-label="选择题目：${esc(item.title)}" ${selectedIds.has(item.id) ? 'checked' : ''}></label>` : ''}<button class="card-open" data-action="detail" data-id="${esc(item.id)}" aria-label="查看：${esc(item.title)}"><div class="card-image ${item.photos.length ? '' : 'text-preview'}">${item.photos.length ? `<img src="${item.photos[0]}" alt="${esc(item.title)}的题目照片" loading="lazy">` : esc(item.question.slice(0, 180))}</div><div class="card-body"><div class="card-meta"><span class="badge ${item.subject === '英语' ? 'blue' : item.subject === '语文' ? 'warm' : ''}">${esc(item.subject)}</span><span class="badge ${item.mastered ? '' : 'gray'}">${item.mastered ? '已掌握' : '待巩固'}</span></div><div class="card-title">${esc(item.title)}</div><div class="card-tags">${esc(item.tags || item.reason || '未添加知识点')}</div></div><div class="card-footer"><span>${icon('calendar-days')}${date(item.createdAt)}</span><span>${item.photos.length ? `${item.photos.length} 张照片` : '文字题目'}</span></div></button><button class="icon-button star-button ${item.starred ? 'selected' : ''}" data-action="star" data-id="${esc(item.id)}" aria-label="${item.starred ? '取消重点' : '标为重点'}：${esc(item.title)}" title="${item.starred ? '取消重点' : '标为重点'}">${icon('bookmark')}</button></article>`;
}
function filteredItems() {
  let list = active().filter(x => page !== 'starred' || x.starred);
  if (subject !== '全部') list = list.filter(x => x.subject === subject);
  if (status === 'pending') list = list.filter(x => !x.mastered);
  if (status === 'mastered') list = list.filter(x => x.mastered);
  if (status === 'due') list = dueItems(list);
  const needle = query.trim().toLowerCase();
  if (needle) list = list.filter(x => [x.title, x.question, x.answer, x.correctAnswer, x.tags, x.reason, x.subject].join(' ').toLowerCase().includes(needle));
  return list.sort((a, b) => sort === 'oldest' ? a.createdAt - b.createdAt : sort === 'review' ? a.nextReview - b.nextReview : b.createdAt - a.createdAt);
}
function renderCards() {
  const list = filteredItems();
  $('#result-count').textContent = `${list.length} 道题目`;
  $('#questions').innerHTML = list.length ? list.map(card).join('') : query || subject !== '全部' || status !== 'all' ? empty('没有找到匹配的错题', '试试其他关键词或学科', '<button class="secondary" data-action="clear-filters">清除筛选</button>') : page === 'starred' ? empty('还没有重点题', '重点题 · 0 道') : empty('第一道错题，从这里开始', '今天的错题，也可以是明天的得分题。', `<button class="primary" data-action="new">${icon('camera')}收集第一道题</button>`);
  syncSelection(); icons();
}
function syncSelection() {
  const allIds = new Set(active().map(x => x.id));
  for (const id of selectedIds) if (!allIds.has(id)) selectedIds.delete(id);
  if (!$('#select-visible')) return;
  const visible = filteredItems(), visibleCount = visible.filter(x => selectedIds.has(x.id)).length;
  $('#select-visible').checked = visible.length > 0 && visibleCount === visible.length;
  $('#select-visible').indeterminate = visibleCount > 0 && visibleCount < visible.length;
  $('#select-visible').disabled = visible.length === 0;
  const hidden = selectedIds.size - visibleCount;
  $('#selection-count').textContent = `已选 ${selectedIds.size} 题${hidden ? `（筛选外 ${hidden} 题）` : ''}`;
  $('#export-selected').disabled = selectedIds.size === 0;
  $('#clear-selection').disabled = selectedIds.size === 0;
  document.querySelectorAll('[data-select-id]').forEach(input => { input.checked = selectedIds.has(input.dataset.selectId); input.closest('.question-card').classList.toggle('is-selected', input.checked); });
}
function notebook() {
  const all = active().filter(x => page !== 'starred' || x.starred);
  const subjects = ['全部', ...SUBJECTS.filter(x => ['数学', '语文', '英语'].includes(x) || all.some(y => y.subject === x))];
  $('#main').innerHTML = heading(page === 'starred' ? '我的重点题' : '我的错题本', page === 'starred' ? '再多想一遍，再记牢一点。' : '把每一次出错，变成下一次进步。') + (page === 'notebook' ? stats() : '') + (page === 'notebook' ? `<div class="review-strip"><div class="strip-icon">${icon('sun')}</div><div><strong>今日复习</strong><p>${dueItems(active()).length ? `还有 ${dueItems(active()).length} 道错题，等你再挑战一次` : '暂时没有待复习的题目'}</p></div><a class="text-button" href="#review">${dueItems(active()).length ? '去复习' : '复习计划'}${icon('arrow-right')}</a></div>` : '') + `<div class="section-heading"><h2>${page === 'starred' ? '重点收藏' : '全部错题'}</h2><span id="result-count"></span></div><div class="subject-tabs" role="group" aria-label="按学科筛选">${subjects.map(s => `<button class="subject-tab ${subject === s ? 'active' : ''}" data-action="subject" data-value="${s}" aria-pressed="${subject === s}">${s}<span class="tab-count">${s === '全部' ? all.length : all.filter(x => x.subject === s).length}</span></button>`).join('')}</div><div class="filterbar"><div class="search-wrap">${icon('search')}<input id="search" aria-label="搜索错题" placeholder="搜索题目、知识点或错因" value="${esc(query)}"></div><div class="spacer"></div><select id="status-filter" aria-label="掌握状态"><option value="all">全部状态</option><option value="pending">待巩固</option><option value="due">待复习</option><option value="mastered">已掌握</option></select><select id="sort-filter" aria-label="排序方式"><option value="newest">最近收集</option><option value="oldest">最早收集</option><option value="review">复习时间</option></select></div><div id="questions" class="questions"></div><p class="bottom-note">每一道错题，都值得被认真对待。</p>`;
  $('#questions').insertAdjacentHTML('beforebegin', `<div class="selection-bar" aria-label="题目选择与导出"><label class="check-label"><input type="checkbox" id="select-visible">全选当前结果</label><span id="selection-count" aria-live="polite"></span><button id="clear-selection" class="icon-button" data-action="clear-selection" aria-label="清空选择" title="清空选择">${icon('list-x')}</button><button id="export-selected" class="secondary" data-action="export-selected" disabled>${icon('file-down')}导出 Word</button><button id="export-by-date" class="secondary" data-action="export-by-date">${icon('calendar-days')}按日期导出</button></div>`);
  $('#status-filter').value = status; $('#sort-filter').value = sort;
  $('#search').addEventListener('input', event => { query = event.target.value; renderCards(); });
  $('#status-filter').addEventListener('change', event => { status = event.target.value; renderCards(); });
  $('#sort-filter').addEventListener('change', event => { sort = event.target.value; renderCards(); });
  renderCards();
}
function reviewPage() {
  if (!reviewActive) {
    const due = dueItems(active());
    const upcoming = active().filter(x => !x.mastered && x.nextReview > Date.now()).sort((a, b) => a.nextReview - b.nextReview);
    $('#main').innerHTML = heading('温故，再进一步', '把做错的题，变成真正会做的题。', false) + stats() + `<div class="section-heading"><h2>今日待复习</h2><span>${due.length} 道</span></div>` + (due.length ? `<div class="review-strip"><div class="strip-icon">${icon('calendar-check-2')}</div><div><strong>${due.length} 道错题已就绪</strong><p>${[...new Set(due.map(x => x.subject))].join(' · ')}</p></div><button class="primary" data-action="start-review">开始复习${icon('arrow-right')}</button></div><div class="questions">${due.map(card).join('')}</div>` : empty('今天的复习已完成', upcoming.length ? `下次复习：${date(upcoming[0].nextReview)} · ${upcoming.length} 道待巩固` : '收集新错题后，会出现在复习计划中。', `<a href="#notebook" class="secondary">返回错题本${icon('arrow-right')}</a>`));
    return;
  }
  const item = items.find(x => x.id === reviewQueue[reviewIndex]);
  if (reviewIndex >= reviewQueue.length || !item) {
    $('#main').innerHTML = heading('本轮复习完成', '每一次回顾，都让知识更牢固。', false) + `<div class="review-finish">${icon('circle-check')}<h2>完成 ${reviewIndex} 道题目的复习</h2><p>新的复习时间已保存。</p><button class="primary" data-action="finish-review">返回复习计划${icon('arrow-right')}</button></div>`;
    return;
  }
  $('#main').innerHTML = `<div class="review-stage"><div class="page-heading"><h1>专注复习</h1><button class="secondary" data-action="finish-review">结束本轮</button></div><div class="review-progress"><span>${reviewIndex + 1} / ${reviewQueue.length}</span><div class="progress-track"><div class="progress-fill" style="width:${reviewIndex / reviewQueue.length * 100}%"></div></div><span>${esc(item.subject)}</span></div><div class="review-paper"><span class="badge">${esc(item.tags || item.subject)}</span><h2 class="detail-title">${esc(item.title)}</h2>${questionContent(item)}${reviewAnswer ? answerContent(item) : `<div class="review-hidden"><button class="secondary" data-action="reveal">${icon('eye')}查看答案与解析</button></div>`}</div>${reviewAnswer ? `<div class="review-controls"><button class="secondary" data-action="rate" data-value="again">${icon('rotate-ccw')}还不熟悉</button><button class="secondary" data-action="rate" data-value="remember">${icon('check')}基本会了</button><button class="primary" data-action="rate" data-value="mastered">${icon('check-check')}已经掌握</button></div>` : ''}</div>`;
}
function settings() {
  $('#main').innerHTML = heading('数据与设置', '属于你的错题，留在你的设备里。', false) + `<div class="settings-section"><div class="settings-row"><div class="settings-icon">${icon('hard-drive')}</div><div><h3>本机错题</h3><p>${active().length} 道题目 · ${active().reduce((n, x) => n + x.photos.length, 0)} 张照片 · <span id="storage-usage">本地存储</span></p></div><span class="badge">本机保存</span></div><div class="settings-row"><div class="settings-icon">${icon('download')}</div><div><h3>导出备份</h3><p>题目、照片、解析及复习记录</p></div><button class="secondary" data-action="export">${icon('download')}导出</button></div><div class="settings-row"><div class="settings-icon">${icon('upload')}</div><div><h3>导入备份</h3><p>合并题目，同一题保留更新时间较新的版本</p></div><button class="secondary" data-action="import">${icon('upload')}导入</button></div><div class="settings-row"><div class="settings-icon">${icon('trash-2')}</div><div><h3>回收站</h3><p>${items.filter(x => x.deletedAt).length} 道题目，可随时恢复</p></div><a href="#trash" class="secondary">查看${icon('chevron-right')}</a></div><div class="settings-row"><div class="settings-icon">${icon('smartphone')}</div><div><h3>桌面应用</h3><p id="install-state">${matchMedia('(display-mode: standalone)').matches ? '已在独立窗口运行' : pendingInstall ? '可添加到主屏幕' : window.isSecureContext ? '可通过浏览器菜单添加到主屏幕' : '当前为局域网预览，桌面安装与离线使用需要 HTTPS'}</p></div>${pendingInstall ? '<button class="secondary" data-action="install">安装</button>' : ''}</div></div><p class="settings-copy">数据仅保存在当前设备的当前浏览器，不会自动同步。清除网站数据、卸载浏览器或更换访问地址后，原有题目可能无法访问。请定期导出备份；备份文件包含题目原图和回收站内容。</p><p class="settings-copy">拾题 1.0 · 离线错题本</p>`;
  $('#main .settings-section').insertAdjacentHTML('beforebegin', offlineSettings());
  if (APP_MODE === 'lan') {
    $('#main .settings-section').insertAdjacentHTML('beforebegin', syncSettings());
    $('#main .page-heading .subtitle').textContent = '本机保存，也能在手机和电脑间同步。';
    $('#main .settings-copy').textContent = '未配对时，题目仅保存在当前浏览器。开启配对后，题目、照片、解析及回收站记录会同步到这台电脑和已配对设备。断开时修改保留在本机，连接恢复后再同步。请定期导出备份。';
    if (!syncInfoLoaded) { syncInfoLoaded = true; refreshSyncSettings(); }
  } else {
    $('#main .settings-copy').textContent = '题目与照片保存在当前设备，不会上传到网站。升级程序会保留错题；清除网站数据、更换网址或卸载主屏幕应用可能影响数据访问，请定期导出备份。跨设备可通过备份文件迁移。';
  }
  $('#main .settings-copy:last-child').textContent = `拾题 ${APP_VERSION} · ${APP_MODE === 'lan' ? '局域网同步版' : 'iPhone 离线版'}`;
  navigator.storage?.estimate?.().then(data => { if ($('#storage-usage')) $('#storage-usage').textContent = `约 ${((data.usage || 0) / 1048576).toFixed(1)} MB`; }).catch(() => {});
}
function offlineSettings() {
  const state = offlineApp?.state;
  return `<section class="offline-section" aria-label="离线与更新"><div class="section-heading"><h2>离线与更新</h2><span class="badge">${APP_VERSION}</span></div><p id="offline-status" class="sync-status" role="status">${esc(state?.message || '正在准备离线资源…')}</p><div class="sync-actions"><button class="secondary" data-action="check-update" ${state?.checking ? 'disabled' : ''}>${icon('refresh-cw')}${state?.checking ? '正在检查' : '检查更新'}</button><button class="primary" data-action="apply-update" ${state?.waiting ? '' : 'hidden'}>${icon('download')}安装新版本</button></div></section>`;
}
function syncSettings() {
  const connected = !!syncState?.config, local = deviceSync?.info?.canManage;
  return `<section class="sync-section" aria-label="手机与电脑同步"><div class="section-heading"><h2>手机与电脑同步</h2><span class="badge ${connected ? '' : 'gray'}">${connected ? '已配对' : '未配对'}</span></div><p id="sync-status" class="sync-status" role="status">${esc(deviceSync?.status || '尚未配对')}</p><p class="sync-note">同一 Wi-Fi · 电脑服务保持运行 · 两端页面打开时自动同步</p><div class="sync-actions">${local ? `<button class="primary" data-action="sync-pairing">${icon('link')}${connected ? '配对新设备' : '开启电脑同步'}</button>` : ''}${connected ? `<button class="secondary" data-action="sync-now">${icon('refresh-cw')}立即同步</button><button class="text-button" data-action="sync-disconnect">停止本机同步</button>` : ''}</div>${pairingCode && pairingCode.expiresAt > Date.now() ? `<div class="pairing-code"><span>一次性配对码</span><strong>${esc(pairingCode.code)}</strong><small>有效至 ${new Date(pairingCode.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small></div>` : ''}${!connected ? `<form id="pair-device-form" class="pair-device-form"><label>配对码<input name="code" inputmode="numeric" autocomplete="off" pattern="[0-9]{8}" maxlength="8" minlength="8" required placeholder="电脑端显示的 8 位配对码"></label><label>设备名称<input name="device-name" maxlength="40" value="${/iPhone|iPad/.test(navigator.userAgent) ? '我的 iPhone' : '我的浏览器'}" required></label><button class="secondary" type="submit">${icon('link')}连接电脑</button></form>` : ''}${local && connected ? `<div class="paired-devices"><div class="section-heading"><h3>已配对设备</h3><button class="icon-button" data-action="sync-refresh" aria-label="刷新设备列表" title="刷新设备列表">${icon('refresh-cw')}</button></div>${pairedDevices.map(x => `<div class="paired-device"><span>${esc(x.name)}${x.id === syncState.config.deviceId ? '（本机）' : ''}</span>${x.id !== syncState.config.deviceId ? `<button class="text-button" data-action="sync-revoke" data-id="${esc(x.id)}">取消配对</button>` : ''}</div>`).join('')}</div>` : ''}<p class="sync-note">配对后，两端现有题目会合并。同步冲突会保留副本。局域网 HTTP 未加密，请仅在可信 Wi-Fi 中使用。</p><p id="sync-action-error" class="form-error" role="alert"></p></section>`;
}
async function refreshSyncSettings() {
  await deviceSync.inspect();
  items = await readItems();
  pairedDevices = [];
  if (deviceSync.info?.canManage && syncState.config) {
    try { pairedDevices = (await deviceSync.devices()).devices; } catch { /* Status explains an expired pairing on the next sync. */ }
  }
  if (page === 'settings' && !$('#pair-device-form')?.contains(document.activeElement)) { settings(); icons(); }
}
async function syncAction(action, id) {
  if (!deviceSync || busy) return;
  if (action === 'sync-now') return deviceSync.run();
  if (action === 'sync-refresh') return refreshSyncSettings();
  busy = true;
  try {
    if (action === 'sync-pairing') pairingCode = await deviceSync.pairing();
    if (action === 'sync-disconnect') { await disconnectSync(db); pairingCode = null; deviceSync.setStatus('已停止本机同步，本机题目保留'); }
    if (action === 'sync-revoke') await deviceSync.revoke(id);
    items = await readItems();
    await refreshSyncSettings();
  } catch (error) { if ($('#sync-action-error')) $('#sync-action-error').textContent = error.message || '无法连接电脑，请重试'; }
  finally { busy = false; }
  deviceSync.run();
}
function trashPage() {
  const deleted = items.filter(x => x.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  $('#main').innerHTML = heading('回收站', `${deleted.length} 道题目 · 恢复后保留原有笔记与复习记录`, false) + `<a href="#settings" class="text-button">${icon('arrow-left')}返回设置</a>` + (deleted.length ? deleted.map(x => `<div class="trash-row"><div><h3>${esc(x.title)}</h3><p>${esc(x.subject)} · ${date(x.deletedAt)} 移入回收站</p></div><button class="secondary" data-action="restore" data-id="${esc(x.id)}">${icon('undo-2')}恢复</button></div>`).join('') : empty('回收站是空的', '没有已删除的题目'));
}
function render() { navigation(); if (page === 'notebook' || page === 'starred') notebook(); else if (page === 'review') reviewPage(); else if (page === 'trash') trashPage(); else settings(); icons(); }
function route() {
  const key = location.hash.slice(1);
  if (key === 'capture') { location.hash = 'notebook'; openEditor(); return; }
  page = ['notebook', 'review', 'starred', 'settings', 'trash'].includes(key) ? key : 'notebook';
  subject = '全部'; status = 'all'; query = ''; reviewActive = false;
  if (page === 'settings') syncInfoLoaded = false;
  if (db) render(); window.scrollTo(0, 0);
}
function openEditor(id = null) {
  editingId = id;
  const item = items.find(x => x.id === id);
  $('#entry-form').reset();
  $('#subject').value = item?.subject || (SUBJECTS.includes(subject) ? subject : '数学');
  for (const field of ['title', 'question', 'answer', 'correctAnswer', 'reason', 'tags']) $(`[name="${field}"]`).value = item?.[field] || '';
  photos = [...(item?.photos || [])];
  answerPhotos = [...(item?.correctAnswerPhotos || [])];
  $('#editor-title').textContent = item ? '编辑错题' : '收集错题';
  $('#editor-error').textContent = '';
  renderPhotos(); renderAnswerPhotos(); $('#editor').showModal();
}
function renderPhotos() {
  $('#photo-count').textContent = `${photos.length} / 8 张`;
  $('#photo-list').innerHTML = photos.map((src, index) => `<div class="photo-item"><button type="button" data-action="edit-image" data-index="${index}" aria-label="调整第 ${index + 1} 张照片"><img src="${src}" alt="第 ${index + 1} 张题目照片"><span class="edit-badge">${icon('crop')}</span></button><button type="button" class="icon-button" data-action="remove-photo" data-index="${index}" title="移除照片" aria-label="移除第 ${index + 1} 张照片">${icon('x')}</button></div>`).join(''); icons();
}
function renderAnswerPhotos() {
  $('#answer-photo-count').textContent = `${answerPhotos.length} / 8 张`;
  $('#answer-photo-list').innerHTML = answerPhotos.map((src, index) => `<div class="photo-item"><button type="button" data-action="edit-answer-image" data-index="${index}" aria-label="调整第 ${index + 1} 张答案照片"><img src="${src}" alt="第 ${index + 1} 张答案照片"><span class="edit-badge">${icon('crop')}</span></button><button type="button" class="icon-button" data-action="remove-answer-photo" data-index="${index}" title="移除照片" aria-label="移除第 ${index + 1} 张答案照片">${icon('x')}</button></div>`).join(''); icons();
}
function loadImage(src) { return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('无法读取图片，请转换为 JPG 或 PNG 后重试。')); img.src = src; }); }
async function compress(file) {
  if (file.size > 30 * 1024 * 1024) throw new Error('单张图片不能超过 30 MB。');
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件。');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const ratio = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .9);
  } finally { URL.revokeObjectURL(url); }
}
async function receivePhotos(event, kind = 'question') {
  const files = [...event.target.files]; event.target.value = '';
  if (!files.length || busy) return;
  const target = kind === 'answer' ? answerPhotos : photos;
  if (files.length + target.length > 8) { $('#editor-error').textContent = '每道题每类照片最多保存 8 张。'; return; }
  busy = true; $('#save-entry').disabled = true; $('#editor-error').textContent = '正在处理照片…';
  try { const added = []; for (const file of files) added.push(await compress(file)); target.push(...added); kind === 'answer' ? renderAnswerPhotos() : renderPhotos(); $('#editor-error').textContent = ''; }
  catch (error) { $('#editor-error').textContent = error.message; }
  finally { busy = false; $('#save-entry').disabled = false; }
}
async function saveEntry(event) {
  event.preventDefault(); if (busy) return;
  const form = new FormData(event.target);
  const question = form.get('question').trim();
  if (!photos.length && !question) { $('#editor-error').textContent = '请添加题目照片，或输入题目文字。'; return; }
  busy = true; $('#save-entry').disabled = true;
  const now = Date.now(), old = items.find(x => x.id === editingId);
  const item = { ...(old || { id: crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random().toString(36).slice(2)}`, createdAt: now, starred: false, mastered: false, level: 0, reviewCount: 0, reviewedAt: null, deletedAt: null, nextReview: now }), updatedAt: now, title: form.get('title').trim() || `${form.get('subject')}错题 · ${date(now)}`, subject: form.get('subject'), reason: form.get('reason'), question, answer: form.get('answer').trim(), correctAnswer: form.get('correctAnswer').trim(), tags: form.get('tags').trim(), photos: [...photos], correctAnswerPhotos: [...answerPhotos] };
  try { await putItems([item]); $('#editor').close(); render(); if ($('#detail').open) showDetail(item.id); toast('错题已保存'); navigator.storage?.persist?.().catch(() => {}); }
  catch (error) { $('#editor-error').textContent = storageError(error); }
  finally { busy = false; $('#save-entry').disabled = false; }
}
function questionContent(item) {
  return item.photos.map((src, index) => `<button class="detail-photo" data-action="full-image" data-id="${esc(item.id)}" data-index="${index}" aria-label="放大第 ${index + 1} 张题目照片"><img src="${src}" alt="第 ${index + 1} 张题目照片"></button>`).join('') + (item.question ? `<p class="text-block">${esc(item.question)}</p>` : '');
}
function answerContent(item) {
  const answerPhotosMarkup = (item.correctAnswerPhotos || []).map((src, index) => `<button class="detail-photo" data-action="full-answer-image" data-id="${esc(item.id)}" data-index="${index}" aria-label="放大第 ${index + 1} 张答案照片"><img src="${src}" alt="第 ${index + 1} 张答案照片"></button>`).join('');
  return `<section class="answer-block"><h3>正确答案</h3>${answerPhotosMarkup}${item.correctAnswer ? `<p class="text-block">${esc(item.correctAnswer)}</p>` : ''}<h3>答案与解析</h3><p class="text-block">${esc(item.answer || '暂未记录解析')}</p>${item.reason ? `<span class="badge warm">错因 · ${esc(item.reason)}</span>` : ''}</section>`;
}
function showDetail(id) {
  const item = items.find(x => x.id === id); if (!item) return;
  detailId = id;
  $('#detail').innerHTML = `<div class="dialog-head"><h2>错题详情</h2><button class="icon-button" data-action="close-detail" aria-label="关闭详情" title="关闭">${icon('x')}</button></div><div class="dialog-body"><div class="detail-meta"><span class="badge">${esc(item.subject)}</span><span class="badge ${item.mastered ? '' : 'warm'}">${item.mastered ? '已掌握' : '待巩固'}</span><span class="badge gray">${date(item.createdAt)} 收集</span></div><h2 class="detail-title">${esc(item.title)}</h2>${item.tags ? `<p class="subtitle">${esc(item.tags)}</p>` : ''}<div class="detail-meta"><span class="subtitle">复习 ${item.reviewCount} 次${item.mastered ? '' : ` · ${item.nextReview <= Date.now() ? '今日待复习' : `${date(item.nextReview)} 复习`}`}</span></div>${questionContent(item)}${answerContent(item)}</div><div class="dialog-footer"><div><button class="icon-button" data-action="delete" data-id="${esc(id)}" aria-label="移入回收站" title="移入回收站">${icon('trash-2')}</button><button class="icon-button ${item.starred ? 'selected' : ''}" data-action="star" data-id="${esc(id)}" aria-label="${item.starred ? '取消重点' : '标为重点'}" title="${item.starred ? '取消重点' : '标为重点'}">${icon('bookmark')}</button></div><div><button class="secondary" data-action="edit" data-id="${esc(id)}">${icon('pencil')}编辑</button><button class="primary" data-action="master" data-id="${esc(id)}">${icon(item.mastered ? 'rotate-ccw' : 'check')}${item.mastered ? '重新复习' : '标为掌握'}</button></div></div>`;
  icons(); if (!$('#detail').open) $('#detail').showModal();
}
function resetCrop() { for (const edge of ['top', 'left']) $(`#crop-${edge}`).value = 0; for (const edge of ['bottom', 'right']) $(`#crop-${edge}`).value = 100; }
function bounds() { return Object.fromEntries(['top', 'bottom', 'left', 'right'].map(edge => [edge, Number($(`#crop-${edge}`).value) / 100])); }
function drawCrop() {
  if (!workingImage) return;
  const canvas = $('#crop-canvas'); canvas.width = workingImage.naturalWidth; canvas.height = workingImage.naturalHeight;
  const ctx = canvas.getContext('2d'), b = bounds(), w = canvas.width, h = canvas.height;
  ctx.drawImage(workingImage, 0, 0); ctx.fillStyle = '#10231e88'; ctx.fillRect(0, 0, w, h);
  const x = b.left * w, y = b.top * h, width = (b.right - b.left) * w, height = (b.bottom - b.top) * h;
  ctx.drawImage(workingImage, x, y, width, height, x, y, width, height); ctx.strokeStyle = '#5fc99a'; ctx.lineWidth = Math.max(2, w / 300); ctx.strokeRect(x, y, width, height);
}
async function editImage(index, kind = 'question') { photoKind = kind; imageIndex = index; const list = kind === 'answer' ? answerPhotos : photos; originalImage = list[index]; workingImage = await loadImage(originalImage); resetCrop(); drawCrop(); $('#image-editor').showModal(); }
async function rotateImage() {
  const canvas = document.createElement('canvas'); canvas.width = workingImage.naturalHeight; canvas.height = workingImage.naturalWidth;
  const ctx = canvas.getContext('2d'); ctx.translate(canvas.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(workingImage, 0, 0);
  workingImage = await loadImage(canvas.toDataURL('image/jpeg', .95)); resetCrop(); drawCrop();
}
function applyCrop() {
  const b = bounds(), w = workingImage.naturalWidth, h = workingImage.naturalHeight;
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round((b.right - b.left) * w)); canvas.height = Math.max(1, Math.round((b.bottom - b.top) * h));
  canvas.getContext('2d').drawImage(workingImage, b.left * w, b.top * h, (b.right - b.left) * w, (b.bottom - b.top) * h, 0, 0, canvas.width, canvas.height);
  const list = photoKind === 'answer' ? answerPhotos : photos;
  list[imageIndex] = canvas.toDataURL('image/jpeg', .93); photoKind === 'answer' ? renderAnswerPhotos() : renderPhotos(); $('#image-editor').close();
}
function exportBackup() {
  const file = new Blob([JSON.stringify({ app: 'shiti', version: 1, exportedAt: Date.now(), items })], { type: 'application/json' });
  const url = URL.createObjectURL(file), anchor = document.createElement('a'); anchor.href = url; anchor.download = `拾题备份-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); toast('已生成备份文件');
}
function invalidateDocument() {
  exportRevision++;
  if (documentUrl) URL.revokeObjectURL(documentUrl);
  documentUrl = null; documentFile = null;
  $('#document-result').hidden = true;
  $('#document-download').removeAttribute('href');
  $('#document-status').textContent = '';
}
async function openDocumentExport() {
  if (!selectedIds.size) return toast('请先选择需要导出的题目');
  const { selectedQuestions } = await import('./document-export.js');
  exportRecords = selectedQuestions(items, selectedIds, sort);
  if (!exportRecords.length) return toast('所选题目已不在错题本中');
  invalidateDocument();
  $('#document-count').textContent = `${exportRecords.length} 道题目 · ${exportRecords.reduce((sum, x) => sum + x.photos.length, 0)} 张照片`;
  $('#document-form').reset();
  $('#collection-date-range').hidden = true;
  $('#document-options').disabled = false; $('#generate-document').disabled = false;
  $('#document-export').showModal();
}
async function openDateDocumentExport() {
  invalidateDocument();
  $('#document-form').reset();
  $('#document-form input[value="date"]').checked = true;
  $('#collection-date-range').hidden = false;
  await refreshExportScope();
  $('#document-options').disabled = false; $('#generate-document').disabled = exportRecords.length === 0;
  $('#document-export').showModal();
}
async function refreshExportScope() {
  const scope = document.querySelector('input[name="export-scope"]:checked')?.value || 'selected';
  if (scope === 'selected') {
    const { selectedQuestions } = await import('./document-export.js');
    exportRecords = selectedQuestions(items, selectedIds, sort);
  } else {
    const from = $('#collection-date-from').value;
    const to = $('#collection-date-to').value;
    const fromTime = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
    const toTime = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
    exportRecords = fromTime > toTime ? [] : active().filter(item => item.createdAt >= fromTime && item.createdAt <= toTime).sort((a, b) => sort === 'oldest' ? a.createdAt - b.createdAt : sort === 'review' ? a.nextReview - b.nextReview : b.createdAt - a.createdAt);
  }
  $('#collection-date-range').hidden = scope !== 'date';
  $('#document-count').textContent = `${exportRecords.length} 道题目 · ${exportRecords.reduce((sum, x) => sum + x.photos.length, 0)} 张照片`;
  $('#generate-document').disabled = exportRecords.length === 0;
  if (!exportRecords.length) $('#document-status').textContent = scope === 'date' ? (from && to && fromTime > toTime ? '开始日期不能晚于结束日期' : '该日期范围内没有错题') : '请先在错题本中选择题目';
  else $('#document-status').textContent = '';
}
async function generateDocument(event) {
  event.preventDefault();
  invalidateDocument();
  const revision = exportRevision;
  const options = { title: $('#document-title').value.trim() || '我的错题', includeAnswers: $('#include-answers').checked, pagePerQuestion: $('#page-per-question').checked };
  $('#document-options').disabled = true; $('#generate-document').disabled = true;
  $('#document-status').textContent = '正在生成文档…';
  try {
    const { buildQuestionDocument, documentFilename } = await import('./document-export.js');
    const blob = await buildQuestionDocument(exportRecords, options);
    if (revision !== exportRevision || !$('#document-export').open) return;
    const filename = documentFilename(options.title);
    documentUrl = URL.createObjectURL(blob);
    documentFile = new File([blob], filename, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    $('#document-download').href = documentUrl; $('#document-download').download = filename;
    $('#document-share').hidden = !(navigator.canShare && navigator.canShare({ files: [documentFile] }));
    $('#document-result').hidden = false;
    $('#document-status').textContent = `文档已生成 · ${(blob.size / 1024).toFixed(0)} KB`;
  } catch (error) {
    if (revision === exportRevision) $('#document-status').textContent = `生成失败：${error.message || '请重试'}`;
  } finally {
    if (revision === exportRevision) { $('#document-options').disabled = false; $('#generate-document').disabled = false; }
  }
}
async function importBackup(event) {
  const file = event.target.files[0]; event.target.value = ''; if (!file || busy) return;
  if (file.size > 200 * 1024 * 1024) return toast('备份文件不能超过 200 MB');
  busy = true;
  try {
    const imported = validateBackup(JSON.parse(await file.text()));
    const changed = imported.filter(x => { const old = items.find(y => y.id === x.id); return !old || x.updatedAt > old.updatedAt; });
    await putItems(changed); render(); toast(`导入完成，新增或更新 ${changed.length} 道题目`);
  } catch (error) { toast(error.name === 'SyntaxError' ? '文件不是有效的 JSON 备份' : error.name === 'QuotaExceededError' ? storageError(error) : error.message || '导入失败'); }
  finally { busy = false; }
}
async function action(event) {
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action, id = button.dataset.id, value = button.dataset.value, index = Number(button.dataset.index);
  if (busy) return;
  if (action === 'check-update') return offlineApp?.checkUpdate();
  if (action === 'apply-update') return offlineApp?.activateUpdate();
  if (action.startsWith('sync-')) return syncAction(action, id);
  if (action === 'clear-selection') { selectedIds.clear(); return syncSelection(); }
  if (action === 'export-selected') return openDocumentExport();
  if (action === 'export-by-date') return openDateDocumentExport();
  if (action === 'close-document') return $('#document-export').close();
  if (action === 'share-document') {
    if (documentFile && navigator.share) {
      try { await navigator.share({ files: [documentFile] }); }
      catch (error) { if (error.name !== 'AbortError') $('#document-status').textContent = '分享未成功，可以下载文档后再分享'; }
    }
    return;
  }
  if (action === 'new') return openEditor();
  if (action === 'camera' || action === 'album') return $(`#${action}-input`).click();
  if (action === 'answer-camera' || action === 'answer-album') return $(`#${action}-input`).click();
  if (action === 'close-editor') return $('#editor').close();
  if (action === 'close-detail') return $('#detail').close();
  if (action === 'close-image') return $('#image-editor').close();
  if (action === 'close-lightbox') return $('#lightbox').close();
  if (action === 'subject') { subject = value; return render(); }
  if (action === 'clear-filters') { query = ''; subject = '全部'; status = 'all'; return render(); }
  if (action === 'detail') return showDetail(id);
  if (action === 'edit') return openEditor(id);
  if (action === 'remove-photo') { photos.splice(index, 1); return renderPhotos(); }
  if (action === 'remove-answer-photo') { answerPhotos.splice(index, 1); return renderAnswerPhotos(); }
  if (action === 'edit-image') return editImage(index);
  if (action === 'edit-answer-image') return editImage(index, 'answer');
  if (action === 'rotate') return rotateImage();
  if (action === 'reset-crop') { workingImage = await loadImage(originalImage); resetCrop(); return drawCrop(); }
  if (action === 'apply-crop') return applyCrop();
  if (action === 'full-image') { $('#full-image').src = items.find(x => x.id === id).photos[index]; return $('#lightbox').showModal(); }
  if (action === 'full-answer-image') { $('#full-image').src = (items.find(x => x.id === id).correctAnswerPhotos || [])[index]; return $('#lightbox').showModal(); }
  if (action === 'export') return exportBackup();
  if (action === 'import') return $('#import-input').click();
  if (action === 'install') { if (pendingInstall) { await pendingInstall.prompt(); pendingInstall = null; render(); } return; }
  if (action === 'start-review') { reviewQueue = dueItems(active()).map(x => x.id); reviewIndex = 0; reviewAnswer = false; reviewActive = true; render(); window.scrollTo(0, 0); return; }
  if (action === 'finish-review') { reviewActive = false; return render(); }
  if (action === 'reveal') { reviewAnswer = true; render(); return; }
  const item = items.find(x => x.id === (action === 'rate' ? reviewQueue[reviewIndex] : id)); if (!item) return;
  let changed = { ...item, updatedAt: Date.now() };
  if (action === 'star') changed.starred = !item.starred;
  else if (action === 'master') changed = item.mastered ? { ...changed, mastered: false, level: 0, nextReview: Date.now() } : reviewed(item, 'mastered');
  else if (action === 'delete') changed.deletedAt = Date.now();
  else if (action === 'restore') changed.deletedAt = null;
  else if (action === 'rate') changed = reviewed(item, value);
  else return;
  busy = true; button.disabled = true;
  try {
    await putItems([changed]);
    if (action === 'delete') { $('#detail').close(); toast('已移入回收站，可在设置中恢复'); }
    if (action === 'restore') toast('错题已恢复');
    if (action === 'rate') { reviewIndex++; reviewAnswer = false; window.scrollTo(0, 0); }
    render(); if ($('#detail').open) showDetail(detailId);
  } catch (error) { toast(storageError(error)); }
  finally { busy = false; button.disabled = false; }
}

$('#subject').innerHTML = SUBJECTS.map(x => `<option>${x}</option>`).join('');
$('#reason').insertAdjacentHTML('beforeend', REASONS.map(x => `<option>${x}</option>`).join(''));
$('#today').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
$('#camera-input').addEventListener('change', event => receivePhotos(event, 'question')); $('#album-input').addEventListener('change', event => receivePhotos(event, 'question'));
$('#answer-camera-input').addEventListener('change', event => receivePhotos(event, 'answer')); $('#answer-album-input').addEventListener('change', event => receivePhotos(event, 'answer'));
$('#import-input').addEventListener('change', importBackup); $('#entry-form').addEventListener('submit', saveEntry);
document.addEventListener('click', event => { action(event).catch(error => toast(error.message || '操作失败，请重试')); });
document.addEventListener('submit', async event => {
  if (event.target.id !== 'pair-device-form') return;
  event.preventDefault(); if (busy) return;
  busy = true;
  const button = event.target.querySelector('button'); button.disabled = true;
  try {
    const data = new FormData(event.target);
    await deviceSync.join(data.get('code').trim(), data.get('device-name').trim());
    items = await readItems(); await refreshSyncSettings();
    settings(); icons(); toast('配对成功');
  } catch (error) { if ($('#sync-action-error')) $('#sync-action-error').textContent = error.message || '配对失败，请检查电脑连接'; }
  finally { busy = false; button.disabled = false; }
  deviceSync.run();
});
document.addEventListener('change', event => {
  const input = event.target;
  if (input.matches('[data-select-id]')) {
    if (input.checked) selectedIds.add(input.dataset.selectId); else selectedIds.delete(input.dataset.selectId);
    syncSelection();
  } else if (input.id === 'select-visible') {
    for (const item of filteredItems()) { if (input.checked) selectedIds.add(item.id); else selectedIds.delete(item.id); }
    syncSelection();
  }
});
$('#document-form').addEventListener('submit', generateDocument);
$('#document-options').addEventListener('input', invalidateDocument);
document.querySelectorAll('input[name="export-scope"]').forEach(input => input.addEventListener('change', () => { invalidateDocument(); refreshExportScope(); }));
$('#collection-date-from').addEventListener('input', () => { invalidateDocument(); refreshExportScope(); }); $('#collection-date-to').addEventListener('input', () => { invalidateDocument(); refreshExportScope(); });
$('#document-export').addEventListener('close', invalidateDocument);
for (const edge of ['top', 'bottom', 'left', 'right']) $(`#crop-${edge}`).addEventListener('input', () => {
  const opposing = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[edge];
  const input = $(`#crop-${edge}`), other = Number($(`#crop-${opposing}`).value);
  input.value = ['top', 'left'].includes(edge) ? Math.min(Number(input.value), other - 5) : Math.max(Number(input.value), other + 5); drawCrop();
});
$('#editor').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
window.addEventListener('hashchange', route);
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); pendingInstall = event; if (page === 'settings' && db) render(); });
window.addEventListener('appinstalled', () => { pendingInstall = null; if (page === 'settings' && db) render(); });
const network = () => { $('#network-label').textContent = navigator.onLine ? '· 已连接' : '· 离线'; };
window.addEventListener('online', network); window.addEventListener('offline', network); network();
window.addEventListener('beforeunload', event => { if ($('#editor').open && (photos.length || answerPhotos.length || $('#question').value || $('#correct-answer').value || $('#entry-title').value)) event.preventDefault(); });
window.addEventListener('storage-blocked', () => { $('#main').innerHTML = heading('正在更新本机存储', '请关闭其他已打开的拾题页面，更新会自动继续。', false); });
try {
  db = await openDB(); items = await readItems();
  if (APP_MODE === 'lan') deviceSync = new DeviceSync(db, {
    canApply: () => !busy && !document.querySelector('dialog[open]') && !reviewActive && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName),
    onChange: async changed => {
      const signature = list => JSON.stringify(list.map(x => [x.id, x.updatedAt, x.deletedAt, x.starred, x.reviewCount]));
      const before = signature(items); items = await readItems();
      if (changed || before !== signature(items)) render();
    },
    onStatus: message => { if ($('#sync-status')) $('#sync-status').textContent = message; },
  });
  offlineApp = new OfflineApp(state => {
    if ($('#offline-status')) $('#offline-status').textContent = state.message;
    const updateButton = document.querySelector('[data-action="apply-update"]');
    if (updateButton) updateButton.hidden = !state.waiting;
    const checkButton = document.querySelector('[data-action="check-update"]');
    if (checkButton) checkButton.disabled = state.checking;
  });
  route(); deviceSync?.start(); offlineApp.start();
}
catch (error) { $('#main').innerHTML = heading('无法打开本机存储', '请允许浏览器保存网站数据，并退出无痕模式后重试。', false); console.error(error); }
icons();
