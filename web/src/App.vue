<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { AuthSession, type RefreshResult } from './auth-session';

const session = new AuthSession();
const state = ref<'checking' | 'signed-out' | 'authenticated' | 'unavailable'>('checking');
const busy = ref(false);
const message = ref('Checking for an existing LinguaLoop session…');

function showRefreshResult(result: RefreshResult): void {
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
  busy.value = true;
  message.value = 'Checking your session…';
  showRefreshResult(await session.refresh());
  busy.value = false;
}

async function logout(): Promise<void> {
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
      <p class="note">Google sign-in opens in this tab. Practice and profile details are not available yet.</p>
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
