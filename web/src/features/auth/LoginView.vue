<template>
  <main class="login-screen">
    <div class="shade" aria-hidden="true"></div>
    <section class="login-card" aria-labelledby="login-title">
      <div class="brand-panel">
        <div>
          <h1>LinguaLoop</h1>
          <p>Language practice</p>
        </div>
      </div>
      <div class="login-content">
        <header>
          <h2 id="login-title">Welcome</h2>
          <p>Sign in to continue to your language practice setup.</p>
        </header>
        <p v-if="unavailable" class="notice" role="status">
          We could not check your session. You can try signing in again.
        </p>
        <p v-else-if="logoutUnconfirmed" class="notice" role="alert">
          The server did not confirm sign-out. Your local practice page was cleared, but the server session may still be active.
        </p>
        <a class="google-button" href="/api/auth/google">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.55h3.24c1.9-1.75 2.98-4.33 2.98-7.42Z" />
            <path fill="#34A853" d="M12 22c2.7 0 4.98-.9 6.63-2.35l-3.24-2.55c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.63A10 10 0 0 0 12 22Z" />
            <path fill="#FBBC05" d="M6.39 13.93A6.02 6.02 0 0 1 6.07 12c0-.67.12-1.32.32-1.93V7.44H3.04A10 10 0 0 0 2 12c0 1.63.39 3.17 1.04 4.56l3.35-2.63Z" />
            <path fill="#EA4335" d="M12 5.94c1.47 0 2.79.5 3.83 1.5l2.87-2.88A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.96 5.44l3.35 2.63C7.18 7.7 9.39 5.94 12 5.94Z" />
          </svg>
          <span>Continue with Google</span>
        </a>
        <p class="account-note">Use your Google account to access your private practice space.</p>
        <footer>© {{ new Date().getFullYear() }} LinguaLoop</footer>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const unavailable = computed(() => route.query.status === 'unavailable')
const logoutUnconfirmed = computed(() => route.query.logout === 'unconfirmed')
</script>

<style scoped>
.login-screen {
  position: relative;
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 2rem 1rem;
  background: #e9edf4 url('/images/login-hero.jpg') center / cover fixed;
  font-family: Roboto, Inter, system-ui, sans-serif;
}
.shade { position: fixed; inset: 0; background: rgb(13 24 52 / 28%); }
.login-card {
  position: relative;
  display: grid;
  width: min(100%, 920px);
  overflow: hidden;
  border-radius: 1.2rem;
  background: white;
  box-shadow: 0 1.5rem 4rem rgb(12 24 49 / 24%);
}
.brand-panel {
  display: none;
  min-height: 30rem;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  background: #233a83;
  color: white;
  text-align: center;
}
.brand-panel h1 { margin: 0; font-size: 2.5rem; }
.brand-panel p { margin: .5rem 0; color: #e1e7f7; font-size: 1.2rem; }
.login-content { padding: 2.5rem clamp(1.5rem, 6vw, 4rem); }
.login-content header { margin-bottom: 2rem; text-align: center; }
.login-content h2 { margin: 0; color: #252d3a; font-size: 1.9rem; }
.login-content header p { margin: .65rem 0 0; color: #6b7280; line-height: 1.5; }
.google-button {
  display: flex;
  min-height: 3.75rem;
  align-items: center;
  justify-content: center;
  gap: .8rem;
  border: 2px solid #d1d5db;
  border-radius: .65rem;
  color: #303846;
  font-weight: 650;
  text-decoration: none;
  transition: border-color .18s, background .18s;
}
.google-button:hover { border-color: #4285f4; background: #4285f410; }
.google-button:focus-visible { outline: 3px solid #5268b4; outline-offset: 3px; }
.google-button svg { width: 1.55rem; height: 1.55rem; }
.account-note { margin: 1.5rem 0 0; color: #626c7c; font-size: .9rem; line-height: 1.55; }
.notice { margin: 0 0 1rem; padding: .85rem 1rem; border: 1px solid #e7cf99; border-radius: .6rem; background: #fff8e8; color: #694d13; line-height: 1.5; }
.login-content footer { margin-top: 2.5rem; color: #9aa1ad; font-size: .8rem; text-align: center; }
@media (min-width: 720px) { .login-card { grid-template-columns: 1fr 1fr; } .brand-panel { display: flex; } }
</style>
