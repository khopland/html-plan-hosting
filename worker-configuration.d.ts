type WorkerBindings = import("./src/worker").Env;

declare namespace Cloudflare {
  interface Env extends WorkerBindings {}
  interface GlobalProps {
    mainModule: typeof import("./src/worker");
    durableNamespaces: "UploadRateLimiter";
  }
}

interface Env extends WorkerBindings {}
