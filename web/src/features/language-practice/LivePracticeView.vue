<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authSession } from '../../auth-session'
import {
  LanguagePracticeClient,
  LanguagePracticeClientError,
  type SessionDetail,
} from './language-practice-client'
import { anchorTimer, projectRemainingMs, type TimerAnchor } from './live-session-state'

const route = useRoute()
const router = useRouter()
const client = new LanguagePracticeClient(authSession)
const sessionId = computed(() => {
  const value = route.params.sessionId
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
})
const session = ref<SessionDetail | null>(null)
const loading = ref(true)
const refreshing = ref(false)
const error = ref('')
const monotonicNow = ref(0)
const remainingMs = computed(() => anchor ? projectRemainingMs(anchor, monotonicNow.value) : 0)
const remainingSeconds = computed(() => Math.ceil(remainingMs.value / 1000))
let anchor: TimerAnchor | null = null
let timer: ReturnType<typeof setInterval> | null = null
let disposed = false
let requestInFlight = false
let expiryCheckRequested = false
let navigatingToCompletion = false

const topicLabels: Record<string, string> = {
  travel: 'Travel', work: 'Work', studies: 'Studies', 'everyday-conversation': 'Everyday conversation',
}

function updateClock(): void {
  monotonicNow.value = performance.now()
  if (session.value?.status === 'ACTIVE' && remainingMs.value === 0 && !expiryCheckRequested) {
    expiryCheckRequested = true
    void loadSession()
  }
}

async function loadSession(): Promise<void> {
  if (disposed || requestInFlight) return
  requestInFlight = true
  refreshing.value = true
  if (!session.value) loading.value = true
  error.value = ''
  const requestedSessionId = sessionId.value
  try {
    const snapshot = await client.getSession(requestedSessionId)
    if (disposed || requestedSessionId !== sessionId.value) return
    session.value = snapshot
    monotonicNow.value = performance.now()
    anchor = anchorTimer(snapshot.remainingMs, monotonicNow.value)
    expiryCheckRequested = snapshot.status !== 'ACTIVE' || snapshot.remainingMs === 0
    if (snapshot.status === 'EXPIRED' || snapshot.status === 'COMPLETED') {
      await navigateToCompletion(requestedSessionId)
    }
  } catch (cause) {
    if (!disposed && requestedSessionId === sessionId.value) {
      error.value = cause instanceof LanguagePracticeClientError && cause.kind === 'not-found'
        ? 'This practice session could not be found.'
        : 'The session could not be refreshed. Your saved session remains unchanged.'
    }
  } finally {
    requestInFlight = false
    if (!disposed) {
      loading.value = false
      refreshing.value = false
      if (requestedSessionId !== sessionId.value) void loadSession()
    }
  }
}

async function navigateToCompletion(id: string): Promise<void> {
  if (navigatingToCompletion || disposed) return
  navigatingToCompletion = true
  await router.replace(`/language-practice/sessions/${id}/complete`)
}

function refreshOnFocus(): void { void loadSession() }
function refreshWhenVisible(): void {
  if (document.visibilityState === 'visible') void loadSession()
}

watch(sessionId, (id) => {
  session.value = null
  anchor = null
  error.value = ''
  loading.value = true
  expiryCheckRequested = false
  navigatingToCompletion = false
  if (id) void loadSession()
}, { immediate: true })

onMounted(() => {
  monotonicNow.value = performance.now()
  timer = setInterval(updateClock, 250)
  window.addEventListener('focus', refreshOnFocus)
  document.addEventListener('visibilitychange', refreshWhenVisible)
})

onBeforeUnmount(() => {
  disposed = true
  if (timer !== null) clearInterval(timer)
  window.removeEventListener('focus', refreshOnFocus)
  document.removeEventListener('visibilitychange', refreshWhenVisible)
})
</script>

