import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApplication } from "../src/bootstrap/application.js";
import { BrowserCandidateIntake } from "../src/acquisition/browser-intake.js";
import { exportArtifact } from "../src/entry/artifact-export.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

/** Every byte of the unused PDF stream is written; this fixture is not a sparse-file transport shortcut. */
async function* pdfChunks(streamSize: number): AsyncIterable<Uint8Array> {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>",
  ];
  let head = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(head));
    head += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  offsets.push(Buffer.byteLength(head));
  head += `4 0 obj\n<< /Length ${streamSize} >>\nstream\n`;
  const end = "\nendstream\nendobj\n";
  const xref = Buffer.byteLength(head) + streamSize + Buffer.byteLength(end);
  yield Buffer.from(head);
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  for (let offset = 0; offset < streamSize; offset += chunk.length)
    yield chunk.subarray(0, Math.min(chunk.length, streamSize - offset));
  yield Buffer.from(
    `${end}xref\n0 5\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
      .join(
        "\n",
      )}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}

it.each([17, 513])(
  "accepts, recovers, publishes and exports a %i MiB PDF with bounded chunks and matching hashes",
  async (mib) => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-large-pdf-chain-"));
    const evidenceDirectory = await mkdtemp(
      join(tmpdir(), "sciretriever-large-pdf-evidence-"),
    );
    const app = await createApplication(home, {});
    const id = FIXTURE_LITERATURE.literature_id;
    const started = performance.now();
    const initialRss = process.memoryUsage().rss;
    let peakRss = initialRss;
    const sample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 20);
    try {
      await app.database.putLiterature(FIXTURE_LITERATURE);
      const collector = app.execution!.transfers;
      const intake = new BrowserCandidateIntake(collector, {
        article_id: id,
        identifier: `literature:${id}`,
        version: "published",
      });
      const inputHash = createHash("sha256");
      let inputSize = 0;
      const received = await intake.receive({
        signal: new AbortController().signal,
        transfer_id: `large-${mib}`,
        capture: {
          article_id: id,
          session_id: "synthetic-large-pdf",
          page_id: "synthetic-page",
          document_generation: 1,
          source_url: "https://example.test/synthetic.pdf",
          captured_at: "2026-10-05T00:00:00Z",
        },
        chunks: (async function* () {
          for await (const chunk of pdfChunks(mib * 1024 * 1024)) {
            inputHash.update(chunk);
            inputSize += chunk.length;
            yield chunk;
          }
        })(),
      });
      const expected = inputHash.digest("hex");
      expect(inputSize).toBeGreaterThan(mib * 1024 * 1024);
      expect(received.assessment).toEqual({ accepted: true, page_count: 1 });
      expect(received.candidate.sha256).toBe(expected);
      expect(received.candidate.size_bytes).toBe(inputSize);
      expect(await collector.recover(received.candidate.transfer_id)).toEqual(
        received.candidate,
      );
      let largestChunk = 0;
      const verified = await collector.withCandidate(
        received.candidate,
        async (file) => {
          const hash = createHash("sha256");
          let size = 0;
          for await (const chunk of file.chunks()) {
            largestChunk = Math.max(largestChunk, chunk.length);
            hash.update(chunk);
            size += chunk.length;
          }
          return { sha256: hash.digest("hex"), size };
        },
      );
      expect(verified).toEqual({ sha256: expected, size: inputSize });
      expect(largestChunk).toBeLessThanOrEqual(1024 * 1024);
      const facts = await app.database.currentFacts(id);
      const receipt = await app.execution!.acceptance.accept({
        literature_id: id,
        transfer_id: received.candidate.transfer_id,
        receipt_id: `large-receipt-${mib}`,
        metadata_snapshot: facts!.metadata_snapshot,
      });
      const detail = await app.library.detail(id);
      expect(detail.primary_pdf?.article_identity_status).toBe("unverified");
      expect(receipt.sha256).toBe(expected);
      await mkdir(join(home, "exports"));
      const target = join(home, "exports", "large.pdf");
      await exportArtifact(
        app.literatureArtifacts,
        detail.primary_pdf!.asset,
        target,
      );
      const exportedHash = createHash("sha256");
      let exportedSize = 0;
      for await (const chunk of createReadStream(target, {
        highWaterMark: 1024 * 1024,
      })) {
        exportedHash.update(chunk);
        exportedSize += chunk.length;
      }
      expect(exportedSize).toBe(inputSize);
      expect(exportedHash.digest("hex")).toBe(expected);
      // An unregistered technical artifact of the same size exercises the existing
      // recovery/reclamation scanner. Its first byte differs from registered PDF
      // bytes so hash-based fact protection continues to protect the real asset.
      const retiredStage = await app.files.stage({
        maxBytes: inputSize,
        budget: collector.resources.forTransfer(`retired-large-${mib}`),
      });
      await collector.withCandidate(received.candidate, async (file) => {
        let first = true;
        for await (const chunk of file.chunks()) {
          if (first) {
            const altered = Buffer.from(chunk);
            altered[0] = 0;
            await retiredStage.write(altered);
            first = false;
          } else await retiredStage.write(chunk);
        }
      });
      const retired = await app.files.publish(
        retiredStage,
        `.objects/retired-large-${mib}.bin`,
      );
      const ticket = await app.artifactRecovery.prepare([
        {
          reference: retired.reference,
          artifact: {
            sha256: retired.sha256,
            byte_size: retired.size,
            media_type: "application/octet-stream",
          },
        },
      ]);
      expect(await app.artifactRecovery.complete(ticket)).toEqual({
        deleted: [retired.reference],
        missing: [],
        preserved: [],
      });
      await expect(
        stat(join(app.files.root, retired.reference)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(join(app.files.root, receipt.reference))).size).toBe(
        inputSize,
      );
      const evidence = {
        generated_stream_mib: mib,
        actual_bytes: inputSize,
        sha256: expected,
        largest_reader_chunk: largestChunk,
        elapsed_ms: performance.now() - started,
        node_rss_initial: initialRss,
        node_rss_sampled_peak: peakRss,
        sample_interval_ms: 20,
        sample_limit:
          "Node process only; sampling can miss short peaks; no Browser is used in this file-chain test",
        transport: "all bytes written through bounded chunks, not sparse",
        temporary_resource_snapshot: collector.resources.snapshot(),
        temporary_resource_limit:
          "Live owner ledger of reserved bytes and confirmed writes; durable candidates/assets excluded after publication; no native Browser original in this test",
        retired_artifact_reclaimed_bytes: retired.size,
      };
      await writeFile(
        join(evidenceDirectory, "evidence.json"),
        JSON.stringify(evidence, null, 2),
      );
      console.info(`Large PDF file-chain evidence: ${evidenceDirectory}`);
    } finally {
      clearInterval(sample);
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  180000,
);
