// node --test (type stripping, Node >= 22.18): the ?caps= a TV sends, built
// from what its webapis and its web engine report — faked here. Excluded
// from the app's tsc program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_PROBES,
  VIDEO_PROBES,
  deviceCaps,
  needsUhdDecoderMode,
  panelHeight,
  tizenVersion,
  type CapsEnv,
} from './caps.ts';

const mime = (token: string): string =>
  [...VIDEO_PROBES, ...AUDIO_PROBES].find((p) => p.token === token)!.mime;

/** An MSE that says yes to the codecs of these tokens. */
const mse = (...tokens: string[]) => {
  const yes = new Set(tokens.map(mime));
  return { isTypeSupported: (type: string) => yes.has(type) };
};
/** A <video> whose canPlayType says "probably" to the codecs of these tokens. */
const video = (...tokens: string[]) => {
  const yes = new Set(tokens.map(mime));
  return { canPlayType: (type: string) => (yes.has(type) ? 'probably' : '') };
};
const panel = (uhd: boolean, eightK = false) => ({
  productinfo: { isUdPanelSupported: () => uhd, is8KPanelSupported: () => eightK },
});
/** A TV whose web engine is asked for every codec: one without AVPlay,
 *  where hls.js plays through MSE. */
const tv = (env: Omit<CapsEnv, 'tizen'>): string => deviceCaps({ tizen: true, ...env });
/** A TV that plays through AVPlay, as a Samsung TV does. */
const avTv = (env: Omit<CapsEnv, 'tizen' | 'avplay'>): string => deviceCaps({ tizen: true, avplay: true, ...env });

test('a 4K TV: what its engine says yes to, at the height of its panel', () => {
  assert.equal(
    tv({ webapis: panel(true), mediaSource: mse('avc', 'hvc', 'aac', 'mp3', 'ac3', 'eac3'), video: video() }),
    'avc:2160,hvc:2160,aac,mp3,ac3,eac3',
  );
  assert.equal(
    avTv({ webapis: panel(true), mediaSource: mse('avc', 'hvc', 'aac', 'mp3', 'ac3', 'eac3'), video: video() }),
    'avc:2160,hvc:2160,aac,mp3,ac3,eac3',
  );
});

test('a TV that does not report HEVC, AC-3 or E-AC-3 is not sent them, but for E-AC-3 through AVPlay', () => {
  // The hard-coded caps sent every TV the HEVC rungs and the 5.1 E-AC-3 group.
  assert.equal(tv({ webapis: panel(true), mediaSource: mse('avc', 'aac', 'mp3'), video: video() }), 'avc:2160,aac,mp3');
  assert.equal(tv({ webapis: panel(true), mediaSource: mse('avc', 'aac', 'eac3'), video: video() }), 'avc:2160,aac,eac3');
  assert.equal(avTv({ webapis: panel(true), mediaSource: mse('avc', 'aac', 'mp3'), video: video() }), 'avc:2160,aac,mp3,eac3');
});

test('E-AC-3 where AVPlay plays: every Samsung TV decodes DD+, whatever its web engine says', () => {
  const engine = { webapis: panel(true), mediaSource: mse('avc', 'aac'), video: video() };
  assert.equal(avTv(engine), 'avc:2160,aac,eac3');
  // Said yes to by the engine as well: once.
  assert.equal(avTv({ ...engine, mediaSource: mse('avc', 'aac', 'eac3') }), 'avc:2160,aac,eac3');
  assert.equal(avTv({ ...engine, mediaSource: null, video: video('eac3') }), 'avc:2160,aac,eac3');
  // No codec query at all, no panel.
  assert.equal(avTv({ webapis: null }), 'avc:1080,aac,mp3,eac3');
  // No AVPlay: hls.js plays through MSE, and the engine's answer counts.
  assert.equal(tv(engine), 'avc:2160,aac');
  assert.equal(tv({ ...engine, avplay: false }), 'avc:2160,aac');
  // AC-3 is asked, AVPlay or not.
  assert.equal(avTv({ ...engine, mediaSource: mse('avc', 'aac', 'ac3') }), 'avc:2160,aac,ac3,eac3');
});

test('an FHD panel caps every codec at 1080, an 8K one HEVC and AV1 at 4320', () => {
  assert.equal(tv({ webapis: panel(false), mediaSource: mse('avc', 'hvc', 'aac'), video: video() }), 'avc:1080,hvc:1080,aac');
  assert.equal(
    tv({ webapis: panel(true, true), mediaSource: mse('avc', 'hvc', 'av1', 'aac', 'opus'), video: video() }),
    'avc:2160,hvc:4320,av1:4320,aac,opus',
  );
});

test('on a TV either query saying yes counts: canPlayType speaks for the native pipeline', () => {
  assert.equal(
    tv({ webapis: panel(true), mediaSource: mse('avc', 'aac'), video: video('hvc', 'eac3') }),
    'avc:2160,hvc:2160,aac,eac3',
  );
  const maybe = { canPlayType: (type: string) => (type === mime('ac3') ? 'maybe' : '') };
  assert.equal(tv({ webapis: panel(true), mediaSource: mse('avc', 'aac'), video: maybe }), 'avc:2160,aac,ac3');
});