<template>
  <main class="session-shell" aria-labelledby="session-title">
    <header class="session-heading">
      <div>
        <p class="eyebrow">Timed English practice</p>
        <h1 id="session-title">Your conversation</h1>
      </div>
      <div v-if="session" class="timer" role="timer" aria-label="Time remaining">
        {{ Math.floor(remainingSeconds / 60) }}:{{ String(remainingSeconds % 60).padStart(2, '0') }}
      </div>
    </header>

    <p v-if="loading" class="feedback" role="status">Loading your practice session…</p>
    <section v-else-if="!session" class="feedback error" role="alert">
      <h2>Practice session unavailable</h2>
      <p>{{ error || 'This practice session could not be loaded.' }}</p>
      <RouterLink to="/language-practice" class="action-link">Return to setup</RouterLink>
    </section>
    <template v-else>
      <section class="session-facts" aria-label="Session details">
        <p><strong>Level</strong><span>{{ session.level }}</span></p>
        <p><strong>Topic</strong><span>{{ topicLabels[session.topic] || session.topic }}</span></p>
        <p><strong>Duration</strong><span>{{ session.durationMinutes }} minutes</span></p>
      </section>

      <section class="conversation" aria-labelledby="conversation-title">
        <h2 id="conversation-title">Conversation so far</h2>
        <p v-if="session.turns.length === 0" class="empty-state">Your completed conversation turns will appear here.</p>
        <ol v-else class="turn-list">
          <li v-for="turn in session.turns" :key="turn.sequence" class="turn-card">
            <p class="turn-number">Turn {{ turn.sequence }}</p>
            <p><strong>You</strong><span>{{ turn.transcript || 'No transcript was saved for this turn.' }}</span></p>
            <p><strong>Conversation partner</strong><span>{{ turn.assistantResponse || 'No response text was saved for this turn.' }}</span></p>
          </li>
        </ol>
      </section>

      <section class="turn-notice" role="status">
        <h2>Voice turn controls are connecting</h2>
        <p>This step shows saved session details only. Recording and conversation responses are not available in this slice.</p>
      </section>
      <p v-if="remainingMs === 0 && session.status === 'ACTIVE'" class="feedback" role="status">
        Time is up. Checking the session status before opening its report…
      </p>
      <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
      <button type="button" class="refresh-button" :disabled="refreshing" @click="loadSession">
        {{ refreshing ? 'Refreshing…' : 'Refresh session' }}
      </button>
    </template>
  </main>
</template>

<style scoped>
.session-shell { width: min(100% - 2rem, 850px); margin: 0 auto; padding: clamp(2rem, 8vh, 5rem) 0; }
.session-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
.eyebrow { margin: 0 0 .5rem; color: #5268b4; font-size: .78rem; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 0; color: #202b40; font-size: clamp(2rem, 6vw, 3rem); letter-spacing: -.04em; }
h2 { margin: 0; color: #263247; font-size: 1.2rem; }
.timer { padding: .55rem .8rem; border-radius: .6rem; background: #e9edfa; color: #233a83; font-size: 1.35rem; font-variant-numeric: tabular-nums; font-weight: 750; }
.feedback, .conversation, .turn-notice { padding: clamp(1.2rem, 4vw, 1.8rem); border: 1px solid #d7deed; border-radius: .9rem; background: #fff; }
.feedback { color: #536078; line-height: 1.5; }
.feedback.error { border-color: #e7c7c7; background: #fff7f7; color: #842d2d; }
.feedback p { margin: .5rem 0 0; }
.session-facts { display: flex; flex-wrap: wrap; gap: .7rem; margin-bottom: 1rem; }
.session-facts p { display: grid; gap: .2rem; min-width: 7rem; margin: 0; padding: .75rem 1rem; border: 1px solid #d7deed; border-radius: .65rem; color: #536078; }
.session-facts strong { color: #263247; font-size: .82rem; }
.conversation { margin-top: 1rem; }
.empty-state { margin: 1rem 0 0; color: #68748a; }
.turn-list { display: grid; gap: .8rem; margin: 1rem 0 0; padding: 0; list-style: none; }
.turn-card { padding: 1rem; border-radius: .65rem; background: #f5f7fb; }
.turn-card p { display: grid; gap: .25rem; margin: .75rem 0 0; color: #36445d; line-height: 1.5; overflow-wrap: anywhere; }
.turn-card .turn-number { margin-top: 0; color: #5268b4; font-size: .82rem; font-weight: 700; }
.turn-notice { margin-top: 1rem; border-left: 4px solid #a77b28; background: #fff9ec; color: #59461f; }
.turn-notice p { margin: .45rem 0 0; line-height: 1.5; }
.action-link, .refresh-button { display: inline-flex; min-height: 2.75rem; align-items: center; justify-content: center; margin-top: 1rem; padding: .6rem 1rem; border: 1px solid #c5cee0; border-radius: .55rem; background: white; color: #243452; font: inherit; font-weight: 650; text-decoration: none; cursor: pointer; }
.refresh-button:disabled { cursor: wait; opacity: .6; }
button:focus-visible, a:focus-visible { outline: 3px solid #5268b4; outline-offset: 2px; }
</style>
