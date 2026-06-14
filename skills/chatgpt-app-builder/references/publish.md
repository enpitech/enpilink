# Publish to Directories

## 1. Audit Annotations

**Common cause of rejection.** Ensure all tools and views have correct annotations. See [fetch-and-render-data.md](fetch-and-render-data.md).

## 2. Audit CSP

Ensure all external domains are declared in the tool's `view.csp`. See [csp.md](csp.md).

## 3. Submit

### ChatGPT
Guide user to submit the app at [platform.openai.com](https://platform.openai.com) → Apps.

OpenAI verifies app ownership via `/.well-known/openai-apps-challenge`. Serve the verification token OpenAI gives you at that path from your own server — e.g. register an Express route on `server.express` that responds with the token (enpilink exposes the underlying Express app; see [registerTool / mcp-server](https://docs.enpitech.dev/api-reference/mcp-server)). enpilink is account-free, so there's no hosted dashboard — you own and serve the challenge endpoint yourself.

### Claude
Guide user to submit the app on the [Anthropic Connectors Directory FAQ](https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq).
