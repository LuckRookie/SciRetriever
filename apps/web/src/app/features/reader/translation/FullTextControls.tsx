import { TRANSLATION_LANGUAGES } from "@sciretriever/contracts";
import {
  Button,
  Dialog,
  Icon,
  SegmentedControl,
} from "../../../components/index.js";
import type { ReaderFullText } from "./use-fulltext.js";
import type { ReaderTranslation } from "./use-translation.js";
import "./translation.css";

/** The PDF toolbar's 对照翻译 switch, its view choice and progress (ADR 0051). */
export function FullTextControls({
  fullText,
  translation,
}: {
  fullText: ReaderFullText;
  translation: ReaderTranslation;
}) {
  const { mode, progress, confirm } = fullText;
  const language =
    TRANSLATION_LANGUAGES.find((l) => l.code === translation.settings.language)
      ?.label ?? translation.settings.language;
  const pending = confirm?.pages.filter((p) => !p.saved).length ?? 0;
  const status = !progress
    ? null
    : progress.running
      ? `译文 ${progress.done} / ${progress.total} 页`
      : progress.failed.length
        ? `${progress.failed.length} 页未翻译`
        : `已译 ${progress.total} 页`;
  return (
    <div className="ft-controls" role="group" aria-label="全文翻译">
      {mode === "off" ? (
        <Button
          variant="text"
          icon={<Icon name="translate" />}
          onPress={() => void fullText.open()}
        >
          对照翻译
        </Button>
      ) : (
        <>
          <SegmentedControl
            label="译文显示"
            value={mode}
            onChange={(value) => fullText.setMode(value as "pair" | "only")}
            items={[
              { id: "pair", label: "对照" },
              { id: "only", label: "只看译文" },
            ]}
          />
          {status ? (
            <span className="ft-status" role="status" aria-live="polite">
              {status}
            </span>
          ) : null}
          {progress?.running ? (
            <Button variant="text" onPress={fullText.cancel}>
              停止
            </Button>
          ) : progress?.failed.length ? (
            <Button
              variant="text"
              onPress={() => fullText.retry(progress.failed)}
            >
              重试
            </Button>
          ) : null}
          <Button
            variant="text"
            icon={<Icon name="close" />}
            onPress={fullText.close}
          >
            关闭译文
          </Button>
        </>
      )}
      <Dialog
        title="翻译全文"
        isOpen={!!confirm}
        onOpenChange={(open) => {
          if (!open) fullText.dismissConfirm();
        }}
        footer={
          <>
            <Button onPress={fullText.dismissConfirm}>取消</Button>
            <Button variant="primary" onPress={fullText.start}>
              开始翻译
            </Button>
          </>
        }
      >
        <p>
          译成{language}：共 {confirm?.page_count ?? 0} 页，其中 {pending}{" "}
          页需要翻译，每页一次模型请求；
          {confirm && confirm.page_count - pending
            ? `另外 ${confirm.page_count - pending} 页已有译文或没有要翻译的文字。`
            : "目前没有已保存的译文。"}
        </p>
        <p className="ui-description">
          翻好的页会先显示；参考文献、作者、图、表和公式保留原文。译文保存在本机程序目录里，下次打开直接显示。
        </p>
      </Dialog>
    </div>
  );
}
