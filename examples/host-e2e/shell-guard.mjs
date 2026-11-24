#!/usr/bin/env node
// PreToolUse hook for the shell scenarios: the host may inspect processes and start the app, but it must not end
// processes, delete or rewrite files, or touch the repository. The hook reads the tool call on stdin and answers with a
// permission decision. It is a guard rail for a test run, not a sandbox.
const deny = /\b(taskkill|stop-process|pkill|killall|kill|remove-item|rmdir|rm|del|erase|move-item|set-content|out-file|shutdown|restart-computer|format-volume|git|npm|pnpm|yarn|curl|wget|invoke-webrequest)\b|(?<![0-9&])>>?\s*(?!&|\/dev\/null|nul\b|\$null)\S|\bsudo\b/iu;

let input = "";
for await (const chunk of process.stdin) input += chunk;
let command = "";
try {
  command = String(JSON.parse(input)?.tool_input?.command ?? "");
} catch {
  // Unreadable input is treated as an empty command and allowed to fail in the host.
}
const match = deny.exec(command);
const decision = match
  ? { permissionDecision: "deny", permissionDecisionReason: `This test only allows inspecting processes and starting the app; "${match[0]}" is not allowed. Do not stop or delete anything: start a second instance instead.` }
  : { permissionDecision: "allow" };
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } }));
