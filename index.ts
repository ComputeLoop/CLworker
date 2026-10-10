import { runWorker, type WorkerEvent } from "./runner";

const PROJECT_ID = process.argv[2] ?? "";

function consoleEmit(event: WorkerEvent) {
  if (event.type !== "log") return;
  if (event.level === "error") console.error(event.message);
  else if (event.level === "warn") console.warn(event.message);
  else console.log(event.message);
}

async function main() {
  if (PROJECT_ID) {

    const apiKey =
      process.env.WORKER_API_KEY ?? process.env.API_KEY ?? "";
    const apiBase = (
      process.env.COMPUTELOOP_API ?? "http://localhost:6767"
    ).replace(/\/$/, "");

    if (!apiKey) {
      console.error(
        "Missing WORKER_API_KEY. Create one on the Contribute page of the project in the web UI.",
      );
      process.exit(1);
    }

    runWorker({
      apiBase,
      apiKey,
      projectId: PROJECT_ID,
      emit: consoleEmit,
      onFatal: () => process.exit(1),
    });
  } else {
    
    const { startContributorApp } = await import("./server");
    await startContributorApp();
  }
}

main();