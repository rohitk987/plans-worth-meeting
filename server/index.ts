import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createPlansApp } from "./app";

const isDev = process.argv.includes("--dev");
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
if (!isDev) process.env.NODE_ENV = "production";

async function start() {
  const { app } = createPlansApp({ secureCookies: !isDev });

  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      configFile: path.join(projectRoot, "vite.config.ts"),
      root: path.join(projectRoot, "client"),
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const staticPath = path.join(here, "public");
    app.use(express.static(staticPath, { maxAge: "1h" }));
    app.get("*", (_req, res) => res.sendFile(path.join(staticPath, "index.html")));
  }

  const server = createServer(app);
  const port = Number(process.env.PORT || 3000);
  server.listen(port, "0.0.0.0", () => console.log(`Plans is ready at http://localhost:${port}/`));
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
