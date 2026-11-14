// Runs once when the server starts: recover interrupted plans and start the
// workflow scheduler, without waiting for the first page load.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { boot } = await import("@/lib/server/service");
  await boot().catch((error) => console.error("[opencrewbot] startup failed", error));
}
