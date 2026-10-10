<script setup lang="ts">
import { ref } from "vue";
import { DeweeChat } from "dewee-webchat/vue";

type Theme = "light" | "dark" | "auto";
/** Methods the DeweeChat component exposes on its template ref. */
interface DeweeChatApi {
  open(): void;
  close(): void;
  send(text: string): Promise<void> | undefined;
  newConversation(): void;
}

const SAMPLE_QUESTION = "Đọc https://dewee.sh và tóm tắt 1 câu.";
const SUGGESTIONS = ["What is Dewee?", "How do I add this chat to my Vue app?", SAMPLE_QUESTION];
const REPO_URL = "https://github.com/nextlevelbuilder/dewee-webchat/tree/main/examples/vue-vite";

const SNIPPET = `// worker/index.ts — the gateway token never leaves the Worker
import { createDeweeHandler, optionsFromEnv } from "dewee-webchat/server";

let dewee;
export default {
  fetch(req, env) {
    if (new URL(req.url).pathname.startsWith("/api/dewee/"))
      return (dewee ??= createDeweeHandler(optionsFromEnv(env)))(req);
    return env.ASSETS.fetch(req);
  },
};

<!-- App.vue -->
<script setup>
import { DeweeChat } from "dewee-webchat/vue";
const chat = ref(); // chat.value.open() / .send("Hello!") / .newConversation()
</` + `script>

<DeweeChat ref="chat" endpoint="/api/dewee" :theme="theme"
  :show-reasoning="reasoning" :show-tool-calls="toolCalls"
  :suggestions="['What is Dewee?']" @reply="(d) => console.log(d)" />`;

const chat = ref<DeweeChatApi | null>(null);
const showReasoning = ref(true);
const showToolCalls = ref(true);
const theme = ref<Theme>("auto");
const status = ref("none yet (the widget loads when first opened)");

function onError(detail: { message?: string } | undefined) {
  status.value = `error: ${detail?.message ?? "unknown"}`;
}
</script>

<template>
  <main>
    <span class="eyebrow">Example · Vite + Cloudflare Workers</span>
    <h1>Vue <span>+</span> dewee-webchat</h1>
    <p>
      A Dewee AI agent chat embedded in a Vue app with the <code>DeweeChat</code> component. A Cloudflare Worker serves
      this page as static assets and runs the chat backend under <code>/api/dewee</code>, so the gateway token never
      reaches the browser.
    </p>
    <p>Change the controls below and the floating widget updates live — props flow straight into the element.</p>
    <div class="links">
      <a href="https://webchat.dewee.sh">dewee-webchat docs →</a>
      <a :href="REPO_URL">Source on GitHub →</a>
    </div>

    <h2>Live props</h2>
    <div class="controls">
      <label><input v-model="showReasoning" type="checkbox" /> showReasoning</label>
      <label><input v-model="showToolCalls" type="checkbox" /> showToolCalls</label>
      <label>
        theme
        <select v-model="theme">
          <option value="auto">auto</option>
          <option value="light">light</option>
          <option value="dark">dark</option>
        </select>
      </label>
    </div>
    <div class="buttons">
      <button type="button" @click="chat?.open()">Open chat</button>
      <button type="button" class="primary" @click="chat?.send(SAMPLE_QUESTION)">Ask: “{{ SAMPLE_QUESTION }}”</button>
      <button type="button" @click="chat?.newConversation()">New conversation</button>
    </div>
    <p class="status">Last event: <code>{{ status }}</code></p>

    <h2>Integration</h2>
    <pre><code>{{ SNIPPET }}</code></pre>

    <footer>
      Built with <a href="https://webchat.dewee.sh">dewee-webchat</a> · Vue 3 · Vite · Cloudflare Workers
    </footer>

    <DeweeChat
      ref="chat"
      endpoint="/api/dewee"
      title="Dewee assistant"
      subtitle="Vue example"
      greeting="Hi there 👋"
      intro="Ask about Dewee, or how this Vue example is wired up."
      :suggestions="SUGGESTIONS"
      accent-color="#5446e8"
      :theme="theme"
      :show-reasoning="showReasoning"
      :show-tool-calls="showToolCalls"
      @ready="status = 'ready'"
      @open="status = 'open'"
      @close="status = 'close'"
      @send="status = 'send'"
      @reply="status = 'reply'"
      @error="onError"
    />
  </main>
</template>
