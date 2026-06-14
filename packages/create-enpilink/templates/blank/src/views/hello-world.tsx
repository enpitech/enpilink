import { useToolInfo } from "../helpers.js";

/**
 * Minimal starter view. Rendered by the `hello-world` tool.
 * Replace this with your own views under `src/views/`.
 */
export default function HelloWorld() {
  const { input } = useToolInfo<"hello-world">();
  const name = input?.name || "world";

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Hello, {name} 👋</h1>
      <p style={{ color: "#666" }}>
        Your enpilink app is running. Edit{" "}
        <code>src/views/hello-world.tsx</code> and <code>src/server.ts</code> to
        build your own.
      </p>
    </main>
  );
}
