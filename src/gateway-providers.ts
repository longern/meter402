type GatewayProviderRoute = {
  publicPrefix: string;
  gatewayProvider: string;
  label: string;
  sdk: string;
};

export const GATEWAY_PROVIDER_ROUTES: GatewayProviderRoute[] = [
  {
    publicPrefix: "/v1",
    gatewayProvider: "openai",
    label: "OpenAI",
    sdk: "OpenAI SDK",
  },
  {
    publicPrefix: "/compat",
    gatewayProvider: "compat",
    label: "Unified compat",
    sdk: "OpenAI-compatible",
  },
  {
    publicPrefix: "/anthropic",
    gatewayProvider: "anthropic",
    label: "Anthropic",
    sdk: "Anthropic SDK",
  },
  {
    publicPrefix: "/google-ai-studio",
    gatewayProvider: "google-ai-studio",
    label: "Google AI Studio",
    sdk: "@google/genai",
  },
  {
    publicPrefix: "/openrouter",
    gatewayProvider: "openrouter",
    label: "OpenRouter",
    sdk: "OpenAI SDK",
  },
  {
    publicPrefix: "/mistral",
    gatewayProvider: "mistral",
    label: "Mistral AI",
    sdk: "Mistral SDK",
  },
  {
    publicPrefix: "/groq",
    gatewayProvider: "groq",
    label: "Groq",
    sdk: "OpenAI-compatible",
  },
  {
    publicPrefix: "/deepseek",
    gatewayProvider: "deepseek",
    label: "DeepSeek",
    sdk: "OpenAI-compatible",
  },
  {
    publicPrefix: "/perplexity",
    gatewayProvider: "perplexity",
    label: "Perplexity",
    sdk: "OpenAI-compatible",
  },
  {
    publicPrefix: "/grok",
    gatewayProvider: "grok",
    label: "xAI",
    sdk: "OpenAI-compatible",
  },
  {
    publicPrefix: "/workers-ai",
    gatewayProvider: "workers-ai",
    label: "Workers AI",
    sdk: "Workers AI REST",
  },
  {
    publicPrefix: "/azure-openai",
    gatewayProvider: "azure-openai",
    label: "Azure OpenAI",
    sdk: "Azure OpenAI",
  },
  {
    publicPrefix: "/cohere",
    gatewayProvider: "cohere",
    label: "Cohere",
    sdk: "Cohere SDK",
  },
  {
    publicPrefix: "/replicate",
    gatewayProvider: "replicate",
    label: "Replicate",
    sdk: "Replicate API",
  },
  {
    publicPrefix: "/huggingface",
    gatewayProvider: "huggingface",
    label: "Hugging Face",
    sdk: "Hugging Face API",
  },
];

export const DEFAULT_GATEWAY_PROVIDER = "openai";
