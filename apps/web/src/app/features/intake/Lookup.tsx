import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, ErrorNotice, TextArea } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { navigate } from "../../data/url.js";
import {
  LOOKUP_LINE_LIMIT,
  lookupLineCount,
  submitLookup,
} from "../../data/intake-lookup.js";
import { errorMessage } from "../../strings.js";

const EXAMPLE = [
  "10.1000/example.2024.001",
  "https://arxiv.org/abs/2401.01234",
  "Machine learning in chemical synthesis: a review",
].join("\n");
const TOO_MANY = `一次最多 ${LOOKUP_LINE_LIMIT} 行，请分批`;

/**
 * “指定文献” (page specs “找文献”): papers named one a line, by DOI, address
 * or full title. Looking them up forms a batch and opens its page; nothing is
 * written to the library until that batch is confirmed.
 */
export function Lookup() {
  const api = useApi(),
    queries = useQueryClient();
  const [text, setText] = useState("");
  const lines = lookupLineCount(text),
    over = lines > LOOKUP_LINE_LIMIT;
  const submit = useMutation({
    mutationFn: (value: string) => submitLookup(api, value),
    onSuccess: (id) => {
      void queries.invalidateQueries({
        queryKey: ["library", "intake-batches"],
      });
      navigate({ session: id });
    },
  });
  return (
    <div className="intake-lookup">
      <TextArea
        label="每行一篇：DOI、文献的网址，或完整的标题。"
        width="full"
        rows={6}
        value={text}
        onChange={(value) => {
          setText(value);
          if (submit.isError) submit.reset();
        }}
        placeholder={EXAMPLE}
      />
      <div className="intake-lookup-foot">
        <span
          className="intake-lookup-count"
          data-over={over || undefined}
          role={over ? "alert" : undefined}
        >
          {over ? TOO_MANY : `${lines.toLocaleString()} 行`}
        </span>
        <Button
          variant="primary"
          isPending={submit.isPending}
          disabledReason={
            !lines ? "先在上面贴入要找的文献" : over ? TOO_MANY : undefined
          }
          onPress={() => submit.mutate(text)}
        >
          查找这些文献
        </Button>
      </div>
      {submit.isError ? (
        <ErrorNotice
          message={errorMessage(submit.error)}
          retained="输入的内容还在，改好后可以再查找；文献库没有变化。"
        />
      ) : null}
    </div>
  );
}
