import "../processing/processing.css";
import { useState } from "react";
import { EmptyState, PageHeader, Tabs } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { useUrlState } from "../../data/url.js";
import { IntakeRecords } from "./IntakeRecords.js";
import { BatchPage } from "./Batch.js";
import { Discovery } from "./Discovery.js";
import { Dropzone } from "./Dropzone.js";
import { WebIntake, ZoteroIntake } from "./Extension.js";

/**
 * The intake page (page specs “入库”): four ways papers come in — 检索,
 * 文件, Zotero and 网页 — above every batch they formed. A batch opens on
 * this page, its id in the address.
 */
export default function Intake() {
  const api = useApi(),
    batch = useUrlState().parameters.get("session");
  const [tab, setTab] = useState("search"),
    [run, setRun] = useState<{ running: boolean; batch: string | null }>({
      running: false,
      batch: null,
    });
  if (api.kind !== "workspace")
    return (
      <EmptyState
        title="此入口不提供发现与入库"
        description="请从完整工作台启动发现或入库。"
      />
    );
  return (
    <section className="feature-page intake-page">
      <PageHeader title="入库" />
      {batch ? (
        <BatchPage id={batch} />
      ) : (
        <>
          <Tabs
            label="入库方式"
            value={tab}
            onChange={(value) => {
              // A discovery still waiting keeps its tab until it returns.
              if (!run.running) setTab(value);
            }}
            items={[
              { id: "search", label: "检索" },
              { id: "files", label: "文件" },
              { id: "zotero", label: "Zotero" },
              { id: "web", label: "网页" },
            ]}
          >
            {tab === "search" ? (
              <Discovery
                onRun={(running, made) =>
                  setRun((current) => ({
                    running,
                    batch: made ?? current.batch,
                  }))
                }
              />
            ) : tab === "files" ? (
              <Dropzone />
            ) : tab === "zotero" ? (
              <ZoteroIntake />
            ) : (
              <WebIntake />
            )}
          </Tabs>
          <IntakeRecords submitting={run.running} highlight={run.batch} />
        </>
      )}
    </section>
  );
}
