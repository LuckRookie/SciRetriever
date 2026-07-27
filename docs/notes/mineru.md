# MinerU 接入注意事项

> Status: current released PDF analysis behavior. Accepted configuration is defined by `config.py` and `config.example.toml`; operator-only `mineru-api` commands manage the external service independently of SciRetriever.

This note records the external MinerU contract approved in [ADR 0003](../architecture/decisions/0003-operator-managed-mineru-service.md). Product behavior is owned by the requirements and system design; this document explains deployment, readiness, incident handling and evidence needed to use that capability safely.

No credential value, private endpoint, model token, user PDF content or runtime task URL belongs in this guide.

## 1. Pinned contract

PDF analysis currently targets:

| Item | Approved value |
|---|---|
| MinerU release | `3.4.4` |
| MinerU API protocol | `2` |
| Parser backend | `vlm-engine` |
| Parser service | operator-managed persistent `mineru-api` |
| Primary structure | `middle.json` |
| Supporting outputs | `content_list.json`, model output, extracted images |
| Authority | accepted primary PDF and validated page/span evidence |

MinerU 4.x changes the standalone VLM contract and is not an automatic upgrade. A service, model, inference engine or output-schema change requires the parser acceptance corpus and owner review before the pinned values change.

Official 3.4.4 references, checked 2026-07-24:

