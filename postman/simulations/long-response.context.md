# Long response dependency verification
Local-only simulation of the existing STT HTTP contract (not proof of speech recognition quality). No cloud mock lookup or publish; local mock derived from the API consumer contract.
Run `postman simulation run postman/simulations/long-response.sim.yaml --port 4919 --no-history --output ndjson`, then `node --test api/test/language-practice/long-response-simulation.spec.cjs` with LINGUALOOP_TEST_STT_SIM_URL=http://127.0.0.1:4919/stt.
The test exercises the real PracticeRuntimeHost HTTP client and verifies >4,000 recognized characters are retained. No model is loaded and no OpenAI call is made.
