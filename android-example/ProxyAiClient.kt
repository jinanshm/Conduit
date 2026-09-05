package com.example.conduit

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Simple client for your Cloudflare proxy.
 *
 * Your Android app NEVER holds the provider key.
 * It only knows your Worker URL + optional PROXY_API_KEY.
 *
 * Compatible with any OpenAI-compatible proxy (Nvidia NIM, OpenRouter, etc.)
 *
 * Usage:
 *   val client = ProxyAiClient(
 *       baseUrl = "https://conduit.your-subdomain.workers.dev",
 *       proxyApiKey = BuildConfig.PROXY_API_KEY // or null if proxy is open
 *   )
 *   // Non-streaming
 *   val resp = client.chatCompletion(
 *       model = "meta/llama-3.1-70b-instruct",
 *       messages = listOf(ChatMessage("user", "Hello!"))
 *   )
 *   // Streaming
 *   client.chatCompletionStream(...).collect { chunk -> ... }
 */

// --- Models (OpenAI-compatible) ---

@Serializable
data class ChatMessage(
    val role: String, // "system" | "user" | "assistant"
    val content: String
)

@Serializable
data class ChatRequest(
    val model: String? = null,
    val messages: List<ChatMessage>,
    val stream: Boolean = false,
    val temperature: Double? = 0.7,
    val max_tokens: Int? = null,
    val top_p: Double? = null,
)

@Serializable
data class ChatChoice(
    val index: Int,
    val message: ChatMessage? = null,
    val delta: ChatMessage? = null, // for streaming
    val finish_reason: String? = null
)

@Serializable
data class ChatUsage(
    val prompt_tokens: Int? = null,
    val completion_tokens: Int? = null,
    val total_tokens: Int? = null
)

@Serializable
data class ChatResponse(
    val id: String,
    val `object`: String,
    val created: Long,
    val model: String,
    val choices: List<ChatChoice>,
    val usage: ChatUsage? = null
)

@Serializable
data class ChatStreamChunk(
    val id: String? = null,
    val choices: List<ChatChoice>,
)

class ProxyAiClient(
    private val baseUrl: String, // e.g. https://conduit.your-subdomain.workers.dev  (no trailing slash)
    private val proxyApiKey: String? = null,
    private val timeoutSeconds: Long = 60
) {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        isLenient = true
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(timeoutSeconds, TimeUnit.SECONDS)
        .readTimeout(timeoutSeconds, TimeUnit.SECONDS)
        .writeTimeout(timeoutSeconds, TimeUnit.SECONDS)
        .build()

    /**
     * Non-streaming chat completion. Mirrors OpenAI POST /v1/chat/completions
     */
    suspend fun chatCompletion(
        model: String? = null,
        messages: List<ChatMessage>,
        temperature: Double = 0.7,
        maxTokens: Int? = null,
    ): ChatResponse {
        val reqBody = ChatRequest(
            model = model,
            messages = messages,
            stream = false,
            temperature = temperature,
            max_tokens = maxTokens
        )
        val bodyStr = json.encodeToString(ChatRequest.serializer(), reqBody)
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/v1/chat/completions")
            .post(bodyStr.toRequestBody("application/json".toMediaType()))
            .apply { addAuthHeader(this) }
            .build()

        http.newCall(request).execute().use { resp ->
            val raw = resp.body?.string() ?: ""
            if (!resp.isSuccessful) {
                throw ProxyException(resp.code, raw)
            }
            return json.decodeFromString(ChatResponse.serializer(), raw)
        }
    }

    /**
     * Streaming chat completion. Emits deltas as they arrive (SSE).
     * Usage: client.chatCompletionStream(...).collect { deltaText -> }
     */
    fun chatCompletionStream(
        model: String? = null,
        messages: List<ChatMessage>,
        temperature: Double = 0.7,
        maxTokens: Int? = null,
    ): Flow<String> = flow {
        val reqBody = ChatRequest(
            model = model,
            messages = messages,
            stream = true,
            temperature = temperature,
            max_tokens = maxTokens
        )
        val bodyStr = json.encodeToString(ChatRequest.serializer(), reqBody)
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/v1/chat/completions")
            .post(bodyStr.toRequestBody("application/json".toMediaType()))
            .apply { addAuthHeader(this) }
            .header("Accept", "text/event-stream")
            .build()

        http.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) {
                val err = resp.body?.string() ?: ""
                throw ProxyException(resp.code, err)
            }
            val source = resp.body?.source() ?: return@use
            // Read SSE line by line
            while (!source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                if (line.startsWith("data: ")) {
                    val data = line.removePrefix("data: ").trim()
                    if (data == "[DONE]") break
                    if (data.isEmpty()) continue
                    try {
                        val chunk = json.decodeFromString(ChatStreamChunk.serializer(), data)
                        val delta = chunk.choices.firstOrNull()?.delta?.content
                        if (!delta.isNullOrEmpty()) emit(delta)
                    } catch (_: Exception) {
                        // skip malformed chunk
                    }
                }
            }
        }
    }.flowOn(Dispatchers.IO)

    private fun addAuthHeader(builder: Request.Builder) {
        if (!proxyApiKey.isNullOrBlank()) {
            builder.header("Authorization", "Bearer $proxyApiKey")
        }
        builder.header("Content-Type", "application/json")
    }

    class ProxyException(val code: Int, val body: String) :
        Exception("Proxy error $code: $body")
}

// --- Jetpack Compose ViewModel example ---

/*
import androidx.compose.runtime.*
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch

class ChatViewModel(
    private val ai: ProxyAiClient = ProxyAiClient(
        baseUrl = "https://conduit.your-subdomain.workers.dev",
        proxyApiKey = null // or BuildConfig.PROXY_API_KEY if you set PROXY_API_KEY on Worker
    )
) : ViewModel() {
    var messages by mutableStateOf(listOf<ChatMessage>())
    var streamingText by mutableStateOf("")
    var isLoading by mutableStateOf(false)

    fun send(prompt: String, model: String = "meta/llama-3.1-70b-instruct") {
        val newMessages = messages + ChatMessage("user", prompt)
        messages = newMessages
        isLoading = true
        streamingText = ""

        viewModelScope.launch {
            try {
                // Option 1: non-streaming
                // val resp = ai.chatCompletion(model, newMessages)
                // messages = newMessages + (resp.choices.firstOrNull()?.message ?: ChatMessage("assistant",""))

                // Option 2: streaming (better UX)
                var full = ""
                ai.chatCompletionStream(model, newMessages).collect { delta ->
                    full += delta
                    streamingText = full
                }
                messages = newMessages + ChatMessage("assistant", full)
                streamingText = ""
            } catch (e: Exception) {
                messages = newMessages + ChatMessage("assistant", "Error: ${e.message}")
            } finally {
                isLoading = false
            }
        }
    }
}

// Compose UI snippet:
// @Composable
// fun ChatScreen(vm: ChatViewModel = viewModel()) {
//     var input by remember { mutableStateOf("") }
//     Column {
//         LazyColumn { items(vm.messages) { Text("${it.role}: ${it.content}") } }
//         if (vm.streamingText.isNotEmpty()) Text(vm.streamingText)
//         Row {
//             TextField(value = input, onValueChange = { input = it })
//             Button(onClick = { vm.send(input); input = "" }, enabled = !vm.isLoading) { Text("Send") }
//         }
//     }
// }
*/
