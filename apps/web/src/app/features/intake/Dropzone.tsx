import { useEffect, useRef, useState, type DragEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, ErrorNotice, Select } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { navigate } from "../../data/url.js";
import { IMPORT_FORMATS } from "../../data/imports.js";
import {
  droppedFiles,
  dropProblem,
  hiddenInFolder,
  pickedFiles,
  sortDrop,
  submitDrop,
  type DroppedFile,
  type SortedDrop,
} from "../../data/intake-drop.js";
import { errorMessage } from "../../strings.js";

const SUPPORTED = "支持 PDF；BibTeX、BibLaTeX、RIS、CSL JSON 导出文件";
/** Files of a drop not sent, shown again on the batch page it opened. */
export const unrecognized = new Map<string, string[]>();

/**
 * “文件” (page specs “入库”): one place for PDFs, folders and an export.
 * What it holds is recognized here; a drop with PDFs only forms its batch
 * at once, and one with an export once its format is settled.
 */
export function Dropzone() {
  const api = useApi(),
    queries = useQueryClient();
  const files = useRef<HTMLInputElement>(null),
    folder = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false),
    [drop, setDrop] = useState<SortedDrop | null>(null),
    [format, setFormat] = useState(""),
    [sent, setSent] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    // Folder selection is a non-standard attribute React does not type.
    folder.current?.setAttribute("webkitdirectory", "");
  }, []);
  const submit = useMutation({
    mutationFn: (value: { drop: SortedDrop; format: string | null }) =>
      submitDrop(api, value.drop, value.format, (done, total) =>
        setSent({ done, total }),
      ),
    onSuccess: (id, value) => {
      if (value.drop.unknown.length)
        unrecognized.set(
          id,
          value.drop.unknown.map((item) => item.file.name),
        );
      void queries.invalidateQueries({
        queryKey: ["library", "intake-batches"],
      });
      navigate({ session: id });
    },
    onSettled: () => setSent(null),
  });
  const take = async (list: DroppedFile[]) => {
    if (submit.isPending) return;
    submit.reset();
    const sorted = await sortDrop(list.filter((item) => !hiddenInFolder(item)));
    setDrop(sorted);
    setFormat(sorted.exports[0]?.format ?? "");
    // PDFs alone need nothing more; an export's format is shown first.
    if (!dropProblem(sorted) && !sorted.exports.length && sorted.pdfs.length)
      submit.mutate({ drop: sorted, format: null });
  };
  const problem = drop ? dropProblem(drop) : null;
  const exported = drop?.exports.length === 1 ? drop.exports[0]! : null;
  return (
    <div className="intake-drop">
      <div
        className="intake-dropzone"
        data-over={over || undefined}
        aria-label="放置区"
        role="group"
        onDragOver={(event: DragEvent) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event: DragEvent) => {
          event.preventDefault();
          setOver(false);
          void droppedFiles(event.dataTransfer).then(take);
        }}
      >
        <p className="intake-dropzone-lead">
          把 PDF、文件夹或导出文件拖到这里，或
          <Button
            size="compact"
            isDisabled={submit.isPending}
            onPress={() => files.current?.click()}
          >
            选择文件
          </Button>
          <Button
            size="compact"
            isDisabled={submit.isPending}
            onPress={() => folder.current?.click()}
          >
            选择文件夹
          </Button>
        </p>
        <p className="ui-description">{SUPPORTED}</p>
        <input
          ref={files}
          className="intake-drop-input"
          type="file"
          multiple
          aria-label="选择文件"
          tabIndex={-1}
          onChange={(event) => {
            void take(pickedFiles(event.target.files));
            event.target.value = "";
          }}
        />
        <input
          ref={folder}
          className="intake-drop-input"
          type="file"
          multiple
          aria-label="选择文件夹"
          tabIndex={-1}
          onChange={(event) => {
            void take(pickedFiles(event.target.files));
            event.target.value = "";
          }}
        />
      </div>
      {exported ? (
        <div className="intake-drop-export">
          <span>
            导出文件 {exported.file.name}
            {drop!.pdfs.length
              ? ` · 一同放入 ${drop!.pdfs.length.toLocaleString()} 个 PDF，按导出里写的路径配对`
              : ""}
          </span>
          <Select
            label="格式"
            value={format}
            onChange={setFormat}
            options={[{ value: "", label: "请选择" }, ...IMPORT_FORMATS]}
            {...(format ? {} : { description: "没能识别格式，请选一个。" })}
          />
          <Button
            variant="primary"
            isPending={submit.isPending}
            disabledReason={
              problem ?? (format ? undefined : "请选择导出文件的格式")
            }
            onPress={() => submit.mutate({ drop: drop!, format })}
          >
            继续
          </Button>
        </div>
      ) : null}
      {sent ? (
        <p role="status">
          正在交文件 {sent.done.toLocaleString()} /{" "}
          {sent.total.toLocaleString()}…
        </p>
      ) : null}
      {problem ? <p role="alert">{problem}</p> : null}
      {drop?.unknown.length ? (
        <ul className="intake-drop-unknown" aria-label="没有识别的文件">
          {drop.unknown.map((item, index) => (
            <li key={`${item.path ?? item.file.name}:${index}`}>
              没有识别出这个文件的格式：{item.file.name}
            </li>
          ))}
          <li className="ui-description">{SUPPORTED}。</li>
        </ul>
      ) : null}
      {submit.isError ? (
        <ErrorNotice
          message={errorMessage(submit.error)}
          retained="文献库没有变化；重新放入即可再试。"
        />
      ) : null}
    </div>
  );
}
