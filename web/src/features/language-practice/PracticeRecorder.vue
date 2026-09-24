<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { selectSupportedAudioMimeType } from '../../practice-audio'
import {
  formatRecordingTime,
  isRecorderShortcut,
  isValidRecording,
  MAX_AUDIO_BYTES,
  MAX_RECORDING_MS,
} from './practice-recorder-guards'

const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ recorded: [blob: Blob] }>()

const recording = ref(false)
const starting = ref(false)
const elapsedMs = ref(0)
const error = ref('')
let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let chunks: BlobPart[] = []
let startedAt = 0
let stopRequestedDurationMs: number | null = null
let timer: ReturnType<typeof setInterval> | null = null
let operation = 0
let disposed = false
let finished = false

const elapsedLabel = () => formatRecordingTime(elapsedMs.value)

function clearTimer(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

function releaseResources(stopRecorder: boolean): void {
  clearTimer()
  const currentRecorder = recorder
  recorder = null
  if (stopRecorder && currentRecorder && currentRecorder.state !== 'inactive') {
    try { currentRecorder.stop() } catch { /* Best-effort cleanup. */ }
  }
  const currentStream = stream
  stream = null
  currentStream?.getTracks().forEach((track) => track.stop())
}

function finishRecording(currentOperation: number): void {
  if (finished) return
  finished = true
  const durationMs = stopRequestedDurationMs ?? (startedAt ? performance.now() - startedAt : 0)
  const mimeType = recorder?.mimeType || chunks.find((chunk): chunk is Blob => chunk instanceof Blob && Boolean(chunk.type))?.type || 'application/octet-stream'
  const blob = new Blob(chunks, { type: mimeType })
  chunks = []
  recording.value = false
  elapsedMs.value = Math.min(durationMs, MAX_RECORDING_MS)
  releaseResources(false)
  if (!disposed && currentOperation === operation && isValidRecording(durationMs, blob.size)) {
    emit('recorded', blob)
  } else if (!disposed && currentOperation === operation && durationMs >= 250 && blob.size > MAX_AUDIO_BYTES) {
    error.value = 'Recording could not be completed. Please try again.'
  }
}

function stop(): void {
  if (!recording.value || !recorder || recorder.state === 'inactive') return
  clearTimer()
  stopRequestedDurationMs = performance.now() - startedAt
  try {
    recorder.stop()
  } catch {
    error.value = 'Recording could not be completed. Please try again.'
    releaseResources(false)
    recording.value = false
  }
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
}

function cancel(): void {
  operation++
  starting.value = false
  recording.value = false
  chunks = []
  finished = true
  releaseResources(true)
}

async function start(): Promise<void> {
  if (props.disabled || starting.value || recording.value || disposed) return
  error.value = ''
  elapsedMs.value = 0
  stopRequestedDurationMs = null
  finished = false
  starting.value = true
  const currentOperation = ++operation
  let acquiredStream: MediaStream | null = null
  try {
    const mimeType = selectSupportedAudioMimeType()
    if (!mimeType || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('unavailable')
    }
    acquiredStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    if (disposed || currentOperation !== operation || props.disabled) {
      acquiredStream.getTracks().forEach((track) => track.stop())
      return
    }
    stream = acquiredStream
    const activeRecorder = new MediaRecorder(acquiredStream, { mimeType })
    recorder = activeRecorder
    chunks = []
    activeRecorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (currentOperation === operation && !disposed && !finished && event.data.size > 0) chunks.push(event.data)
    })
    activeRecorder.addEventListener('stop', () => finishRecording(currentOperation), { once: true })
    activeRecorder.addEventListener('error', () => {
      error.value = 'Recording could not be completed. Please try again.'
      cancel()
    }, { once: true })
    activeRecorder.start()
    startedAt = performance.now()
    recording.value = true
    timer = setInterval(() => {
      elapsedMs.value = Math.min(performance.now() - startedAt, MAX_RECORDING_MS)
      if (elapsedMs.value >= MAX_RECORDING_MS - 500) stop()
    }, 100)
  } catch {
    acquiredStream?.getTracks().forEach((track) => track.stop())
    if (!disposed && currentOperation === operation) {
      error.value = 'Microphone unavailable. Check permission and try again.'
    }
  } finally {
    if (!disposed && currentOperation === operation) starting.value = false
  }
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (!isRecorderShortcut(event, props.disabled === true) || starting.value) return
  event.preventDefault()
  if (recording.value) stop()
  else void start()
}

watch(() => props.disabled, (disabled) => {
  if (disabled) cancel()
})

if (typeof window !== 'undefined') window.addEventListener('keydown', onWindowKeydown)
onBeforeUnmount(() => {
  disposed = true
  operation++
  cancel()
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<template>
  <section class="practice-recorder" aria-label="Audio response recorder">
    <button
      v-if="!recording"
      type="button"
      class="recorder-button"
      :disabled="disabled || starting"
      @click="start"
    >
      {{ starting ? 'Starting microphone…' : disabled ? 'Recording unavailable' : 'Start recording' }}
    </button>
    <button v-else type="button" class="recorder-button stop-button" @click="stop">
      Stop recording
    </button>
    <p class="recorder-status" role="status" aria-live="polite">
      {{ recording ? `Recording · ${elapsedLabel()} / 0:20` : starting ? 'Requesting microphone access…' : 'Ready to record' }}
    </p>
    <p v-if="error" class="recorder-error" role="alert">{{ error }}</p>
    <p class="recorder-hint">Use the buttons or press Space when no form control is focused. Maximum 20 seconds.</p>
  </section>
</template>

<style scoped>
.practice-recorder { display: grid; justify-items: center; gap: .65rem; text-align: center; }
.recorder-button { min-height: 3rem; padding: .7rem 1.25rem; border: 0; border-radius: .6rem; background: #233a83; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
.recorder-button:disabled { cursor: not-allowed; opacity: .6; }
.stop-button { background: #a32929; }
.recorder-button:focus-visible { outline: 3px solid #5268b4; outline-offset: 3px; }
.recorder-status, .recorder-hint, .recorder-error { margin: 0; }
.recorder-status { color: #36445d; font-variant-numeric: tabular-nums; }
.recorder-hint { color: #68748a; font-size: .875rem; }
.recorder-error { color: #842d2d; }
</style>
