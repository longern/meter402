export const GATEWAY_PROVIDERS = [
  { path: "/v1", label: "OpenAI", sdk: "OpenAI SDK" },
  { path: "/compat", label: "Unified compat", sdk: "OpenAI-compatible" },
  { path: "/anthropic", label: "Anthropic", sdk: "Anthropic SDK" },
  { path: "/google-ai-studio", label: "Google AI Studio", sdk: "@google/genai" },
  { path: "/openrouter", label: "OpenRouter", sdk: "OpenAI SDK" },
  { path: "/mistral", label: "Mistral AI", sdk: "Mistral SDK" },
  { path: "/groq", label: "Groq", sdk: "OpenAI-compatible" },
  { path: "/deepseek", label: "DeepSeek", sdk: "OpenAI-compatible" },
  { path: "/perplexity", label: "Perplexity", sdk: "OpenAI-compatible" },
  { path: "/grok", label: "xAI", sdk: "OpenAI-compatible" },
  { path: "/workers-ai", label: "Workers AI", sdk: "Workers AI REST" },
  { path: "/azure-openai", label: "Azure OpenAI", sdk: "Azure OpenAI" },
  { path: "/cohere", label: "Cohere", sdk: "Cohere SDK" },
  { path: "/replicate", label: "Replicate", sdk: "Replicate API" },
  { path: "/huggingface", label: "Hugging Face", sdk: "Hugging Face API" },
];

export function providerUrl(path) {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}
