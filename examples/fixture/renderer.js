const params = new URLSearchParams(window.location.search);
const fault = params.get("fault") || "";
const status = document.querySelector("#status");
const result = document.querySelector("#result");

if (fault === "renderer") {
  status.textContent = "renderer-fault";
  setTimeout(() => {
    console.error("FIXTURE_RENDERER_FAILURE");
    throw new Error("fixture renderer failure");
  }, 250);
}

if (fault === "ipc") {
  status.textContent = "ipc-check";
  setTimeout(() => {
    window.fixtureApi
      .getValue()
      .then((value) => {
        result.textContent = value;
      })
      .catch((error) => {
        console.error("FIXTURE_IPC_CALL_FAILURE", error);
        result.textContent = "ipc-failure";
      });
  }, 250);
} else {
  result.textContent = "fixture-ok";
}

setTimeout(() => {
  console.log("FIXTURE_RENDERER_READY");
}, 500);
