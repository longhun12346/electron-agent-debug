export function expectedEvidence(fault) {
  return {
    "main-window": [["main", "FIXTURE_MAIN_WINDOW_FAILURE"]],
    renderer: [["renderer", "FIXTURE_RENDERER_FAILURE"]],
    ipc: [
      ["renderer", "FIXTURE_IPC_CALL_FAILURE"],
      ["main", "FIXTURE_IPC_HANDLER_FAILURE"],
    ],
  }[fault] ?? [["renderer", "FIXTURE_RENDERER_READY"]];
}

export function hasExpectedEvidence(events, fault) {
  return expectedEvidence(fault).every(([scope, message]) =>
    events?.some((event) => event.process === scope && event.message?.includes(message)));
}

export function assertSmokeResults(attach, status, targets, logs, fault) {
  if (!attach.main?.online || !status.main?.online) {
    throw new Error("main session is not online");
  }
  if (fault === "main-window") {
    if (attach.renderer?.online || status.renderer?.online ||
        attach.selectedTarget || status.selectedTarget || targets.selectedTarget) {
      throw new Error("main-window failure must not report an online renderer target");
    }
  } else {
    if (!attach.renderer?.online || !attach.selectedTarget ||
        !status.renderer?.online || !status.selectedTarget ||
        !targets.targets?.length || !targets.selectedTarget) {
      throw new Error("renderer session or selected target is not online");
    }
  }
  if (!hasExpectedEvidence(logs.events, fault)) {
    throw new Error(`missing scoped fixture evidence: ${JSON.stringify(expectedEvidence(fault))}`);
  }
}
