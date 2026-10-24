import { describe, expect, it } from "vitest";
import { jobRecord } from "../src/app/data/wire.js";

describe("task progress wire projection", () => {
  const job = { job_id: "synthetic-task", status: "running", selector: {} };
  it("preserves task fields and parses target progress without requiring it on detail records", () => {
    expect(jobRecord(job)).toEqual(job);
    expect(jobRecord({ ...job, progress: { total: 3, done: 2 } })).toEqual({
      ...job,
      progress: { total: 3, done: 2 },
    });
    expect(
      jobRecord({ ...job, progress: { total: 0, done: 0 } }).progress,
    ).toEqual({ total: 0, done: 0 });
  });
  it.each([
    null,
    { total: 1, done: 2 },
    { total: 2, done: -1 },
    { total: "2", done: 1 },
  ])(
    "rejects invalid progress instead of inventing zero counts: %j",
    (progress) => expect(() => jobRecord({ ...job, progress })).toThrow(),
  );
});
