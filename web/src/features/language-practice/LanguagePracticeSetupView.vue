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
        <p v-if="creationError" class="feedback error" role="alert">{{ creationError }}</p>
        <button type="button" class="start-button" :disabled="creating || !canStart" @click="startPractice">
          {{ creating ? 'Starting practice…' : 'Start practice' }}
        </button>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { authSession } from '../../auth-session'
import { fetchPracticeOptions, type PracticeOptions } from './practice-options'
import { LanguagePracticeClient } from './language-practice-client'

const router = useRouter()
const options = ref<PracticeOptions | null>(null)
const loading = ref(true)
const error = ref('')
const level = ref('')
const topic = ref('')
const duration = ref<number | null>(null)
const loggingOut = ref(false)
const creating = ref(false)
const creationError = ref('')
const client = new LanguagePracticeClient(authSession)
const canStart = computed(() => Boolean(options.value &&
  options.value.levels.includes(level.value) &&
  options.value.topics.some((item) => item.code === topic.value) &&
  options.value.durationsMinutes.includes(duration.value ?? 0)))

async function startPractice(): Promise<void> {
  if (creating.value || !options.value || !canStart.value) return
  creating.value = true
  creationError.value = ''
  try {
    const created = await client.createSession({
      level: level.value as 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2',
      topic: topic.value as 'travel' | 'work' | 'studies' | 'everyday-conversation',
      durationMinutes: duration.value as 5 | 10 | 15,
    })
    await router.push(`/language-practice/sessions/${created.id}`)
  } catch {
    creationError.value = 'Practice could not be started. No session was confirmed; please try again.'
  } finally {
    creating.value = false
  }
}

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
.start-button { min-height: 3rem; padding: .65rem 1rem; border: 0; border-radius: .55rem; background: #233a83; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
.start-button:disabled { cursor: wait; opacity: .6; }
@media (max-width: 520px) { .page-heading { flex-direction: column; } }
</style>
