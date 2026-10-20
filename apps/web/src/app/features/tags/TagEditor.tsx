import { useState } from "react";
import type { Tag, VocabularyMutation } from "@sciretriever/contracts";
import {
  Button,
  Disclosure,
  Select,
  TextArea,
  TextField,
} from "../../components/index.js";

/** Each explicit edit uses the vocabulary owner's revision check and audit log. */
export function TagEditor({
  tag,
  vocabulary,
  busy,
  change,
}: {
  tag: Tag;
  vocabulary: readonly Tag[];
  busy: boolean;
  change: (mutation: VocabularyMutation, reason: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(tag.name_zh),
    [english, setEnglish] = useState(tag.name_en),
    [aliases, setAliases] = useState(tag.aliases.join("\n")),
    [includes, setIncludes] = useState(tag.definition.includes),
    [excludes, setExcludes] = useState(tag.definition.excludes),
    [category, setCategory] = useState(tag.category ?? ""),
    [parent, setParent] = useState(tag.parent_id ?? ""),
    [reason, setReason] = useState("");
  const save = (mutation: VocabularyMutation) =>
    change(mutation, reason.trim() || "人工编辑词表");
  return (
    <Disclosure title="编辑标签">
      <TextField label="修改理由" value={reason} onChange={setReason} />
      <TextField label="中文名称" value={name} onChange={setName} />
      <TextField label="英文名称" value={english} onChange={setEnglish} />
      <TextArea
        label="同义词（每行一个）"
        value={aliases}
        onChange={setAliases}
      />
      <Button
        isDisabled={busy || (!name.trim() && !english.trim())}
        onPress={async () => {
          await save({
            op: "rename",
            tag_id: tag.tag_id,
            name_zh: name,
            name_en: english,
            aliases: aliases
              .split(/\r?\n/u)
              .map((v) => v.trim())
              .filter(Boolean),
          });
        }}
      >
        保存名称
      </Button>
      <TextArea label="纳入定义" value={includes} onChange={setIncludes} />
      <TextArea label="排除定义" value={excludes} onChange={setExcludes} />
      <Button
        isDisabled={busy || !includes.trim()}
        onPress={async () => {
          await save({
            op: "edit-definition",
            tag_id: tag.tag_id,
            definition: { includes, excludes },
          });
        }}
      >
        保存定义
      </Button>
      <TextField label="类别" value={category} onChange={setCategory} />
      <Button
        isDisabled={busy}
        onPress={async () => {
          await save({
            op: "set-category",
            tag_id: tag.tag_id,
            category: category.trim() || null,
          });
        }}
      >
        保存类别
      </Button>
      <Select
        label="上级标签"
        value={parent}
        onChange={setParent}
        options={[
          { value: "", label: "无上级" },
          ...vocabulary
            .filter((t) => !t.parent_id && t.tag_id !== tag.tag_id)
            .map((t) => ({ value: t.tag_id, label: t.name_zh || t.name_en })),
        ]}
      />
      <Button
        isDisabled={busy}
        onPress={async () => {
          await save({
            op: "set-parent",
            tag_id: tag.tag_id,
            parent_id: parent || null,
          });
        }}
      >
        保存层级
      </Button>
      <Button
        isDisabled={busy}
        onPress={async () => {
          await save({
            op: "set-lock",
            tag_id: tag.tag_id,
            locked: !tag.locked,
          });
        }}
      >
        {tag.locked ? "解锁标签" : "锁定标签"}
      </Button>
    </Disclosure>
  );
}
