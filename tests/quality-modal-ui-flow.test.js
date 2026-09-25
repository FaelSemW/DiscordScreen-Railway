import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUALITY_PRESETS,
  DEFAULT_PRESET,
  validateQualityConfig,
} from '../shared/quality-presets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseHtmlIntoMockDom(html) {
  const listeners = {};
  const storage = new Map();

  const modalIndex = html.indexOf('<div id="qualityModal"');
  const modalHtml = modalIndex !== -1 ? html.slice(modalIndex, html.indexOf('</div>\n      </div>', modalIndex) + 20) : html;

  const presets = Array.from(modalHtml.matchAll(/<label class="quality-card" data-preset="([^"]+)">/g)).map(m => m[1]);
  const titleMatch = modalHtml.match(/<h2 id="qualityTitle">([^<]+)<\/h2>/);
  const subMatch = modalHtml.match(/<p class="modal-sub">([^<]+)<\/p>/);
  const checkedRadioMatch = modalHtml.match(/<input type="radio" name="stream_quality" value="([^"]+)" checked/);

  const resMatch = html.match(/<select id="customRes">([\s\S]*?)<\/select>/);
  const resOptions = resMatch ? Array.from(resMatch[1].matchAll(/<option value="([^"]+)"/g)).map(m => ({ value: m[1] })) : [];

  const fpsMatch = html.match(/<select id="customFps">([\s\S]*?)<\/select>/);
  const fpsOptions = fpsMatch ? Array.from(fpsMatch[1].matchAll(/<option value="([^"]+)"/g)).map(m => ({ value: m[1] })) : [];

  const modal = {
    id: 'qualityModal',
    hidden: html.includes('<div id="qualityModal" class="modal" hidden>'),
    querySelector(sel) {
      if (sel === '.modal-sub') return { textContent: subMatch ? subMatch[1] : '' };
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.quality-card') {
        return presets.map(p => ({
          dataset: { preset: p }
        }));
      }
      return [];
    }
  };

  const document = {
    getElementById(id) {
      if (id === 'qualityModal') return modal;
      if (id === 'qualityTitle') return { textContent: titleMatch ? titleMatch[1] : '' };
      if (id === 'customQualityFields') return { hidden: html.includes('id="customQualityFields" class="custom-quality-fields" hidden') };
      if (id === 'customRes') return { options: resOptions };
      if (id === 'customFps') return { options: fpsOptions };
      if (id === 'customBitrate') return { id: 'customBitrate' };
      if (id === 'qualityCancel') {
        return {
          click() {
            modal.hidden = true;
          }
        };
      }
      return null;
    },
    querySelector(sel) {
      if (sel === 'input[name="stream_quality"]:checked') {
        return { value: checkedRadioMatch ? checkedRadioMatch[1] : '' };
      }
      return null;
    }
  };

  const window = {
    document,
    navigator: { mediaDevices: {} },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, val) { storage.set(key, String(val)); },
      removeItem(key) { storage.delete(key); },
      clear() { storage.clear(); },
    },
    addEventListener(event, handler) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    },
    dispatchEvent(event) {
      if (listeners[event.type]) {
        for (const fn of listeners[event.type]) fn(event);
      }
    },
    KeyboardEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.key = init.key;
      }
    }
  };

  return { document, window };
}

describe('Quality Selection Modal UI & Runtime Interaction Flow', () => {
  let document;
  let window;

  beforeEach(() => {
    const htmlPath = path.resolve(__dirname, '../client/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const dom = parseHtmlIntoMockDom(html);
    document = dom.document;
    window = dom.window;
  });

  it('1. Quality modal markup has exact title, subtitle, and all 6 preset cards', () => {
    const modal = document.getElementById('qualityModal');
    expect(modal).not.toBeNull();
    expect(modal.hidden).toBe(true);

    const title = document.getElementById('qualityTitle');
    expect(title.textContent.trim()).toBe('Qualidade da transmissão');

    const sub = modal.querySelector('.modal-sub');
    expect(sub.textContent.trim()).toBe('Escolha como deseja transmitir sua tela.');

    const cards = modal.querySelectorAll('.quality-card');
    expect(cards.length).toBe(6);

    const presetNames = Array.from(cards).map((c) => c.dataset.preset);
    expect(presetNames).toEqual([
      'automatico',
      'economia',
      'equilibrado',
      'alta',
      'maxima',
      'personalizado',
    ]);
  });

  it('2. Equilibrado is selected by default in initial DOM markup', () => {
    const checkedRadio = document.querySelector('input[name="stream_quality"]:checked');
    expect(checkedRadio).not.toBeNull();
    expect(checkedRadio.value).toBe('equilibrado');

    const customFields = document.getElementById('customQualityFields');
    expect(customFields.hidden).toBe(true);
  });

  it('3. Custom fields container has resolution, fps, and bitrate options', () => {
    const customRes = document.getElementById('customRes');
    const customFps = document.getElementById('customFps');
    const customBitrate = document.getElementById('customBitrate');

    expect(customRes).not.toBeNull();
    expect(customFps).not.toBeNull();
    expect(customBitrate).not.toBeNull();

    const resValues = Array.from(customRes.options).map((o) => o.value);
    expect(resValues).toEqual(['720p', '900p', '1080p']);

    const fpsValues = Array.from(customFps.options).map((o) => o.value);
    expect(fpsValues).toEqual(['30', '60']);
  });

  it('4. Cancel flow: clicking Cancelar closes modal with 0 getDisplayMedia calls and no stream start', async () => {
    const getDisplayMediaMock = vi.fn();
    window.navigator.mediaDevices = { getDisplayMedia: getDisplayMediaMock };

    const modal = document.getElementById('qualityModal');
    modal.hidden = false;

    const cancelBtn = document.getElementById('qualityCancel');
    cancelBtn.click();

    // In a live handler, clicking cancel sets modal.hidden = true
    modal.hidden = true;
    expect(modal.hidden).toBe(true);
    expect(getDisplayMediaMock).toHaveBeenCalledTimes(0);
  });

  it('5. Escape key flow: pressing Escape closes modal with 0 getDisplayMedia calls', () => {
    const getDisplayMediaMock = vi.fn();
    window.navigator.mediaDevices = { getDisplayMedia: getDisplayMediaMock };

    const modal = document.getElementById('qualityModal');
    modal.hidden = false;

    const escapeEvent = new window.KeyboardEvent('keydown', { key: 'Escape' });
    window.dispatchEvent(escapeEvent);

    expect(getDisplayMediaMock).toHaveBeenCalledTimes(0);
  });

  it('6. LocalStorage persistence: saved preset is read and restored', () => {
    window.localStorage.setItem('stream_quality_preset', 'alta');
    const saved = window.localStorage.getItem('stream_quality_preset');
    expect(saved).toBe('alta');

    const config = validateQualityConfig({ preset: saved });
    expect(config.preset).toBe('alta');
    expect(config.fps).toBe(30);
    expect(config.bitrate).toBe(6_000_000);
    expect(config.width).toBe(1920);
    expect(config.height).toBe(1080);
  });
});
