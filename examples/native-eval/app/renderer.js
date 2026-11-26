const show = (text) => { document.getElementById("result").textContent = text; };
const value = (id) => document.getElementById(id).value;

window.nativeEval.slots().then((slots) => { document.getElementById("slots").textContent = String(slots); });

document.getElementById("sum").addEventListener("click", async () => {
  show(`${await window.nativeEval.sumSizes(value("dir"))} bytes`);
});

document.getElementById("find").addEventListener("click", async () => {
  show((await window.nativeEval.hasSubdir(value("dir"), value("name"))) ? "found" : "not found");
});
