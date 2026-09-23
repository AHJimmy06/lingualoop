<template>
  <main class="shell">
    <p class="eyebrow">Language practice</p>
    <h1>LinguaLoop</h1>
    <p class="intro">
      A fresh space for building confidence in another language, one conversation
      at a time.
    </p>
    <p class="status">Independent application scaffold</p>
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

.status {
  width: fit-content;
  margin-top: 1.5rem;
  padding: 0.6rem 0.85rem;
  border: 1px solid #d7deed;
  border-radius: 999px;
  color: #465575;
  font-size: 0.9rem;
}
</style>
