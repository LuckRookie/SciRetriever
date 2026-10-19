import { useRef, useState } from "react";
import {
  parseStrictJsonValue,
  parseSynthesisPreparationRequest,
  parseSynthesisPreparationResult,
  parseKnowledgeSynthesisRequest,
  parseSynthesisExecutionReceipt,
  type SynthesisPreparationResult,
} from "@sciretriever/contracts";
import {
  Button,
  Card,
  Select,
  TechDetails,
  TextArea,
  TextField,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { navigate } from "../../data/url.js";
import { maintain } from "./transport.js";

/** Preserves the independent maintenance entry's explicit fixed-input synthesis contract. */
export function SynthesisMaintenance() {
  const api = useApi();
  const [inputs, setInputs] = useState(""),
    [policy, setPolicy] = useState("require-all"),
    [question, setQuestion] = useState(""),
    [prepared, setPrepared] = useState<SynthesisPreparationResult | null>(null),
    [result, setResult] = useState<Awaited<
      ReturnType<typeof parseSynthesisExecutionReceipt>
    > | null>(null),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const artifactId = result?.artifact?.artifact_id;
  if (api.kind !== "maintenance") return null;
  return (
    <Card title="按固定输入综合">
      <p>
        兼容已有文档、知识与综合来源选择。日常按文献范围综合可使用主工作台；此高级入口不会自动补全材料。
      </p>
      <TextArea
        label="综合输入 JSON"
        rows={5}
        value={inputs}
        onChange={(value) => {
          generation.current++;
          setInputs(value);
          setPrepared(null);
        }}
        isDisabled={busy}
      />
      <Select
        label="综合覆盖策略"
        value={policy}
        onChange={(value) => {
          generation.current++;
          setPolicy(value);
          setPrepared(null);
        }}
        options={[
          { value: "require-all", label: "要求全部材料" },
          { value: "allow-partial", label: "允许部分覆盖" },
        ]}
        isDisabled={busy}
      />
      <Button
        isDisabled={busy || !inputs.trim()}
        onPress={async () => {
          const revision = generation.current;
          const request = parseSynthesisPreparationRequest({
            inputs: parseStrictJsonValue(inputs),
            policy,
          });
          const prepared = await parseSynthesisPreparationResult(
            (await api.query("synthesis-prepare", request)).result,
            request,
          );
          if (generation.current === revision) setPrepared(prepared);
        }}
      >
        固定综合输入
      </Button>
      {prepared && (
        <p role="status">
          已固定 {prepared.manifest.items.length} 项；{prepared.gaps.length}{" "}
          项缺口。{prepared.ready ? "可以显式提交。" : "尚不能提交。"}
        </p>
      )}
      <TextField
        label="综合问题"
        value={question}
        onChange={setQuestion}
        isDisabled={busy}
      />
      <Button
        isDisabled={busy || !prepared?.ready || !question.trim()}
        confirm={{
          title: "启动固定输入综合？",
          description: "将按已固定输入调用已配置的模型，已有产物保留。",
          confirmLabel: "启动综合",
        }}
        onPress={async () => {
          if (!prepared?.ready) throw new Error("请先固定可用输入。");
          setBusy(true);
          try {
            const request = await parseKnowledgeSynthesisRequest({
              schema_version: 3,
              input: prepared.manifest,
              purpose: "synthesis",
              question,
              policy: prepared.policy,
            });
            const receipt = await parseSynthesisExecutionReceipt(
              (await maintain(api, "synthesize", request)).result,
              request,
            );
            setResult(receipt);
          } finally {
            setBusy(false);
          }
        }}
      >
        启动综合
      </Button>
      {result && (
        <>
          <p role="status">
            {artifactId ? "综合已保存。" : "本次综合未发布产物，请核对回执。"}
          </p>
          {artifactId && (
            <Button
              onPress={() => navigate({ view: "syn", artifact: artifactId })}
            >
              打开已保存综合
            </Button>
          )}
          <TechDetails copyText={JSON.stringify(result, null, 2)}>
            <pre data-testid="synthesis-receipt">
              {JSON.stringify(result, null, 2)}
            </pre>
          </TechDetails>
        </>
      )}
    </Card>
  );
}
