export class OfflineApp {
  constructor(onChange) {
    this.onChange = onChange; this.registration = null; this.requestedUpdate = false;
    this.state = { ready: false, waiting: false, checking: false, message: '正在准备离线资源…' };
  }
  updateState(patch) { Object.assign(this.state, patch); this.onChange(this.state); }
  watch(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') {
        this.updateState({ checking: false, waiting: !!this.registration.waiting });
        this.checkReady();
      }
      if (worker.state === 'redundant') this.updateState({ checking: false, message: '更新未完成，当前版本仍可使用' });
    });
  }
  async start() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      this.updateState({ message: '离线安装需要 HTTPS 地址' }); return;
    }
    try {
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (this.requestedUpdate) location.reload(); else this.checkReady(); });
      this.registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      this.registration.addEventListener('updatefound', () => this.watch(this.registration.installing));
      this.watch(this.registration.installing);
      this.updateState({ waiting: !!this.registration.waiting });
      await navigator.serviceWorker.ready;
      await this.checkReady();
    } catch { this.updateState({ checking: false, message: '离线资源未准备好，请联网后重试' }); }
  }
  async checkReady() {
    const worker = this.registration?.active;
    if (!worker) return;
    const channel = new MessageChannel(); let timer;
    try {
      const result = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Offline status timeout')), 5000);
        channel.port1.onmessage = event => resolve(event.data);
        worker.postMessage({ type: 'OFFLINE_STATUS' }, [channel.port2]);
      });
      this.updateState({ ready: result.ready === true, message: result.ready ? '离线资源已就绪' : '离线资源不完整，请联网检查更新' });
    } catch { this.updateState({ message: '正在等待离线资源就绪' }); }
    finally { clearTimeout(timer); channel.port1.close(); }
  }
  async checkUpdate() {
    if (!this.registration) return this.start();
    this.updateState({ checking: true });
    try {
      await this.registration.update();
      if (!this.registration.installing) this.updateState({ checking: false, waiting: !!this.registration.waiting });
      await this.checkReady();
    } catch { this.updateState({ checking: false, message: this.state.ready ? '暂时无法联网检查，离线版本仍可使用' : '更新检查失败，请联网后重试' }); }
  }
  activateUpdate() {
    if (!this.registration?.waiting) return;
    this.requestedUpdate = true;
    this.registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
  }
}
