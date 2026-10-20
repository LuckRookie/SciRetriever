import { ContractValidationError } from "./index.js";

export const PUBLICATION_FORMS = [
  "journal-article",
  "conference-paper",
  "book-or-chapter",
  "thesis",
  "patent",
  "report-or-standard",
  "dataset",
] as const;
export type PublicationForm = (typeof PUBLICATION_FORMS)[number];
export const ARTICLE_KINDS = [
  "research-article",
  "review",
  "letter-or-communication",
  "perspective-or-commentary",
  "correction-or-editorial",
] as const;
export type ArticleKind = (typeof ARTICLE_KINDS)[number];
export const PUBLICATION_FORM_LABELS: Readonly<
  Record<PublicationForm, string>
> = Object.freeze({
  "journal-article": "期刊论文",
  "conference-paper": "会议论文",
  "book-or-chapter": "书籍或章节",
  thesis: "学位论文",
  patent: "专利",
  "report-or-standard": "技术报告或标准",
  dataset: "数据集",
});
export const ARTICLE_KIND_LABELS: Readonly<Record<ArticleKind, string>> =
  Object.freeze({
    "research-article": "研究论文",
    review: "综述",
    "letter-or-communication": "短文或通讯",
    "perspective-or-commentary": "观点或评论",
    "correction-or-editorial": "勘误或社论",
  });
export function parsePublicationForm(value: unknown): PublicationForm | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !PUBLICATION_FORMS.includes(value as PublicationForm)
  )
    throw new ContractValidationError(["publication_form"]);
  return value as PublicationForm;
}
export function parseArticleKind(value: unknown): ArticleKind | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !ARTICLE_KINDS.includes(value as ArticleKind)
  )
    throw new ContractValidationError(["article_kind"]);
  return value as ArticleKind;
}