- [release](https://github.com/opendatalab/MinerU/releases/tag/mineru-3.4.4-released)
- [CLI and service usage](https://github.com/opendatalab/MinerU/blob/0dfc9460cd9ab693b9af60ae3fbffd7bc111b062/docs/en/usage/cli_tools.md)
- [API request schema](https://github.com/opendatalab/MinerU/blob/0dfc9460cd9ab693b9af60ae3fbffd7bc111b062/mineru/cli/api_request.py)
- [FastAPI task lifecycle](https://github.com/opendatalab/MinerU/blob/0dfc9460cd9ab693b9af60ae3fbffd7bc111b062/mineru/cli/fast_api.py)
- [model preload](https://github.com/opendatalab/MinerU/blob/0dfc9460cd9ab693b9af60ae3fbffd7bc111b062/mineru/cli/vlm_preload.py)

The parser comparison that motivated the decision is outside this repository at `literature/parsed/parser_comparison/README.md`. It is supporting evidence, not a runtime fixture or normative specification.

## 2. Ownership boundary

```text
Operator                                  SciRetriever
--------                                  ------------
deploy mineru-api                         validate configured endpoint
stage model/runtime                       check health/version/protocol
own GPU and VRAM                          upload one accepted primary PDF
preload and cache model                   submit/poll one bounded task
set service concurrency/retention         validate and publish result artifacts
provide TLS/auth for remote access        build PDF source units/evidence
upgrade only after acceptance             run LLM and atomic current replacement
```

SciRetriever never starts, stops, reloads or upgrades MinerU. It also does not configure the service's internal vLLM endpoint through request `server_url`. The connector talks to `mineru-api`, not directly to `mineru-openai-server` or a generic OpenAI-compatible inference endpoint.

## 3. Recommended deployment

For a trusted workstation, keep the service on loopback and preload the model:

```bash
MINERU_MODEL_SOURCE=local \
MINERU_API_MAX_CONCURRENT_REQUESTS=1 \
mineru-api \
  --host 127.0.0.1 \
  --port 8000 \
  --enable-vlm-preload true
```

Preload occurs during FastAPI startup. A healthy response therefore means startup, including requested preload, completed. MinerU caches the local VLM in the service process and releases it when that process exits.

For remote access:

1. Keep `mineru-api` on loopback on the GPU host.
2. Put it behind an authenticated HTTPS reverse proxy, private ingress or VPN.
3. Enforce request-body limits and connection limits at that boundary.
4. Run one MinerU process per task namespace. Do not put independent workers behind a non-sticky load balancer because task state is process-local.
5. Disable public FastAPI docs when not needed with `MINERU_API_ENABLE_FASTAPI_DOCS=0`.

Do not expose plain `mineru-api --host 0.0.0.0` directly to an untrusted network. MinerU 3.4.4 does not provide native authentication, TLS or application-level upload-size limits.

## 4. Health and readiness

`GET /health` must return HTTP 200 and include:

```json
{
  "status": "healthy",
  "version": "3.4.4",
  "protocol_version": 2,
  "max_concurrent_requests": 1,
  "processing_window_size": 64,
  "task_retention_seconds": 86400
}
```

SciRetriever checks the fixed service origin and requires health status `healthy`, version `3.4.4` and protocol `2` before submission. It does not currently validate the health response's concurrency, window or retention values. The API does not report model ID, model revision, CUDA/vLLM identity or a cryptographic deployment fingerprint; those remain operator-attested configuration and provenance.

`sciretriever config check` is offline by default and does not contact MinerU. The explicit `config check --runtime` mode performs one bounded, read-only health identity probe for an enabled target. A ready probe confirms the configured service/version/protocol identity only; it does not prove model attestation, capacity, future task success or acceptance of parser output.

The operator should record, outside the repository:

- MinerU wheel/version and lock or container digest;
- exact model ID, revision and file hashes;
- inference engine, CUDA/driver and GPU class;
- service concurrency, retention and output root;
- deployment identifier and last acceptance-corpus result.

## 5. Current connection configuration

This is a minimal accepted shape. [`config.example.toml`](../../config.example.toml) is the exhaustive list of accepted safety bounds and exact field names:

```toml
[analysis.mineru]
mode = "loopback" # or "remote"
endpoint = "http://127.0.0.1:8000"
service_version = "3.4.4"
api_protocol = 2
backend = "vlm-engine"
model = "operator/model@revision"
overall_deadline = 900.0
poll_interval = 2.0
max_upload_bytes = 104857600
max_archive_bytes = 536870912
max_archive_files = 10000
max_extracted_bytes = 1073741824
max_attempts = 3
```

Remote mode additionally requires a runtime credential reference and an explicit remote-PDF-upload acknowledgement. Secret values never enter TOML examples, terminal output, diagnostics, provenance or current results.

Loopback mode accepts only an explicit loopback origin. Remote mode requires HTTPS, authentication, `remote_upload = true`, and a globally routable DNS target; private remote address support is not implemented. Both modes reject userinfo, query/fragment, cross-origin redirects and response-supplied absolute task URLs.

## 6. Request lifecycle

SciRetriever uses the asynchronous API:

```text
GET  /health
POST /tasks
GET  /tasks/{validated_uuid}
GET  /tasks/{validated_uuid}/result
```

The request uploads one accepted primary PDF and fixes these fields:

```text
backend=vlm-engine
formula_enable=true
table_enable=true
image_analysis=true
return_md=false
return_middle_json=true
return_model_output=true
return_content_list=true
return_images=true
response_format_zip=true
return_original_file=false
client_side_output_generation=false
```

The connector validates a UUID task ID and derives status/result paths from the configured origin. It ignores response-provided absolute URLs. It submits at most the configured bounded number of tasks and does not fill MinerU's unbounded in-memory queue.

## 7. Interruption and recovery

MinerU task states are `pending`, `processing`, `completed` and `failed`. They live only in one service process. Completed/failed tasks are retained for 24 hours by default and then deleted.

MinerU 3.4.4 has no cancellation endpoint and no idempotency key. Therefore:

- Ctrl+C stops SciRetriever submission and polling; it does not claim the external task was cancelled.
- The task ID is stored only as processing-attempt metadata under a deterministic run keyed by PDF hash and parser/model/config identity.
- A rerun polls the existing task when the same service deployment still knows it.
- `404` means unknown, expired or restarted service state; SciRetriever creates a new attempt under the same run.
- A validated local derived artifact wins over any remote task state and is reused without another upload.
- No parser result changes the current analysis until all local validation and atomic replacement gates succeed.

Operators should set service retention longer than the maximum SciRetriever task deadline and expected interruption window.

## 8. Result admission

The result ZIP is hostile input even from a trusted endpoint. SciRetriever must stream it with a byte limit and reject:

- absolute paths, `..`, duplicate paths, symlinks and unexpected file types;
- excessive compressed/uncompressed size, compression ratio or file count;
- excessive JSON depth, page/block/span count or text size;
- oversized, malformed or unsupported images;
- missing or malformed `middle.json`/content/model outputs;
- backend/version mismatch, invalid page index/size, NaN/infinite/inverted/out-of-page bbox;
- output that cannot be connected to the exact accepted primary PDF hash.

Accepted raw parser outputs are published as immutable derived artifacts. `middle.json` supplies page, paragraph, line and span geometry; SciRetriever assigns stable source IDs and normalized offsets. `content_list.json`, model output and images provide supporting structure. Markdown is generated later and never substitutes for source evidence.

## 9. Incident checklist

### Service unavailable or unhealthy

1. Check `/health` without printing credentials.
2. Confirm version `3.4.4` and protocol `2`.
3. Check the operator's model preload and GPU logs.
4. Do not let SciRetriever start a replacement process.
5. Keep old current results unchanged and rerun after readiness is restored.

### Task remains pending

1. Inspect `queued_ahead` and service concurrency.
2. Confirm SciRetriever did not submit more than its configured in-flight limit.
3. Check GPU capacity and the single-process deployment assumption.
4. Do not resubmit while the same task remains known unless the processing deadline policy explicitly permits a new attempt.

### Task disappears

1. Treat `404` as expired or restarted in-memory state.
2. Preserve the failed/lost attempt metadata.
3. Submit a new attempt under the same deterministic processing run.
4. Never publish two conflicting artifacts for the same derivation identity.

### Result rejected

1. Distinguish transport/archive/schema/geometry/evidence-validation categories.
2. Preserve only bounded, redacted diagnostics; do not retain unsafe extracted paths.
3. Keep the prior current result and immutable primary PDF untouched.
4. Re-run the fixture before changing MinerU/model/config versions.

## 10. Upgrade and retirement gate

Before changing MinerU, model, backend, engine or output schema:

1. Pin the candidate version and model revision.
2. Run the scientific-PDF parser comparison and offline malicious-result fixtures.
3. Compare reading order, formulas, tables, figures and page/bbox evidence quality.
4. Review code/model/dependency licenses and deployment requirements.
5. Update ADR/spec/plan/provenance schema only after owner acceptance.
6. Keep the old service available until the new parser artifacts pass local validation; parser service availability must never force replacement of an existing current result.
## SciRetriever invocation

Configure the pinned target under `[analysis.mineru]`, configure the OpenAI-compatible analysis target under `[analysis.llm]`, export only the named credential variables at runtime, and run `sciretriever analyze` with an explicit selector. `search --level analyze` sends only that invocation's targets through the shared completion pipeline to the COMPLETE stop. SciRetriever does not own service lifecycle operations.
