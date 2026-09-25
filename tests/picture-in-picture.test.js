import { describe, it, expect, vi } from 'vitest';
import { createPictureInPicture } from '../client/src/picture-in-picture.js';

function fixture({ safari = true, readyState = 4, rtc = false } = {}) {
  const video = new EventTarget();
  Object.assign(video, {
    readyState, muted: false, volume: 0.7, webkitPresentationMode: 'inline',
    play: vi.fn(() => new Promise(() => {})), pause: vi.fn(), remove: vi.fn(), setAttribute: vi.fn(),
  });
  const doc = { createElement: vi.fn(() => video), body: { append: vi.fn() }, pictureInPictureElement: null };
  if (safari) {
    video.webkitSupportsPresentationMode = vi.fn(() => true);
    video.webkitSetPresentationMode = vi.fn(mode => {
      video.webkitPresentationMode = mode;
      video.dispatchEvent(new Event('webkitpresentationmodechanged'));
    });
  } else {
    video.requestPictureInPicture = vi.fn(async () => {
      doc.pictureInPictureElement = video;
      video.dispatchEvent(new Event('enterpictureinpicture'));
    });
    doc.exitPictureInPicture = vi.fn(async () => {
      doc.pictureInPictureElement = null;
      video.dispatchEvent(new Event('leavepictureinpicture'));
    });
  }
  const track = { stop: vi.fn() };
  const canvas = { width: 1280, height: 720, captureStream: vi.fn(() => ({ getTracks: () => [track] })) };
  const notify = vi.fn();
  const onChange = vi.fn();
  const controller = createPictureInPicture({ canvas, getRtcVideo: () => rtc ? video : null, document: doc, notify, onChange });
  return { controller, video, doc, canvas, track, notify, onChange };
}

describe('Safari and standard Picture-in-Picture', () => {
  it('requests WebKit PiP synchronously without awaiting play or relying on the standard document property', async () => {
    const { controller, video, doc, onChange } = fixture();
    const opening = controller.toggle();
    expect(video.webkitSetPresentationMode).toHaveBeenCalledWith('picture-in-picture');
    expect(doc.pictureInPictureElement).toBeNull();
    expect(controller.active).toBe(true);
    await opening;
    expect(onChange).toHaveBeenCalledWith(true);
    await controller.toggle();
    expect(video.webkitSetPresentationMode).toHaveBeenLastCalledWith('inline');
    expect(controller.active).toBe(false);
    controller.dispose();
  });

  it('handles Safari leaving PiP using its own presentation event', async () => {
    const { controller, video, onChange } = fixture();
    await controller.toggle();
    video.webkitPresentationMode = 'inline';
    video.dispatchEvent(new Event('webkitpresentationmodechanged'));
    expect(controller.active).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(false);
    controller.dispose();
  });

  it('prepares once and asks for another tap if metadata is not ready', async () => {
    const { controller, video, canvas, notify } = fixture({ readyState: 0 });
    controller.warmup();
    await controller.toggle();
    expect(video.webkitSetPresentationMode).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Toque novamente'));
    video.readyState = 4;
    await controller.toggle();
    expect(canvas.captureStream).toHaveBeenCalledOnce();
    expect(controller.active).toBe(true);
    controller.dispose();
  });

  it('preserves the current RTC audio volume and does not stop received tracks', async () => {
    const { controller, video, canvas, track } = fixture({ rtc: true });
    await controller.toggle();
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(0.7);
    expect(canvas.captureStream).not.toHaveBeenCalled();
    controller.dispose();
    expect(track.stop).not.toHaveBeenCalled();
    expect(video.remove).not.toHaveBeenCalled();
  });

  it('still opens and exits standard PiP', async () => {
    const { controller, video, doc, track } = fixture({ safari: false });
    await controller.toggle();
    expect(video.requestPictureInPicture).toHaveBeenCalledOnce();
    expect(controller.active).toBe(true);
    await controller.toggle();
    expect(doc.exitPictureInPicture).toHaveBeenCalledOnce();
    expect(controller.active).toBe(false);
    controller.dispose();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(video.remove).toHaveBeenCalledOnce();
  });

  it('reports browser restrictions instead of falsely marking PiP active', async () => {
    const { controller, video, notify } = fixture({ safari: false });
    video.requestPictureInPicture.mockRejectedValue(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    await controller.toggle();
    expect(controller.active).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Safari'), true);
    controller.dispose();
  });
});
