const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const path = require('node:path');
const { ResponseAudioPlayback, SpeakingEventState, onRecordingActivity } = require('../src/features/language-practice/react-live-audio.ts');

class FakeAudio extends EventTarget {}

test('partner speaks only on actual playing and returns to listening on pause, ended, error, or cleanup', () => {
  const states = [];
  const playback = new ResponseAudioPlayback((speaking) => states.push(speaking));
  const audio = new FakeAudio();
  const detach = playback.attach(audio);

  audio.dispatchEvent(new Event('play'));
  assert.equal(playback.speaking, false, 'play request/loading is not audible playback');
  audio.dispatchEvent(new Event('playing'));
  assert.equal(playback.speaking, true);
  audio.dispatchEvent(new Event('pause'));
  assert.equal(playback.speaking, false);
  audio.dispatchEvent(new Event('playing'));
  audio.dispatchEvent(new Event('ended'));
  assert.equal(playback.speaking, false);
  audio.dispatchEvent(new Event('playing'));
  audio.dispatchEvent(new Event('error'));
  assert.equal(playback.speaking, false);
  audio.dispatchEvent(new Event('playing'));
  detach();
  assert.equal(playback.speaking, false);
  audio.dispatchEvent(new Event('playing'));
  assert.equal(playback.speaking, false, 'detached media must not revive stale speech');
  assert.deepEqual(states, [true, false, true, false, true, false, true, false]);
});

test('actual recording start pauses partner playback and replay remains available afterward', () => {
  const states = [];
  let partnerSpeaking = false;
  let learnerSpeaking = false;
  const audio = new class extends FakeAudio {
    pauseCalls = 0;
    pause() {
      this.pauseCalls += 1;
      this.dispatchEvent(new Event('pause'));
    }
  }();
  const playback = new ResponseAudioPlayback((speaking) => {
    partnerSpeaking = speaking;
    states.push({ learner: learnerSpeaking, partner: partnerSpeaking });
  });
  const recorderActivity = new SpeakingEventState((recording) => {
    onRecordingActivity(recording, audio, (learner) => {
      learnerSpeaking = learner;
      states.push({ learner: learnerSpeaking, partner: partnerSpeaking });
    }, () => { partnerSpeaking = false; }, playback);
  }, 'start', ['stop', 'error']);
  playback.attach(audio);
  const recorder = new FakeAudio();
  recorderActivity.attach(recorder);

  audio.dispatchEvent(new Event('playing'));
  assert.equal(playback.speaking, true);
  recorder.dispatchEvent(new Event('start'));
  assert.equal(audio.pauseCalls, 1, 'actual MediaRecorder start must pause the response audio');
  assert.equal(playback.speaking, false);
  assert.equal(partnerSpeaking, false);
  assert.equal(recorderActivity.speaking, true);

  // A queued `playing` event can arrive after actual recording has started,
  // even though starting the recorder already paused the response audio.
  audio.dispatchEvent(new Event('playing'));
  assert.equal(playback.speaking, false, 'late playback events must be rejected while recording');
  assert.equal(partnerSpeaking, false, 'the partner must never speak during learner recording');
  assert.ok(states.every((state) => !(state.learner && state.partner)), 'both participants must never be speaking');

  recorder.dispatchEvent(new Event('stop'));
  assert.equal(recorderActivity.speaking, false);
  audio.dispatchEvent(new Event('playing'));
  assert.equal(playback.speaking, true, 'response replay remains available after recording ends');
  assert.ok(states.every((state) => !(state.learner && state.partner)));
});

test('playback failures before playing never enter the speaking state', () => {
  const states = [];
  const playback = new ResponseAudioPlayback((speaking) => states.push(speaking));
  const audio = new FakeAudio();
  const detach = playback.attach(audio);
  audio.dispatchEvent(new Event('error'));
  audio.dispatchEvent(new Event('pause'));
  detach();
  assert.deepEqual(states, []);
  assert.equal(playback.speaking, false);
});

test('live view observes media playback lifecycle and clears it during replacement and cleanup', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/language-practice/LivePracticeView.tsx'), 'utf8');
  assert.match(source, /audioPlayback\.current\?\.attach\(audioElement\.current\)/);
  assert.match(source, /audioElement\.current\?\.pause\(\)/);
  assert.match(source, /onRecordingActivity\(recording, audioElement\.current, setLearnerSpeaking, \(\) => setPartnerSpeaking\(false\), audioPlayback\.current!\)/);
  assert.match(source, /disabled=\{recorderBusy\} onClick=\{\(\) => void replayAudio\(\)\}/);
  assert.match(source, /partnerState=\{partnerSpeaking \? 'speaking'/);
  assert.match(source, /learnerState=\{learnerSpeaking \? 'speaking'/);
});
