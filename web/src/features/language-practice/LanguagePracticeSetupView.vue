<template>
  <main class="setup-shell">
    <header class="page-heading">
      <div>
        <p class="eyebrow">Your learning space</p>
        <h1>Language Practice</h1>
        <p>Choose the level, topic, and time for a guided English conversation.</p>
      </div>
      <button type="button" class="logout-button" :disabled="loggingOut" @click="logout">
        {{ loggingOut ? 'Signing out…' : 'Log out' }}
      </button>
    </header>

    <section class="setup-card" aria-labelledby="setup-title">
      <div class="card-heading">
        <span class="step-mark" aria-hidden="true">1</span>
        <div>
          <h2 id="setup-title">Set up your practice</h2>
          <p>These options come from the LinguaLoop practice service.</p>
        </div>
      </div>

      <p v-if="loading" class="feedback" role="status">Loading available practice options…</p>
      <div v-else-if="error" class="feedback error" role="alert">
        <p>{{ error }}</p>
        <button type="button" class="secondary-button" @click="loadOptions">Try again</button>
      </div>
      <div v-else-if="options" class="setup-fields">
        <label>
          <span>English level</span>
          <select v-model="level">
            <option v-for="item in options.levels" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label>
          <span>Conversation topic</span>
          <select v-model="topic">
            <option v-for="item in options.topics" :key="item.code" :value="item.code">{{ item.label }}</option>
          </select>
        </label>
        <label>
          <span>Practice duration</span>
          <select v-model.number="duration">
            <option v-for="item in options.durationsMinutes" :key="item" :value="item">{{ item }} minutes</option>
          </select>
        </label>
        <aside class="unavailable" role="note">
          <strong>Session creation is not available yet.</strong>
          <p>Your selections are ready, but the conversation turn flow is still being built. No session will be created from this page.</p>
        </aside>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { authSession } from '../../auth-session'
import { fetchPracticeOptions, type PracticeOptions } from './practice-options'

const router = useRouter()
const options = ref<PracticeOptions | null>(null)
const loading = ref(true)
const error = ref('')
const level = ref('')
const topic = ref('')
const duration = ref<number | null>(null)
const loggingOut = ref(false)

async function loadOptions(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    options.value = await fetchPracticeOptions(authSession)
    level.value ||= options.value.levels[0] ?? ''
    topic.value ||= options.value.topics[0]?.code ?? ''
    duration.value ??= options.value.durationsMinutes[0] ?? null
  } catch {
    options.value = null
    error.value = 'Practice options could not be loaded. Your setup has not been saved.'
  } finally {
    loading.value = false
  }
}

async function logout(): Promise<void> {
  if (loggingOut.value) return
  loggingOut.value = true
  const revoked = await authSession.logout()
  authSession.clearLocal()
  options.value = null
  level.value = ''
  topic.value = ''
  duration.value = null
  await router.replace({ name: 'login', query: revoked ? undefined : { logout: 'unconfirmed' } })
}

onMounted(() => { void loadOptions() })
</script>

<style scoped>
.setup-shell { width: min(100% - 2rem, 850px); margin: 0 auto; padding: clamp(2rem, 8vh, 5rem) 0; }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.5rem; margin-bottom: 2rem; }
.eyebrow { margin: 0 0 .55rem; color: #5268b4; font-size: .78rem; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 0; color: #202b40; font-size: clamp(2rem, 6vw, 3.2rem); letter-spacing: -.045em; }
.page-heading p:not(.eyebrow) { max-width: 36rem; margin: .8rem 0 0; color: #536078; line-height: 1.6; }
.logout-button, .secondary-button { min-height: 2.75rem; padding: .6rem 1rem; border: 1px solid #c5cee0; border-radius: .55rem; background: white; color: #243452; font-weight: 650; cursor: pointer; }
.logout-button:disabled { cursor: wait; opacity: .6; }
.setup-card { padding: clamp(1.25rem, 4vw, 2rem); border: 1px solid #d7deed; border-radius: 1rem; background: #fff; box-shadow: 0 .75rem 2rem rgb(24 36 58 / 6%); }
.card-heading { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.7rem; }
.step-mark { display: grid; width: 2.6rem; height: 2.6rem; flex: 0 0 auto; place-items: center; border-radius: 50%; background: #e9edfa; color: #233a83; font-weight: 750; }
h2 { margin: 0; color: #263247; font-size: 1.25rem; }
.card-heading p { margin: .35rem 0 0; color: #68748a; font-size: .92rem; }
.setup-fields { display: grid; gap: 1.15rem; }
.setup-fields label { display: grid; gap: .5rem; color: #36445d; font-size: .94rem; font-weight: 650; }
select { width: 100%; min-height: 3rem; padding: .6rem .8rem; border: 1px solid #c5cee0; border-radius: .5rem; background: white; color: #243452; }
select:focus-visible, button:focus-visible { outline: 3px solid #5268b4; outline-offset: 2px; }
.feedback { padding: 1.25rem; border-radius: .65rem; background: #f5f7fb; color: #536078; line-height: 1.5; }
.feedback.error { border: 1px solid #e7c7c7; background: #fff7f7; color: #842d2d; }
.feedback.error p { margin: 0 0 1rem; }
.unavailable { margin-top: .35rem; padding: 1rem 1.1rem; border-left: 4px solid #a77b28; border-radius: .3rem; background: #fff9ec; color: #59461f; line-height: 1.5; }
.unavailable p { margin: .35rem 0 0; }
@media (max-width: 520px) { .page-heading { flex-direction: column; } }
</style>
