// Keep Safari presentation modes and the standard PiP API behind one lifecycle.
// Relay PiP owns its video node: RTC negotiation must never replace its srcObject.
export function createPictureInPicture({ canvas, getRtcVideo, notify, onChange, document: doc = document }) {
  let relayVideo = null;
  let relayStream = null;
  let currentVideo = null;
  let active = false;
  let disposed = false;
  let pending = false;
  const listeners = new Map();

  const isActiveVideo = video => Boolean(video && (
    doc.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture'
  ));

  function releaseRelay() {
    const video = relayVideo;
    if (!video) return;
    const events = listeners.get(video);
    for (const [event, handler] of Object.entries(events || {})) video.removeEventListener(event, handler);
    listeners.delete(video);
    relayVideo = null;
    video.pause(); video.srcObject = null; video.remove();
    for (const track of relayStream?.getTracks() || []) track.stop();
    relayStream = null;
    if (currentVideo === video) currentVideo = null;
  }

  function update() {
    const next = isActiveVideo(currentVideo);
    if (active === next) return;
    active = next;
    onChange?.(active);
    if (!active) releaseRelay();
  }

  function observe(video) {
    if (listeners.has(video)) return;
    const entered = () => { currentVideo = video; update(); };
    const left = () => {
      if (currentVideo !== video) return;
      // Some implementations update their properties after dispatching leave.
      if (active) { active = false; onChange?.(false); }
      releaseRelay();
    };
    const events = { enterpictureinpicture: entered, leavepictureinpicture: left, webkitpresentationmodechanged: update };
    for (const [event, handler] of Object.entries(events)) video.addEventListener(event, handler);
    listeners.set(video, events);
  }

  function prepare() {
    if (disposed) return null;
    const rtcVideo = getRtcVideo?.();
    if (rtcVideo) { observe(rtcVideo); return rtcVideo; }
    if (relayVideo) return relayVideo;
    if (!canvas?.captureStream) throw new Error('Este navegador não permite preparar esta transmissão para PiP.');
    if (!canvas.width || !canvas.height) throw new Error('Aguarde a imagem da transmissão aparecer.');
    const video = doc.createElement('video');
    if (!video.requestPictureInPicture && !video.webkitSetPresentationMode) {
      throw new Error('PiP indisponível neste navegador. No iPhone, abra o link no Safari.');
    }
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // Relay audio continues through its existing audio player.
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    video.className = 'pip-relay-video';
    video.tabIndex = -1;
    const stream = canvas.captureStream(30);
    relayStream = stream;
    relayVideo = video;
    video.srcObject = stream;
    doc.body.append(video);
    observe(video);
    video.play()?.catch(() => {});
    return video;
  }

  function warmup() {
    try { prepare(); } catch { /* The click handler supplies actionable feedback. */ }
  }

  async function toggle() {
    if (disposed || pending) return;
    try {
      if (active && currentVideo) {
        if (currentVideo.webkitPresentationMode === 'picture-in-picture') {
          currentVideo.webkitSetPresentationMode('inline');
          update();
        } else if (doc.exitPictureInPicture) {
          await doc.exitPictureInPicture();
          update();
        }
        return;
      }
      const video = prepare();
      if (!video) return;
      currentVideo = video;
      // Do not await play(): WebKit requires the PiP request in the touch/click
      // activation, not in a later canplay callback or play() promise continuation.
      video.play()?.catch(() => {});
      if (video.readyState < 2) {
        notify?.('Preparando o vídeo. Toque novamente no PiP quando a imagem estiver pronta.');
        return;
      }
      const safari = typeof video.webkitSetPresentationMode === 'function' &&
        (!video.webkitSupportsPresentationMode || video.webkitSupportsPresentationMode('picture-in-picture'));
      if (safari) {
        video.webkitSetPresentationMode('picture-in-picture');
        update();
      } else if (typeof video.requestPictureInPicture === 'function' && doc.pictureInPictureEnabled !== false) {
        pending = true;
        await video.requestPictureInPicture();
        if (!disposed) update();
        else if (doc.pictureInPictureElement === video) await doc.exitPictureInPicture?.();
      } else {
        notify?.('O PiP está indisponível neste ambiente. No iPhone, abra o link diretamente no Safari.', true);
        releaseRelay();
      }
    } catch (error) {
      console.warn('[PiP] Falha ao abrir:', error?.name, error?.message);
      const denied = ['NotAllowedError', 'SecurityError', 'NotSupportedError'].includes(error?.name);
      notify?.(denied
        ? 'O navegador bloqueou o PiP. No iPhone, abra o link diretamente no Safari e toque no botão novamente.'
        : (error?.message || 'Não foi possível abrir a janela flutuante.'), true);
      if (!active) releaseRelay();
    } finally { pending = false; }
  }

  function dispose() {
    disposed = true;
    if (isActiveVideo(currentVideo)) {
      try {
        if (currentVideo.webkitPresentationMode === 'picture-in-picture') currentVideo.webkitSetPresentationMode('inline');
        else doc.exitPictureInPicture?.()?.catch(() => {});
      } catch {}
    }
    for (const [video, events] of listeners) {
      for (const [event, handler] of Object.entries(events)) video.removeEventListener(event, handler);
    }
    listeners.clear();
    releaseRelay();
    relayVideo = null; relayStream = null; currentVideo = null;
    if (active) { active = false; onChange?.(false); }
  }

  return { warmup, toggle, dispose, get active() { return active; } };
}
