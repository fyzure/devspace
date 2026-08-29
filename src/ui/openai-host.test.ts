import assert from "node:assert/strict";
import { isChatGPTHost, isOpenAIWebSandboxHost } from "./openai-host.js";

assert.equal(isOpenAIWebSandboxHost("web-sandbox.oaiusercontent.com"), true);
assert.equal(
  isOpenAIWebSandboxHost("dev-rs-fyzure-fyi.web-sandbox.oaiusercontent.com"),
  true,
);
assert.equal(isOpenAIWebSandboxHost("example.oaiusercontent.com"), false);

assert.equal(isChatGPTHost("chatgpt.com"), true);
assert.equal(isChatGPTHost("foo.chatgpt.com"), true);
assert.equal(
  isChatGPTHost("dev-rs-fyzure-fyi.web-sandbox.oaiusercontent.com"),
  true,
);
assert.equal(isChatGPTHost("example.com"), false);
