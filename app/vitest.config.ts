// Testes das funções puras (npm test). Fora de src/: não entram no tsc nem no build da tela.
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify("test"), __BUILD_ID__: JSON.stringify("test") },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
