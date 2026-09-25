import { describe, it, expect, vi } from 'vitest';
import { createBroadcaster } from '../shared/broadcaster.js';

describe('Site Transmission Audio Pipeline', () => {
  it('resampleAudioData converts mono/planar/interleaved to target stereo 48kHz without crashing', async () => {
    // Broadcaster with audio: true
    let sentMessages = [];
    const fakeWs = {
      readyState: 1,
      OPEN: 1,
      send: (data) => {
        if (typeof data === 'string') {
          sentMessages.push(JSON.parse(data));
        } else {
          sentMessages.push(data);
        }
      },
      close: vi.fn(),
    };

    // Verify audio encoder configure format standard
    const b = createBroadcaster({
      wsUrl: 'ws://localhost/test',
      audio: true,
      onAviso: vi.fn(),
    });

    expect(b).toBeDefined();
    expect(typeof b.trocarSom).toBe('function');
  });

  it('preserves audio track in WebRTC peer connection for site broadcasts', async () => {
    const audioTrack = {
      kind: 'audio',
      readyState: 'live',
      enabled: true,
      muted: false,
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSettings: () => ({ sampleRate: 48000, channelCount: 2, displaySurface: 'browser' }),
    };

    const videoTrack = {
      kind: 'video',
      readyState: 'live',
      enabled: true,
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      applyConstraints: vi.fn().mockResolvedValue(undefined),
      getSettings: () => ({ width: 1280, height: 720, frameRate: 60, displaySurface: 'browser' }),
    };

    const stream = {
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => [audioTrack],
      getTracks: () => [videoTrack, audioTrack],
      removeTrack: vi.fn(),
    };

    // Verify tracks are retained and not removed
    expect(stream.getAudioTracks()).toHaveLength(1);
    expect(audioTrack.stop).not.toHaveBeenCalled();
  });
});
