const params = new URLSearchParams(window.location.search);
const run = params.get("run") ?? "";
const status = document.querySelector("#status");

// A dev server prints this kind of line constantly; attaching later replays them all.
for (let index = 0; index < Number(params.get("noise") ?? 0); index += 1) {
  console.log(`[field] hot update ${index}`);
}

// A page with thousands of accessibility nodes, far beyond the snapshot's default budget.
const rows = document.querySelector("#rows");
for (let index = 0; index < 1500; index += 1) {
  const item = document.createElement("li");
  item.textContent = `row ${index}`;
  rows.appendChild(item);
}

document.querySelector("#probe").addEventListener("click", () => {
  status.textContent = "probed";
});

// Nothing happens until someone presses the button.
document.querySelector("#save").addEventListener("click", async () => {
  status.textContent = "saving";
  try {
    await window.fieldApi.save({ name: document.querySelector("#name").value });
    status.textContent = "saved";
    console.log("FIELD_SAVE_OK", run);
  } catch (error) {
    status.textContent = "save-failed";
    console.error("FIELD_SAVE_CALL_FAILURE", error);
  }
});

setTimeout(() => console.log("FIELD_RENDERER_READY", run), 300);
