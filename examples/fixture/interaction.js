// Records what the page receives, so the smoke can check trusted input reached the right element.
const events = [];
const record = (entry) => {
  events.push(entry);
  document.getElementById("events").textContent = JSON.stringify(events);
  console.log("FIXTURE_INTERACTION", JSON.stringify(entry));
};
window.interactionEvents = events;

for (const id of ["save", "covered", "far"]) {
  document.getElementById(id).addEventListener("click", (event) =>
    record({ type: "click", id, trusted: event.isTrusted, detail: event.detail }));
}
document.getElementById("name").addEventListener("input", (event) =>
  record({ type: "input", id: "name", trusted: event.isTrusted, value: event.target.value }));

// A controlled input in the React style: the value always comes from state, so a direct `.value` write is undone.
const controlled = document.getElementById("controlled");
let state = "";
controlled.addEventListener("input", (event) => {
  state = event.target.value;
  record({ type: "input", id: "controlled", trusted: event.isTrusted, value: state });
});
setInterval(() => {
  if (controlled.value !== state) controlled.value = state;
}, 10);

document.getElementById("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  record({ type: "submit", value: document.getElementById("search").value });
});

window.showOverlay = (visible) => {
  document.getElementById("overlay").style.height = visible ? "100%" : "0";
};
