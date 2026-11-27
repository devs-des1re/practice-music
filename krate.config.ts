import { defineConfig } from "@krate/core";

export default defineConfig({
  entry: "src/pages/index.tsx",
  pagesDir: "src/pages",
  outDir: "dist",
  native: {
    appId: "com.devs-des1re.practice-music",
    productName: "PracticeMusic",
    version: "0.1.0",
    window: { width: 1280, height: 800 },
    permissions: ["dialog"],
    media: {
      usage: { microphone: "PracticeMusic reads your instrument or line input so you can hear it in the mix." },
    },
    lean: { ignore: ["KR7272"] },
  },
});
