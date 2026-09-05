# Conduit — Android Client

Drop [`ProxyAiClient.kt`](ProxyAiClient.kt) into your project to connect your Android app to your Cloudflare AI proxy.

Your app only ever knows your **Worker URL** and an optional lightweight **proxy key** — no AI provider credentials are bundled in the APK.

---

## 1. Add dependencies

In `app/build.gradle.kts`:

```kotlin
plugins {
    kotlin("plugin.serialization") version "2.0.0"
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
```

---

## 2. Store credentials outside source control

In `local.properties` (already git-ignored by default):

```properties
proxyBaseUrl=https://<your-worker>.<your-subdomain>.workers.dev
proxyApiKey=your-proxy-key
```

Expose them via `BuildConfig` in `app/build.gradle.kts`:

```kotlin
android {
    buildFeatures { buildConfig = true }

    defaultConfig {
        val props = java.util.Properties().apply {
            load(rootProject.file("local.properties").inputStream())
        }
        buildConfigField("String", "PROXY_BASE_URL", "\"${props["proxyBaseUrl"]}\"")
        buildConfigField("String", "PROXY_API_KEY",  "\"${props["proxyApiKey"] ?: ""}\"")
    }
}
```

> `proxyApiKey` can be left empty if you did not set `PROXY_API_KEY` on the Worker.

---

## 3. Copy the client

Copy [`ProxyAiClient.kt`](ProxyAiClient.kt) into your project and update the package declaration at the top to match your own package name.

---

## 4. Initialize

```kotlin
val aiClient = ProxyAiClient(
    baseUrl     = BuildConfig.PROXY_BASE_URL,
    proxyApiKey = BuildConfig.PROXY_API_KEY.takeIf { it.isNotEmpty() }
)
```

---

## 5. Usage

### Non-streaming

```kotlin
val response = aiClient.chatCompletion(
    messages = listOf(
        ChatMessage("system", "You are a helpful assistant."),
        ChatMessage("user",   "What is Kotlin?")
    )
    // model omitted → Worker uses its MODEL environment variable
)
println(response.choices.first().message?.content)
```

### Streaming (recommended for better UX)

```kotlin
aiClient.chatCompletionStream(
    messages = listOf(ChatMessage("user", "Tell me a joke"))
).collect { delta ->
    print(delta) // token by token as it arrives
}
```

### Jetpack Compose ViewModel

```kotlin
class ChatViewModel(
    private val ai: ProxyAiClient = ProxyAiClient(
        baseUrl     = BuildConfig.PROXY_BASE_URL,
        proxyApiKey = BuildConfig.PROXY_API_KEY.takeIf { it.isNotEmpty() }
    )
) : ViewModel() {

    var messages      by mutableStateOf(listOf<ChatMessage>())
    var streamingText by mutableStateOf("")
    var isLoading     by mutableStateOf(false)

    fun send(prompt: String) {
        val history = messages + ChatMessage("user", prompt)
        messages  = history
        isLoading = true
        streamingText = ""

        viewModelScope.launch {
            try {
                var full = ""
                ai.chatCompletionStream(messages = history).collect { delta ->
                    full += delta
                    streamingText = full
                }
                messages = history + ChatMessage("assistant", full)
                streamingText = ""
            } catch (e: Exception) {
                messages = history + ChatMessage("assistant", "Error: ${e.message}")
            } finally {
                isLoading = false
            }
        }
    }
}
```

---

## Error handling

`ProxyAiClient` throws `ProxyAiClient.ProxyException(code, body)` on non-2xx responses. Catch it like any other exception:

```kotlin
try {
    val resp = aiClient.chatCompletion(messages = ...)
} catch (e: ProxyAiClient.ProxyException) {
    Log.e("AI", "HTTP ${e.code}: ${e.body}")
}
```
