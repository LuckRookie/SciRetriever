# ADR 0003: Operator-managed MinerU PDF parsing service

- Status: Accepted
- Date: 2026-07-24
- Supersedes: none
- Superseded by: none
- Approval reference: `conversation-2026-07-24-wp4-mineru-parser-service`
- Related: [ADR 0001](0001-sciretriever-scope-and-boundary.md), [ADR 0002](0002-work-centered-literature-library.md), [requirements](../specs/requirements.md), [system design](../specs/system-design.md), [WP4 execution plan](../planning/literature-library-execution.md)

## Context

WP4 needs scientific-PDF parsing that preserves reading order, formulas, tables, figures and page coordinates even when the embedded text layer is damaged. A local comparison over Chinese and English scientific PDFs found MinerU 3.4.4 `vlm-engine` materially stronger than the evaluated alternatives on those cases.

Loading the VLM through vLLM is expensive. Starting a parser process for every PDF would repeatedly pay model initialization cost and consume GPU memory unpredictably. MinerU 3.4.4 provides a persistent `mineru-api`, process-wide model caching, optional startup preload and an asynchronous task API.

ADR 0002 rejects a SciRetriever-owned daemon, task-centered product and durable workflow control. It does not prohibit an explicit adapter to an independently operated external capability. This ADR defines that distinction.

## Decision

1. The approved WP4 primary PDF parser is MinerU 3.4.4 `vlm-engine`, pinned by service version, API protocol and operator-declared model revision. A MinerU version or model change requires parser acceptance fixtures before adoption.
2. SciRetriever connects to an operator-managed persistent `mineru-api`. SciRetriever never starts, stops, reloads, upgrades or owns the MinerU process, GPU, model files, capacity or task retention.
3. The SciRetriever command remains a foreground invocation. The external service is a parser capability, not a SciRetriever daemon, microservice product, workflow engine or task center.
4. `normalization` owns the MinerU adapter and converts validated MinerU output into SciRetriever source units and PDF evidence. `analysis` consumes only those validated normalized artifacts; MinerU does not own LLM analysis, current-result replacement or canonical projection.
5. The connector uses MinerU API protocol 2 asynchronous endpoints: `GET /health`, `POST /tasks`, `GET /tasks/{task_id}` and `GET /tasks/{task_id}/result`. It does not use synchronous `/file_parse` for normal WP4 work.
6. SciRetriever persists the external task ID only as processing-attempt metadata needed to resume polling. It is not a product `Job`, does not restore the retired task lifecycle and does not promise network exactly-once. A missing or expired remote task may create a new attempt under the same deterministic processing run.
7. Loopback mode permits plain HTTP only to an explicitly configured loopback endpoint. Remote mode requires HTTPS, exact endpoint policy, explicit permission to upload PDFs and runtime-only authentication supplied by the deployment boundary. MinerU's native API must not be exposed publicly without an authenticated TLS reverse proxy or equivalent private transport.
8. SciRetriever derives status and result paths from the configured origin and a validated task ID. It does not trust response-provided absolute URLs, redirects or a caller-controlled MinerU `server_url`.
9. Result archives are untrusted. The connector enforces download, archive expansion, file-count, compression, JSON, image, page, block and text bounds before publishing immutable derived artifacts.
10. `middle.json` is the primary structural input; `content_list.json`, model output and extracted images are preserved as supporting artifacts. Markdown is a derived view, not the canonical parser contract.
11. Every promoted analysis section, field and resolved reference remains traceable to the accepted primary PDF through validated page/span locators. MinerU text and bounding boxes are extraction candidates, not a replacement authority for the PDF bytes or rendered page.

## Consequences

- Operators can preload the VLM once and reuse it across documents; SciRetriever can run on a different host from the GPU service.
- Service restarts lose MinerU's in-memory task state. SciRetriever must handle `404`/expiration by resubmitting an attempt without corrupting a prior current result.
- MinerU 3.4.4 has no native cancellation, idempotency, authentication, TLS or application upload-size limit. The connector and deployment must supply the missing boundaries.
- `/health` exposes service and protocol versions but not model ID/revision. Until a verified deployment manifest exists, model identity is operator-attested provenance and must be labeled as such.
- MinerU 4.x changes the backend contract and is not an automatic upgrade path. It requires a separate comparison and owner acceptance.
- README and `config.example.toml` remain unchanged until the connector and strict configuration are implemented and accepted.

## Rejected alternatives

- Start an invocation-local MinerU process for each PDF. Rejected because repeated VLM loading dominates latency and GPU use.
- Make SciRetriever own a long-running MinerU daemon. Rejected because it would move deployment and worker ownership into the product.
- Connect SciRetriever directly to the OpenAI-compatible vLLM endpoint. Rejected because that endpoint performs inference, not MinerU document parsing and result assembly.
- Treat VLM Markdown as authoritative input. Rejected because it loses the strongest structured provenance and PDF page/span evidence.
