// Forked by main.cjs as a utility process when FIXTURE_UTILITY=true.
const run = process.env.FIXTURE_RUN_ID || "";

globalThis.fixtureUtility = {
  value: "utility-ok",
  evidence(id) {
    console.log("FIXTURE_UTILITY_EVIDENCE", run, id);
    return true;
  },
};

process.parentPort.on("message", () => undefined);
setInterval(() => undefined, 60_000);
console.log("FIXTURE_UTILITY_READY", run);
