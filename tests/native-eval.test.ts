import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../examples/native-eval/", import.meta.url);
const evals = JSON.parse(readFileSync(new URL("evals.json", root), "utf8")) as {
  skills: string[];
  evaluations: Array<{
    id: string;
    query: string;
    setup: string;
    files: string[];
    root_cause: string;
    expected_behavior: string[];
    must_not: string[];
    posix?: { files?: string[]; setup?: string; root_cause?: string; expected_behavior: string[] };
  }>;
};

test("the native debugging evaluations name the Skill and carry a rubric each", () => {
  assert.deepEqual(evals.skills, ["electron-debug"]);
  assert.ok(evals.evaluations.length >= 3, "the authoring guide asks for at least three evaluations");
  assert.equal(new Set(evals.evaluations.map((item) => item.id)).size, evals.evaluations.length, "ids must be unique");
  for (const item of evals.evaluations) {
    assert.ok(item.query.length > 20, `${item.id}: query`);
    assert.ok(item.setup.length > 20, `${item.id}: setup`);
    assert.ok(item.root_cause.length > 20, `${item.id}: root_cause`);
    assert.ok(item.expected_behavior.length >= 5, `${item.id}: needs a rubric of at least five items`);
    assert.ok(item.must_not.length >= 1, `${item.id}: must_not`);
    assert.ok((item.posix?.expected_behavior.length ?? 0) >= 5, `${item.id}: needs a rubric for Linux and macOS too`);
  }
});

test("every file an evaluation points at exists, and the native source still contains the bugs under test", () => {
  for (const item of evals.evaluations) {
    for (const file of [...item.files, ...(item.posix?.files ?? [])]) {
      assert.ok(existsSync(new URL(file, root)), `${item.id}: missing ${file}`);
    }
  }
  const source = readFileSync(new URL("native/native_eval.cpp", root), "utf8");
  assert.ok(/if \(sub == 0\) break;/u.test(source), "early-exit: the loop must still end at an empty folder");
  assert.ok(source.includes("GetFileAttributesA"), "code-page: the ANSI API must still be used");
  assert.ok(source.includes("std::min(requested, 64)"), "startup-call: min must still be used where max is meant");
  assert.ok(source.includes("to_file_system_encoding(path)"), "code-page (Linux, macOS): the path must still be re-encoded");
});
