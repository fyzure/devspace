export function isOpenAIWebSandboxHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "web-sandbox.oaiusercontent.com"
    || normalized.endsWith(".web-sandbox.oaiusercontent.com");
}

export function isChatGPTHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "chatgpt.com"
    || normalized.endsWith(".chatgpt.com")
    || isOpenAIWebSandboxHost(normalized);
}
