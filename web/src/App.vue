<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { AuthSession, type RefreshResult } from './auth-session';
import { MAX_AUDIO_BYTES, MAX_RECORDING_MS, selectSupportedAudioMimeType, transcriptionErrorMessage } from './practice-audio';

const session = new AuthSession();
const state = ref<'checking' | 'signed-out' | 'authenticated' | 'unavailable'>('checking');
const busy = ref(false);
const message = ref('Checking for an existing LinguaLoop session…');
const recording = ref(false);
const starting = ref(false);
const stopping = ref(false);
const transcribing = ref(false);
const audioMessage = ref('');
const transcript = ref('');
let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let recordingTimer: ReturnType<typeof setTimeout> | null = null;
let captureSequence = 0;
let discardCapture = false;

function showRefreshResult(result: RefreshResult): void {
  if (state.value === 'authenticated' && result !== 'authenticated') discardPractice();
  if (result === 'authenticated') {
    state.value = 'authenticated';
    message.value = 'You are signed in. Your access token stays in memory for this page only.';
  } else if (result === 'no-session') {
    state.value = 'signed-out';
    message.value = 'You are signed out. Sign in with Google to continue.';
  } else {
    state.value = 'unavailable';
    message.value = 'Session status is temporarily unavailable. Check your connection or try again.';
  }
}

async function checkSession(): Promise<void> {
  if (state.value === 'authenticated') discardPractice();
  busy.value = true;
  message.value = 'Checking your session…';
  showRefreshResult(await session.refresh());
  busy.value = false;
}

function discardPractice(): void {
  captureSequence++;
  discardCapture = true;
  starting.value = false;
  stopping.value = false;
  transcribing.value = false;
  transcript.value = '';
  audioMessage.value = '';
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  releaseMicrophone();
}

function releaseMicrophone(): void {
  if (recordingTimer) clearTimeout(recordingTimer);
  recordingTimer = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  recording.value = false;
}

function stopRecording(): void {
  const activeRecorder = recorder;
  if (!activeRecorder || activeRecorder.state === 'inactive' || stopping.value) return;
  stopping.value = true;
  activeRecorder.stop();
}

async function startRecording(): Promise<void> {
  if (starting.value || recorder || recording.value || transcribing.value) return;
  const requestSequence = ++captureSequence;
  discardCapture = false;
  transcript.value = '';
  audioMessage.value = '';
  const mimeType = selectSupportedAudioMimeType();
  if (!mimeType) {
    audioMessage.value = 'This browser does not support a compatible audio recording format.';
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    audioMessage.value = 'Microphone recording is not supported in this browser.';
    return;
  }

  starting.value = true;
  try {
    const acquiredStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    starting.value = false;
    if (requestSequence !== captureSequence || state.value !== 'authenticated') {
      acquiredStream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = acquiredStream;
    const chunks: BlobPart[] = [];
    let capturedBytes = 0;
    let exceededLimit = false;
    const activeRecorder = new MediaRecorder(stream, { mimeType });
    recorder = activeRecorder;
    activeRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size === 0 || exceededLimit) return;
      capturedBytes += event.data.size;
      if (capturedBytes > MAX_AUDIO_BYTES) {
        exceededLimit = true;
        chunks.length = 0;
        stopping.value = true;
        if (activeRecorder.state !== 'inactive') activeRecorder.stop();
        return;
      }
      chunks.push(event.data);
    });
    activeRecorder.addEventListener('error', () => {
      discardCapture = true;
      captureSequence++;
      transcribing.value = false;
      releaseMicrophone();
      recorder = null;
      stopping.value = false;
      audioMessage.value = 'The browser could not record audio. Check microphone permission and try again.';
    }, { once: true });
    activeRecorder.addEventListener('stop', () => {
      releaseMicrophone();
      recorder = null;
      stopping.value = false;
      if (discardCapture) return;
      if (exceededLimit) {
        audioMessage.value = 'This recording is too large. Keep it under 2 MiB and try again.';
        return;
      }
      const audio = new Blob(chunks, { type: mimeType });
      if (audio.size === 0) {
        audioMessage.value = 'No audio was captured. Try recording again.';
        return;
      }
      if (audio.size > MAX_AUDIO_BYTES) {
        audioMessage.value = 'This recording is too large. Keep it under 2 MiB and try again.';
        return;
      }
      void uploadRecording(audio);
    }, { once: true });
    activeRecorder.start(1000);
    recording.value = true;
    recordingTimer = setTimeout(() => { void stopRecording(); }, MAX_RECORDING_MS);
  } catch {
    starting.value = false;
    releaseMicrophone();
    recorder = null;
    audioMessage.value = 'Microphone access was denied or unavailable. Allow microphone access and try again.';
  }
}

async function uploadRecording(audio: Blob): Promise<void> {
  const sequence = ++captureSequence;
  transcribing.value = true;
  audioMessage.value = 'Sending audio for transcription…';
  const result = await session.transcribe(audio);
  if (sequence !== captureSequence) return;
  transcribing.value = false;
  if (result.ok) {
    transcript.value = result.transcript;
    audioMessage.value = 'Transcription complete.';
  } else {
    audioMessage.value = transcriptionErrorMessage(result.error);
  }
}

