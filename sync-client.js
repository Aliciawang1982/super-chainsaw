import { applyExchange, connectSync, createExchange, disconnectSync, readSnapshot } from './storage.js';

export class DeviceSync {
  constructor(db, { canApply, onChange, onStatus }) {
    this.db = db; this.canApply = canApply; this.onChange = onChange; this.onStatus = onStatus;
    this.running = false; this.status = '尚未配对'; this.info = null;
  }
  async request(path, { token, data } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(`/api/sync/${path}`, { method: data ? 'POST' : 'GET', cache: 'no-store', headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: data ? JSON.stringify(data) : undefined, signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || '同步失败'), { status: response.status });
      return result;
    } finally { clearTimeout(timer); }
  }
  async inspect() {
    try { this.info = await this.request('status'); } catch { this.info = null; }
    return this.info;
  }
  async pairing() {
    const { state } = await readSnapshot(this.db);
    const result = await this.request('pairing', { token: state.config?.token, data: {} });
    await connectSync(this.db, { token: result.token, deviceId: result.deviceId, serverId: result.serverId });
    return result;
  }
  async join(code, name) {
    const result = await this.request('pair', { data: { code, name } });
    await connectSync(this.db, result); return result;
  }
  async devices() {
    const { state } = await readSnapshot(this.db);
    return this.request('devices', { token: state.config?.token });
  }
  async revoke(deviceId) {
    const { state } = await readSnapshot(this.db);
    await this.request('revoke', { token: state.config?.token, data: { deviceId } });
    if (deviceId === state.config?.deviceId) await disconnectSync(this.db);
  }
  setStatus(text) { this.status = text; this.onStatus(text); }
  async run() {
    if (this.running || !this.canApply()) return;
    this.running = true;
    try {
      const snapshot = await readSnapshot(this.db);
      if (!snapshot.state.config) { this.setStatus('尚未配对'); return; }
      this.setStatus('正在同步…');
      const sent = createExchange(snapshot), token = snapshot.state.config.token;
      const result = await this.request('exchange', { token, data: sent });
      if (!this.canApply()) { this.setStatus('编辑完成后继续同步'); return; }
      const applied = await applyExchange(this.db, sent, result, token);
      if (!applied) return;
      await this.onChange(result.records.length > 0);
      const remaining = (await readSnapshot(this.db)).state.pending.size;
      this.setStatus(result.conflicts.length ? `已同步，保留 ${result.conflicts.length} 份冲突副本` : remaining ? `还有 ${remaining} 道题待同步` : `已同步 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
      if (remaining) setTimeout(() => this.run(), 500);
    } catch (error) {
      this.setStatus(error.status ? error.message : '暂时无法连接电脑，修改已保存在本机');
    } finally { this.running = false; }
  }
  start() {
    this.timer = setInterval(() => { if (!document.hidden) this.run(); }, 10000);
    window.addEventListener('online', () => this.run());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.run(); });
    this.run();
  }
}