test('a panel that cannot be read is taken for 1080', () => {
  const env = { mediaSource: mse('avc', 'hvc', 'aac'), video: video() };
  assert.equal(tv({ ...env, webapis: null }), 'avc:1080,hvc:1080,aac');
  assert.equal(tv({ ...env, webapis: {} }), 'avc:1080,hvc:1080,aac');
  // No productinfo privilege: the call throws.
  const denied = { productinfo: { isUdPanelSupported: (): boolean => { throw new Error('SecurityError'); } } };
  assert.equal(tv({ ...env, webapis: denied }), 'avc:1080,hvc:1080,aac');
});

test('no codec query at all: avc, aac and mp3, and no more', () => {
  assert.equal(tv({ webapis: panel(true), mediaSource: null, video: null }), 'avc:2160,aac,mp3');
  assert.equal(tv({ webapis: null }), 'avc:1080,aac,mp3');
  assert.equal(deviceCaps({ tizen: false }), 'avc,aac,mp3');
});

test('avc and aac are always sent; a query that throws is a no', () => {
  const throwing = { isTypeSupported: (): boolean => { throw new Error('boom'); } };
  assert.equal(tv({ webapis: panel(true), mediaSource: throwing, video: video() }), 'avc:2160,aac');
  assert.equal(tv({ webapis: panel(false), mediaSource: mse(), video: video() }), 'avc:1080,aac');
});

test('never AAC beyond two channels, never a codec the probes do not ask about', () => {
  const everything = { isTypeSupported: () => true };
  assert.equal(
    tv({ webapis: panel(true), mediaSource: everything, video: video() }),
    'avc:2160,hvc:2160,av1:2160,aac,mp3,opus,ac3,eac3',
  );
});

test('off a TV the browser is asked as chino-web asks it: MSE first, no heights', () => {
  // With MediaSource, canPlayType does not count (hls.js plays through MSE).
  assert.equal(deviceCaps({ tizen: false, mediaSource: mse('avc', 'aac'), video: video('hvc') }), 'avc,aac');
  // Without, canPlayType answers.
  assert.equal(deviceCaps({ tizen: false, mediaSource: null, video: video('hvc', 'aac', 'mp3') }), 'avc,hvc,aac,mp3');
  // A panel is not read off a TV.
  assert.equal(deviceCaps({ tizen: false, webapis: panel(true), mediaSource: mse('hvc') }), 'avc,hvc,aac');
  // E-AC-3 where MSE says so (a desktop Chrome does not), never by assumption.
  assert.equal(deviceCaps({ tizen: false, mediaSource: mse('avc', 'aac', 'eac3') }), 'avc,aac,eac3');
  assert.equal(deviceCaps({ tizen: false, avplay: true, mediaSource: mse('avc', 'aac') }), 'avc,aac');
});

test('the panel height productinfo reports', () => {
  assert.equal(panelHeight(panel(true, true).productinfo), 4320);
  assert.equal(panelHeight(panel(true).productinfo), 2160);
  assert.equal(panelHeight(panel(false).productinfo), 1080);
  // A firmware without the 8K call still answers for 4K.
  assert.equal(panelHeight({ isUdPanelSupported: () => true }), 2160);
  assert.equal(
    panelHeight({ isUdPanelSupported: () => true, is8KPanelSupported: () => { throw new Error('no'); } }),
    2160,
  );
  assert.equal(panelHeight({}), null);
  assert.equal(panelHeight(null), null);
  assert.equal(panelHeight(undefined), null);
});

test("the Tizen version a TV's user agent names", () => {
  // Samsung's user agents per year (Retrieving Platform Information).
  assert.equal(tizenVersion('Mozilla/5.0 (SMART-TV; LINUX; Tizen 4.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 TV Safari/537.36'), 4);
  assert.equal(tizenVersion('Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106.1/5.5 TV Safari/537.36'), 5.5);
  assert.equal(tizenVersion('Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1'), 2.4);
  assert.equal(tizenVersion('Mozilla/5.0 (SMART-TV; LINUX; Tizen 10.0) AppleWebKit/537.36 (KHTML, like Gecko) 130.0.6723.116/10.0 TV Safari/537.36'), 10);
  assert.equal(tizenVersion('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36'), null);
  assert.equal(tizenVersion(undefined), null);
});

test('SET_MODE_4K: a UHD panel before Tizen 5.0 only', () => {
  assert.equal(needsUhdDecoderMode(4, 2160), true);
  assert.equal(needsUhdDecoderMode(4, 4320), true);
  // An FHD panel is never sent a 2160 rung; an unread panel is taken for 1080.
  assert.equal(needsUhdDecoderMode(4, 1080), false);
  assert.equal(needsUhdDecoderMode(4, null), false);
  // Deprecated from Tizen 5.0: the manifest's resolutions do its job there.
  assert.equal(needsUhdDecoderMode(5, 2160), false);
  assert.equal(needsUhdDecoderMode(6.5, 4320), false);
  assert.equal(needsUhdDecoderMode(null, 2160), false);
});