async function logout(): Promise<void> {
  discardPractice();
  busy.value = true;
  message.value = 'Requesting server-side sign-out…';
  const revoked = await session.logout();
  if (revoked) {
    state.value = 'signed-out';
    message.value = 'You are signed out. The server revoked this session.';
  } else {
    state.value = session.authenticated ? 'authenticated' : 'unavailable';
    message.value = session.authenticated
      ? 'The server did not confirm sign-out. Your session is still active; try again.'
      : 'The server did not confirm sign-out. Check your connection before assuming the session was revoked.';
  }
  busy.value = false;
}

onMounted(() => {
  void checkSession();
});

onUnmounted(() => {
  discardPractice();
});
</script>

<template>
  <main class="shell">
    <p class="eyebrow">Language practice</p>
    <h1>LinguaLoop</h1>
    <p class="intro">
      A fresh space for building confidence in another language, one conversation
      at a time.
    </p>

    <section class="auth-card" aria-labelledby="auth-heading">
      <h2 id="auth-heading">Your account</h2>
      <p class="status" :data-state="state" role="status" aria-live="polite">{{ message }}</p>
      <div class="actions">
        <a v-if="state === 'signed-out' || state === 'unavailable'"
           class="button primary" href="/api/auth/google">
          Sign in with Google
        </a>
        <button type="button" :disabled="busy" @click="checkSession">
          Check status
        </button>
        <button v-if="state === 'authenticated'" type="button" class="secondary"
                :disabled="busy" @click="logout">
          Log out
        </button>
      </div>
      <section v-if="state === 'authenticated'" class="practice-card" aria-labelledby="practice-heading">
        <h2 id="practice-heading">Speak a phrase</h2>
        <p>Recording starts only when you choose Start. Audio is sent for transcription when you stop.</p>
        <div class="actions">
          <button v-if="!recording" type="button" :disabled="starting || transcribing" @click="startRecording">
            {{ starting ? 'Waiting for microphone…' : 'Start recording' }}
          </button>
          <button v-else type="button" class="secondary" :disabled="stopping" @click="stopRecording">
            {{ stopping ? 'Finishing recording…' : 'Stop and transcribe' }}
          </button>
        </div>
        <p v-if="recording" class="note" role="status">Recording… It will stop automatically after 20 seconds.</p>
        <p v-if="audioMessage" class="note" role="status" aria-live="polite">{{ audioMessage }}</p>
        <div v-if="transcript" class="transcript" aria-live="polite">
          <h3>Transcript</h3>
          <p>{{ transcript }}</p>
        </div>
      </section>
      <p class="note">Google sign-in opens in this tab. Audio is not saved; no coaching or speech playback is included.</p>
    </section>
  </main>
</template>

<style>
:root {
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  color: #18243a;
  background: #f5f7fb;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

body {
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
}

.shell {
  box-sizing: border-box;
  display: grid;
  align-content: center;
  min-height: 100vh;
  max-width: 680px;
  margin: 0 auto;
  padding: 3rem 1.5rem;
}

.eyebrow {
  margin: 0 0 0.75rem;
  color: #5268b4;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  font-size: clamp(3rem, 10vw, 5.5rem);
  letter-spacing: -0.07em;
}

.intro {
  max-width: 36rem;
  color: #536078;
  font-size: 1.15rem;
  line-height: 1.65;
}

.auth-card {
  margin-top: 1.5rem;
  padding: 1.5rem;
  border: 1px solid #d7deed;
  border-radius: 1rem;
  background: #fff;
  box-shadow: 0 0.75rem 2rem rgb(24 36 58 / 6%);
}

.practice-card {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #e2e7f0;
}

.practice-card > p {
  color: #536078;
  line-height: 1.5;
}

.transcript {
  margin-top: 1.25rem;
  padding: 1rem;
  border-radius: 0.6rem;
  background: #f5f7fb;
  overflow-wrap: anywhere;
}

.transcript h3 {
  margin: 0;
  font-size: 1rem;
}

.transcript p {
  margin-bottom: 0;
  white-space: pre-wrap;
}

h2 {
  margin: 0;
  font-size: 1.2rem;
}

.status {
  min-height: 1.5em;
  color: #465575;
  line-height: 1.5;
}

.status[data-state='authenticated'] {
  color: #176442;
}

.status[data-state='unavailable'] {
  color: #8a4b08;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

button,
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.75rem;
  padding: 0.65rem 1rem;
  border: 1px solid #c5cee0;
  border-radius: 0.6rem;
  background: #fff;
  color: #243452;
  font: inherit;
  font-weight: 650;
  text-decoration: none;
  cursor: pointer;
}

button:focus-visible,
.button:focus-visible {
  outline: 3px solid #5268b4;
  outline-offset: 2px;
}

button:disabled {
  cursor: wait;
  opacity: 0.65;
}

.button.primary {
  border-color: #354b9a;
  background: #354b9a;
  color: #fff;
}

button.secondary {
  border-color: #a94e4e;
  color: #8b3030;
}

.note {
  margin: 1rem 0 0;
  color: #66728a;
  font-size: 0.9rem;
  line-height: 1.5;
}
</style>
